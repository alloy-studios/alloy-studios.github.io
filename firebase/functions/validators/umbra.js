"use strict";
/**
 * UMBRA - Alloy Accounts validator.
 * The game is index.html in alloy-studios/multiversefighters; its save code is
 * the SPECIAL FIGHTERS section (search "ACCOUNT SYNC").
 *
 * What UMBRA keeps between visits (localStorage "umbra.*", synced as one save):
 *   stats     { wins, best, ults, matches }
 *   cleared   [ path ids ]    paths the player has finished
 *   kept      [ fighter ids ] limited guests kept for good by clearing their
 *                             path while their event was on
 *   unlocked  [ fighter ids ] unlockable fighters earned by playing
 *
 * CLAMP, DON'T REJECT. Nothing here throws. Garbage becomes the default, a
 * number that is too big or arrived too fast is clamped, an id the game does
 * not have is dropped. A rejected save never replaces the stored one, so any
 * Reject an honest save could reach would lock the player out for good.
 *
 * Nothing the server has accepted is ever taken away: counts never go down and
 * the three lists are the union of the stored save and the new one.
 */
const { int, str, arr, grow } = require("./lib");

/*
 * RATES - derived from index.html, not from feel.
 *
 * wins: endMatch() adds 1 when the player wins a match against the CPU
 *   (versus CPU, or a fight on a path). A match is first to two rounds:
 *   startMatch() zeroes both fighters' round wins, and endMatch() runs only
 *   once one of them has 2. Every round opens with beginRoundCall(), which
 *   holds "ROUND n" for later(1.25) before FIGHT. Every KO waits later(2.1)
 *   and then later(1.4) before the next round or endMatch() - 3.5 s. A round
 *   that goes to time instead runs its 99 s timer. So a won match is at least
 *       2 rounds x (1.25 s + 3.5 s) = 9.5 s
 *   and the fight itself only adds to that. later() runs on game time, which
 *   advances by each frame's real delta times GAME.slow (never above 1), and
 *   frame() caps a frame at 50 ms, so game time never runs ahead of real time.
 *       => 1 win per 9.5 s, burst 1.
 *
 * ults: startUlt() adds 1 when the player's ultimate connects (any mode but
 *   training). Ultimate cutscenes cannot be skipped (only win screens and path
 *   scenes take a skip), nothing else can start until one ends, and every
 *   ultimate opens with the 0.62 s super flash. The shortest cutscene, measured
 *   in real time from the game's own shot lists and speed ramps, is Morrow's
 *   Hollow Grasp at 5.45 s (the rest run 5.9 to 14.8 s). So two ultimates are
 *   at least 5.45 + 0.62 = 6.07 s apart.
 *       => 1 ultimate per 6 s, burst 1.
 *
 * matches: part of the stats shape, but nothing counts it yet. Kept as a
 *   lifetime count at the win rate, since a match lasts at least as long as a
 *   won one.
 *
 * best: the hardest CPU difficulty beaten, -1 (none) to 3 (the game has four
 *   levels, AIL). It changes only on a win and can go straight to 3 with one,
 *   so it has no rate: it is clamped to that range, needs at least one win, and
 *   never goes down.
 *
 * cleared: a path is cleared when its fourth fight is won (pathAfter()), and
 *   each of those fights is a won match that also counts in wins. So an honest
 *   save always has cleared.length <= floor(wins / 4), and the wins rate bounds
 *   how fast paths can be cleared.
 *
 * kept: the game keeps a limited guest only when their path is cleared while
 *   their event is live (keepNow in pathAfter()). The server checks the same
 *   thing on its own clock, never the player's. The game draws an event's
 *   window from 00:00 on `from` to 00:00 on `to` in the player's local time,
 *   and local midnight falls somewhere between UTC-14h and UTC+12h. So the
 *   server accepts a new kept guest only while its own time is inside
 *       [ from 00:00 UTC - 14 h,  to 00:00 UTC + 12 h )
 *   the widest window any honest player on Earth can see, and nothing outside
 *   it. The guest must also be in cleared. Once stored, a kept guest stays.
 *
 * unlocked: an unlockable fighter is earned by wins, ultimates, a difficulty
 *   beaten or a cleared path, and checkUnlocks() adds it the moment its need is
 *   met. The server re-checks the need against this save's own cleaned stats.
 *   There are no unlockable fighters yet, so UNLOCK is empty and every id is
 *   dropped. That costs nothing: the game still shows a fighter unlocked while
 *   its need is met. When the game adds one, add its need here.
 *
 * EVENTS: wins and ultimates have the honest ceilings above, but the game does
 *   not report either to Alloy events yet, so none are declared.
 */
const RATES = { wins: 1 / 9.5, ults: 1 / 6 };

// absolute caps: at one win per 9.5 s, ten million is three years without a break
const MAX_COUNT = 10000000;
const BEST_MAX = 3;

// the game's SPECIAL table: every limited guest and their event window (local dates)
const LIMITED = {
  gojo: { from: "2026-09-26", to: "2026-10-27" },
  goku: { from: "2026-09-28", to: "2026-11-09" },
};
// the game's PATHS table
const PATHS = ["gojo", "goku"];
// the game's unlockable fighters: id -> { type: "wins" | "ults" | "diff" | "path", n, id }
const UNLOCK = {};

const HOUR = 3600 * 1000;
const EARLIEST_MIDNIGHT = 14 * HOUR;   // UTC+14 reaches local midnight 14 h before UTC does
const LATEST_MIDNIGHT = 12 * HOUR;     // UTC-12 reaches it 12 h after
const utcMidnight = (day) => Date.parse(day + "T00:00:00Z");

/**
 * Was the event on at any moment in [since, now]? A guest can only have been
 * kept at some point after the last save the server accepted, so that whole
 * stretch counts, not just this instant. Otherwise a path cleared while
 * offline (or as a guest) and synced after the event ends would take the
 * fighter away from an honest player. (Site-side change to the repo's version.)
 */
function eventOn(id, since, now) {
  const w = LIMITED[id];
  return !!w && now >= utcMidnight(w.from) - EARLIEST_MIDNIGHT && since < utcMidnight(w.to) + LATEST_MIDNIGHT;
}

/** Known ids only, each once, in the order given. */
function ids(v, known) {
  return [...new Set(arr(v, 64, (x) => str(x, 32)).filter((x) => known.includes(x)))];
}

/** Mirrors needMet() in the game. */
function needMet(n, s, cleared) {
  if (!n) return false;
  if (n.type === "wins") return s.wins >= n.n;
  if (n.type === "ults") return s.ults >= n.n;
  if (n.type === "diff") return s.best >= n.n;
  if (n.type === "path") return cleared.includes(n.id);
  return false;
}

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

module.exports = {
  // four numbers and a few short ids: an honest save is well under 1 KB
  maxBytes: 4 * 1024,

  clean(prev, next, ctx) {
    ctx = ctx || {};
    const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
    const p = prev ? obj(prev) : null;
    const n = obj(next);
    const ps = obj(p && p.stats);
    const ns = obj(n.stats);
    const before = (k) => (p ? int(ps[k], 0, MAX_COUNT, 0) : null);
    // a missing elapsedSec would make grow() write NaN; treat it as no time passed
    const c = Object.assign({}, ctx, { elapsedSec: Number.isFinite(ctx.elapsedSec) ? ctx.elapsedSec : 0 });

    const wins = grow(before("wins"), int(ns.wins, 0, MAX_COUNT, 0), RATES.wins, c, 1);
    const ults = grow(before("ults"), int(ns.ults, 0, MAX_COUNT, 0), RATES.ults, c, 1);
    const matches = grow(before("matches"), int(ns.matches, 0, MAX_COUNT, 0), RATES.wins, c, 1);
    let best = Math.max(p ? int(ps.best, -1, BEST_MAX, -1) : -1, int(ns.best, -1, BEST_MAX, -1));
    if (wins === 0) best = -1;
    const stats = { wins, best, ults, matches };

    // cleared: everything stored stays; new paths only while wins can pay for them
    const cleared = p ? ids(p.cleared, PATHS) : [];
    const room = Math.floor(wins / 4);
    for (const id of ids(n.cleared, PATHS)) {
      if (cleared.length >= room) break;
      if (!cleared.includes(id)) cleared.push(id);
    }

    // kept: everything stored stays; a new one needs its path cleared and the event
    // to have been on since the last accepted save, by the server's clock. A first
    // save covers play from before the account existed, so it reaches back to the start.
    const since = (!p || ctx.first) ? -Infinity : now - c.elapsedSec * 1000;
    const kept = p ? ids(p.kept, Object.keys(LIMITED)) : [];
    for (const id of ids(n.kept, Object.keys(LIMITED))) {
      if (!kept.includes(id) && cleared.includes(id) && eventOn(id, since, now)) kept.push(id);
    }

    // unlocked: everything stored stays; a new one needs its condition met by this save
    const unlocked = p ? ids(p.unlocked, Object.keys(UNLOCK)) : [];
    for (const id of ids(n.unlocked, Object.keys(UNLOCK))) {
      if (!unlocked.includes(id) && needMet(UNLOCK[id], stats, cleared)) unlocked.push(id);
    }

    return { stats, cleared, kept, unlocked };
  },

  events: {},
};
