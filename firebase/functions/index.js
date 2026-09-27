/**
 * ALLOY ACCOUNTS — server
 *
 * One account for every Alloy Studios game. The browser never reads or writes
 * the database directly (firestore.rules denies all of it). Everything goes
 * through these functions, and they decide what is plausible.
 *
 * What this protects: nobody can store progress, scores or rewards the server
 * did not accept, and event windows run on the server's clock.
 * What it cannot do: stop someone reading game code in DevTools. The per-game
 * validators bound how much reading it is worth.
 *
 * Deployed as its own codebase ("alloy") so deploying it never touches Speed
 * Simulator's getGame / saveProgress functions in the same project, and
 * deploying those never touches these.
 */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { validatorFor, Reject } = require("./validators");

admin.initializeApp();
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

const REGION = "us-central1";
// maxInstances caps how far a bug or an attack can scale the bill.
const CALL = { region: REGION, enforceAppCheck: true, maxInstances: 10, memory: "256MiB" };

// Events live in the website repo so they can be shown to guests for free and
// added with a git push. The server reads the same file, so what players see
// is exactly what the server enforces.
const EVENTS_URL = "https://alloy-studios.github.io/data/events.json";

const MIN_SAVE_GAP_MS = 4000;
const MIN_PROGRESS_GAP_MS = 3000;
const SHARDS = 10;          // community totals are split so writes never queue on one doc
const TOP_N = 50;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
// Speed Simulator's pre-Alloy saves live in users/{uid}. While its old build is
// live those docs keep changing, so they are mirrored into Alloy every session.
// Set LEGACY_FROZEN = true once the Alloy build of Speed Simulator is live: the
// legacy docs can no longer change, so each player is mirrored one last time and
// then skipped. Never remove the mirroring itself — a player who has not visited
// since the switch still needs their old save carried across.
const LEGACY_FROZEN = true;   // Speed Simulator moved to Alloy on 2026-09-27

// One-off gifts: reward ids granted to a specific player on their next session,
// keyed by the SHA-256 of their trimmed, lower-cased sign-in email so no address
// sits in this public repo. Idempotent — granted once, never duplicated.
const GIFTS = {
  // Speed Simulator's gift account — the SHINOBI chassis (decided by Fatih).
  "1dd9c872d0a9e2fda0e754a8e53d73ef91e8cc975b63d3478838c788d02d4820": { "speed-simulator": ["shinobi"] },
};
const RESERVED = ["admin", "alloy", "moderator", "staff", "official", "support", "system"];

// ---------------------------------------------------------------- helpers ---

function uidOf(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  return uid;
}

function gameIdOf(id) {
  if (typeof id !== "string" || !/^[a-z0-9-]{2,40}$/.test(id)) {
    throw new HttpsError("invalid-argument", "Unknown game.");
  }
  return id;
}

const playerRef = (uid) => db.collection("players").doc(uid);

function emailHash(email) {
  if (typeof email !== "string" || !email) return "";
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}
const ms = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : 0);

// ----------------------------------------------------------------- events ---

let eventsCache = { at: 0, list: [] };

async function loadEvents() {
  if (Date.now() - eventsCache.at < 5 * 60 * 1000) return eventsCache.list;
  try {
    const res = await fetch(EVENTS_URL, { headers: { "Cache-Control": "no-cache" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    const list = (Array.isArray(json.events) ? json.events : []).map(normaliseEvent).filter(Boolean);
    eventsCache = { at: Date.now(), list };
  } catch (e) {
    // Keep serving the last good copy; try again in about a minute.
    console.warn("events fetch failed:", e.message);
    eventsCache.at = Date.now() - 4 * 60 * 1000;
  }
  return eventsCache.list;
}

function normaliseEvent(e) {
  if (!e || typeof e.id !== "string" || !/^[a-z0-9-]{3,60}$/.test(e.id)) return null;
  if (!["personal", "community", "leaderboard"].includes(e.type)) return null;
  const start = Date.parse(e.startsAt);
  const end = Date.parse(e.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const tiers = (Array.isArray(e.tiers) ? e.tiers : [])
    .filter((t) => t && Number.isFinite(Number(t.at)) && t.reward && typeof t.reward.id === "string")
    .map((t) => ({
      at: Number(t.at),
      reward: { id: String(t.reward.id).slice(0, 60), label: String(t.reward.label || t.reward.id).slice(0, 80) },
    }));
  return {
    id: e.id,
    gameId: String(e.gameId || ""),
    type: e.type,
    metric: String(e.metric || ""),
    start,
    end,
    claimUntil: end + (Number(e.claimDays) || 7) * 864e5,
    tiers,
  };
}

function phase(ev, now) {
  if (now < ev.start) return "upcoming";
  if (now < ev.end) return "live";
  if (now < ev.claimUntil) return "claiming";
  return "closed";
}

async function findEvent(id) {
  const ev = (await loadEvents()).find((e) => e.id === id);
  if (!ev) throw new HttpsError("not-found", "No such event.");
  return ev;
}

// ---------------------------------------------------------------- session ---

/**
 * Called once per page load for a signed-in player. Creates their profile on
 * first visit, keeps their Speed Simulator save mirrored into Alloy while that
 * game is mid-migration, and stamps sessionStart — the earliest moment any
 * score this session can have started.
 */
exports.alloySession = onCall(CALL, async (req) => {
  const uid = uidOf(req);
  const ref = playerRef(uid);
  const now = Date.now();
  const snap = await ref.get();
  const p = snap.exists ? snap.data() : {};

  const update = { lastSeen: Timestamp.fromMillis(now), sessionStart: Timestamp.fromMillis(now) };
  if (!snap.exists) update.createdAt = Timestamp.fromMillis(now);

  // Keep the Alloy copy of an old Speed Simulator save in step with the legacy
  // doc (not a one-time snapshot), until the game saves through Alloy itself.
  if (!p.speedSimDone) {
    const saveRef = ref.collection("saves").doc("speed-simulator");
    const [legacy, cur] = await Promise.all([db.collection("users").doc(uid).get(), saveRef.get()]);
    const curD = cur.exists ? cur.data() : null;
    const alloyOwned = curD && !curD.migratedFrom;   // written by alloySave: the game has moved
    if (legacy.exists && !alloyOwned) {
      const legacyAt = legacy.data().updatedAt || Timestamp.fromMillis(now);
      if (!curD || ms(legacyAt) > ms(curD.updatedAt)) {
        const data = { ...legacy.data() };
        delete data.updatedAt;
        // Already validated by the old saveProgress function when it was written.
        await saveRef.set({ data, rev: ((curD && curD.rev) || 0) + 1, verified: true, updatedAt: legacyAt, migratedFrom: "users" });
      }
    }
    if (LEGACY_FROZEN || alloyOwned) update.speedSimDone = true;
  }

  const gift = GIFTS[emailHash(req.auth.token && req.auth.token.email)];
  if (gift) {
    for (const [gameId, ids] of Object.entries(gift)) {
      const have = ((p.rewards || {})[gameId]) || [];
      const missing = ids.filter((id) => !have.includes(id));
      if (missing.length) {
        update.rewards = update.rewards || {};
        update.rewards[gameId] = FieldValue.arrayUnion(...missing);
      }
    }
  }

  await ref.set(update, { merge: true });
  return { uid, name: p.name || null, serverTime: now };
});

/** Public player name: 3-16 letters, digits or _, unique, never a real name. */
exports.alloySetName = onCall(CALL, async (req) => {
  const uid = uidOf(req);
  const name = String((req.data || {}).name || "").trim();
  if (!NAME_RE.test(name)) {
    throw new HttpsError("invalid-argument", "Names are 3-16 letters, numbers or _.");
  }
  const key = name.toLowerCase();
  if (RESERVED.some((r) => key.includes(r))) {
    throw new HttpsError("invalid-argument", "That name is reserved.");
  }

  await db.runTransaction(async (tx) => {
    const nameRef = db.collection("names").doc(key);
    const [taken, me] = await Promise.all([tx.get(nameRef), tx.get(playerRef(uid))]);
    if (taken.exists && taken.data().uid !== uid) {
      throw new HttpsError("already-exists", "That name is taken.");
    }
    const old = me.exists && me.data().name;
    if (old && old.toLowerCase() !== key) tx.delete(db.collection("names").doc(old.toLowerCase()));
    tx.set(nameRef, { uid });
    tx.set(playerRef(uid), { name }, { merge: true });
  });
  return { name };
});

// ------------------------------------------------------------------ saves ---

exports.alloyLoad = onCall(CALL, async (req) => {
  const uid = uidOf(req);
  const gameId = gameIdOf((req.data || {}).gameId);
  const [s, p] = await Promise.all([
    playerRef(uid).collection("saves").doc(gameId).get(),
    playerRef(uid).get(),
  ]);
  const rewards = ((p.exists && p.data().rewards) || {})[gameId] || [];
  if (!s.exists) return { data: null, rewards };
  const d = s.data();
  return { data: d.data, rev: d.rev || 0, verified: !!d.verified, rewards };
});

/**
 * The only way anything reaches a player's save. The game proposes; its
 * validator decides; the cleaned result is stored and sent back so the game
 * can adopt any correction.
 */
exports.alloySave = onCall(CALL, async (req) => {
  const uid = uidOf(req);
  const gameId = gameIdOf((req.data || {}).gameId);
  const data = (req.data || {}).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpsError("invalid-argument", "A save must be an object.");
  }
  const v = validatorFor(gameId);
  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (bytes > v.maxBytes) throw new HttpsError("invalid-argument", `Save too large (${bytes} bytes).`);

  const ref = playerRef(uid).collection("saves").doc(gameId);
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const [s, p] = await Promise.all([tx.get(ref), tx.get(playerRef(uid))]);
    const prev = s.exists ? s.data() : null;
    const last = prev ? ms(prev.updatedAt) : 0;
    if (prev && !prev.migratedFrom && now - last < MIN_SAVE_GAP_MS) {
      throw new HttpsError("resource-exhausted", "Saving too often.");
    }
    // A save copied in from a legacy system was never part of a chain of saves
    // this server witnessed, and may be months stale. Comparing against it would
    // clamp an honest player back to it — or, with a hard jump check, reject
    // every save they ever make, since a rejected save never replaces it. So the
    // game's first native save is treated as a first save: absolute caps only.
    const witnessed = prev && !prev.migratedFrom ? prev : null;
    const ctx = {
      now,
      first: !witnessed,
      elapsedSec: witnessed ? (now - last) / 1000 : 0,
      rewards: ((p.exists && p.data().rewards) || {})[gameId] || [],
    };

    let clean;
    try {
      clean = v.clean(witnessed ? witnessed.data : null, data, ctx);
    } catch (e) {
      if (e instanceof Reject) throw new HttpsError("invalid-argument", e.message);
      throw e;
    }

    const rev = ((prev && prev.rev) || 0) + 1;
    tx.set(ref, { data: clean, rev, verified: !v.generic, updatedAt: Timestamp.fromMillis(now) });
    return { ok: true, data: clean, rev };
  });
});

// ----------------------------------------------------------------- events ---

/** Live state for events: community totals, leaderboard tops, my progress. */
exports.alloyEvents = onCall(CALL, async (req) => {
  const uid = uidOf(req);
  const now = Date.now();
  const gameId = (req.data || {}).gameId;
  const list = (await loadEvents()).filter((e) => {
    const ph = phase(e, now);
    return (ph === "live" || ph === "claiming") && (!gameId || e.gameId === gameId);
  });

  const out = await Promise.all(list.map(async (ev) => {
    const [state, mine] = await Promise.all([
      ev.type === "personal" ? null : db.collection("eventstate").doc(ev.id).get(),
      playerRef(uid).collection("events").doc(ev.id).get(),
    ]);
    const st = state && state.exists ? state.data() : {};
    const my = mine.exists ? mine.data() : {};
    return {
      id: ev.id,
      phase: phase(ev, now),
      total: st.total || 0,
      top: (st.top || []).slice(0, 10).map((r) => ({ name: r.name, score: r.score })),
      progress: my.progress || 0,
      best: my.best || 0,
      claimed: my.claimed || [],
    };
  }));
  return { serverTime: now, events: out };
});

/**
 * Event progress. For personal and community events `amount` is an increment;
 * for leaderboards it is a run's score. Either way it is checked against the
 * game's physical rate for that metric over real server time since this
 * player's last submission (or since their session began).
 */
exports.alloyProgress = onCall(CALL, async (req) => {
  const uid = uidOf(req);
  const amount = Number((req.data || {}).amount);
  const ev = await findEvent((req.data || {}).eventId);
  const now = Date.now();

  if (phase(ev, now) !== "live") throw new HttpsError("failed-precondition", "That event is not running.");
  const rule = (validatorFor(ev.gameId).events || {})[ev.metric];
  if (!rule) throw new HttpsError("failed-precondition", "This event has no verified metric yet.");
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpsError("invalid-argument", "Bad amount.");

  const mineRef = playerRef(uid).collection("events").doc(ev.id);
  const stateRef = db.collection("eventstate").doc(ev.id);

  const result = await db.runTransaction(async (tx) => {
    const reads = [tx.get(mineRef), tx.get(playerRef(uid))];
    if (ev.type === "leaderboard") reads.push(tx.get(stateRef));
    const [m, p, st] = await Promise.all(reads);
    const mine = m.exists ? m.data() : {};
    const pd = p.exists ? p.data() : {};

    const lastAt = ms(mine.lastAt);
    if (now - lastAt < MIN_PROGRESS_GAP_MS) throw new HttpsError("resource-exhausted", "Too fast.");
    const since = Math.max(lastAt, pd.sessionStart ? ms(pd.sessionStart) : now, ev.start);
    const cap = (rule.perSecond * Math.max(0, now - since)) / 1000 + (rule.burst || 0);

    if (ev.type === "leaderboard") {
      if (!pd.name) throw new HttpsError("failed-precondition", "Choose a player name to enter leaderboards.");
      if (amount > cap) throw new HttpsError("invalid-argument", "Score rejected as implausible.");
      const score = Math.floor(amount);
      const best = Math.max(mine.best || 0, score);
      tx.set(mineRef, { best, lastAt: Timestamp.fromMillis(now) }, { merge: true });

      // Only touch the shared board when this actually changes it.
      const top = (st && st.exists && st.data().top) || [];
      const mineOnBoard = top.find((r) => r.uid === uid);
      const qualifies = top.length < TOP_N || best > top[top.length - 1].score;
      if (qualifies && (!mineOnBoard || best > mineOnBoard.score)) {
        const next = top.filter((r) => r.uid !== uid);
        next.push({ uid, name: pd.name, score: best });
        next.sort((a, b) => b.score - a.score);
        tx.set(stateRef, { top: next.slice(0, TOP_N) }, { merge: true });
      }
      return { best };
    }

    // Clamp rather than reject: an autoclicker earns the human maximum, not zero,
    // and an honest player whose rate was mis-tuned loses a sliver, not a session.
    const accepted = Math.min(amount, cap);
    const progress = (mine.progress || 0) + accepted;
    tx.set(mineRef, { progress, lastAt: Timestamp.fromMillis(now) }, { merge: true });
    return { progress, accepted };
  });

  if (ev.type === "community" && result.accepted > 0) {
    const shard = String(Math.floor(Math.random() * SHARDS));
    await db.collection("eventstate").doc(ev.id).collection("shards").doc(shard)
      .set({ n: FieldValue.increment(result.accepted) }, { merge: true });
  }
  return result;
});

/** Claim a reward tier. The server records it; games honour it via alloyLoad. */
exports.alloyClaim = onCall(CALL, async (req) => {
  const uid = uidOf(req);
  const ev = await findEvent((req.data || {}).eventId);
  const i = Number((req.data || {}).tier);
  const now = Date.now();
  const ph = phase(ev, now);
  if (ph !== "live" && ph !== "claiming") throw new HttpsError("failed-precondition", "Rewards for this event have closed.");
  const tier = Number.isInteger(i) ? ev.tiers[i] : null;
  if (!tier) throw new HttpsError("invalid-argument", "No such reward.");

  const mineRef = playerRef(uid).collection("events").doc(ev.id);
  return db.runTransaction(async (tx) => {
    const reads = [tx.get(mineRef)];
    if (ev.type === "community") reads.push(tx.get(db.collection("eventstate").doc(ev.id)));
    const [m, st] = await Promise.all(reads);
    const mine = m.exists ? m.data() : {};
    if ((mine.claimed || []).includes(i)) return { reward: tier.reward, already: true };

    const value = ev.type === "personal" ? (mine.progress || 0)
      : ev.type === "leaderboard" ? (mine.best || 0)
      : ((st && st.exists && st.data().total) || 0);
    if (ev.type === "community" && !(mine.progress > 0)) {
      throw new HttpsError("failed-precondition", "Contribute to the event to claim its rewards.");
    }
    if (value < tier.at) throw new HttpsError("failed-precondition", "Not unlocked yet.");

    tx.set(mineRef, { claimed: FieldValue.arrayUnion(i) }, { merge: true });
    tx.set(playerRef(uid), { rewards: { [ev.gameId]: FieldValue.arrayUnion(tier.reward.id) } }, { merge: true });
    return { reward: tier.reward };
  });
});

/**
 * Sums community-event shards into one total every 10 minutes, so showing a
 * total costs one read instead of ten. Does nothing (and reads nothing) while
 * no community event is running.
 */
exports.alloyRollup = onSchedule({ schedule: "every 10 minutes", region: REGION, maxInstances: 1 }, async () => {
  const now = Date.now();
  const live = (await loadEvents()).filter((e) => e.type === "community" && now >= e.start && now < e.end + 30 * 60 * 1000);
  for (const ev of live) {
    const shards = await db.collection("eventstate").doc(ev.id).collection("shards").get();
    let total = 0;
    shards.forEach((d) => { total += d.data().n || 0; });
    await db.collection("eventstate").doc(ev.id).set({ total, updatedAt: Timestamp.fromMillis(now) }, { merge: true });
  }
});
