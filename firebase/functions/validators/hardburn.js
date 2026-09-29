"use strict";
/**
 * HARDBURN - Alloy Accounts validator.
 * Game id: hardburn   (game file: hardburn.html)
 *
 * THE SAVE is the game's whole SV object, sent by save() -> pushCloud():
 *   cred, scrap           spendable balances
 *   owned {id: copies}    airframes; a duplicate pull adds a copy
 *   equip                 equipped airframe id
 *   rolls                 lifetime pulls (crate, ten-pack, scrap forge)
 *   pityEpic, pityLeg     pity counters
 *   best {"SEED|d": pts}  personal best per course (seed text | difficulty 0-3)
 *   runs, kills           lifetime runs finished / targets destroyed
 *   bestEver              best score on any course
 *   seen {id: 1}          airframes ever pulled (cosmetic flag)
 *
 * CLAMP, DON'T REJECT. Reject fires only on a save that is not an object. Every
 * other out-of-range or malformed value is clamped or dropped: a Reject that an
 * honest save can reach is a silent permanent lockout (see speed-simulator.js).
 *
 * ------------------------------------------------------------------ RATES
 * runs   runs++ happens only in finishRun(), which endRun() schedules with
 *        setTimeout(finishRun, 700). endRun() only acts from the 'fly' / 'armed'
 *        states and sets 'over' at once, and the next run can only be started
 *        from the results screen, which finishRun() itself opens. So finishRun()
 *        calls are >= 700 ms of real time apart; setTimeout does not read the
 *        game clock, so dilation and Event Horizon cannot shorten that.
 *        => 1 / 0.7 per second, burst 3 (clock slop, a save in flight).
 * kills  kills++ only in finishRun(), and only on a win: same bound, and never
 *        more than runs. No tighter floor is safe - the generated route can curl
 *        back so the target sits near the launch rail, making a win very short.
 *
 * NOT RATE-LIMITED, on purpose: cred, rolls, best, bestEver (and scrap beyond
 * the pull link below). Score has no physical per-second ceiling, and credits
 * and pulls inherit that:
 *   - a grapple release pays min(3400, arc * 980 * mult); mult reaches
 *     1 + 3.2 * 2.6 = 9.32, and Event Horizon multiplies all score x5. Hook and
 *     release can alternate every other FRAME, so points per second scale with
 *     the display's refresh rate. There is no number to write down.
 *   - finishRun() pays round(improve/100 * pay) + round(score/900 * pay) + 40 on
 *     a win, pay <= 2.6, and any word is a fresh course: credits track score.
 *   - pulls cost 100 / 90 credits (crate / ten-pack) or 600 scrap. They are
 *     bound by clicks and credits, not by a timer.
 * A guessed rate would either let cheaters through or clamp honest players on
 * high-refresh screens. All of it only reaches the forger's own collection:
 * events and leaderboards never read saves, and no declared metric uses it.
 *
 * ------------------------------------------------------------ INVARIANTS
 * Each mirrors what the game's own code guarantees, so an honest save always
 * satisfies it; on the first cloud save they are the only checks besides caps.
 *   - rollOnce() adds exactly one copy per pull (new 0 -> 1, duplicate n -> n+1)
 *     and pickRarity() adds exactly one to rolls; a new save starts at
 *     {trainer: 1}, rolls 0.   => sum(owned) <= 1 + rolls.
 *     Excess copies are removed rarest-first (the likely forgery); the starter
 *     frame always keeps one.
 *   - scrap only rises in rollOnce(), by SCRAP_VALUE[rarity] <= 2000, once per
 *     pull.   => scrap <= prev.scrap + 2000 * (new pulls). It may fall freely
 *     (the scrap forge spends 600).
 *   - pickRarity() resets pityEpic at 40 and pityLeg at 150. A forge pull returns
 *     before those checks, which can leave pityLeg at exactly 150.
 *     => pityEpic 0..39, pityLeg 0..150.
 *   - equip is always an owned airframe (the hangar only equips owned ones).
 *   - a PB never goes down, and bestEver is at least every PB.
 *   - runs, kills and rolls never go down.
 *
 * ------------------------------------------------------------------ SIZE
 * The game keeps its BEST_CAP = 2000 highest PBs. A seed is at most 12 UTF-16
 * units (the seed box's maxlength; the random and daily seeds are shorter). Worst
 * case per entry, with every unit a JSON \uXXXX escape: 72 + "|d" + quotes, colon,
 * 13 digits, comma = 91 bytes -> 182 KB, plus ~2 KB for everything else. Typical
 * ASCII seeds are ~28 bytes an entry. 256 KB always fits.
 */
const { Reject, int, grow, gain } = require("./lib");

// SKINS in hardburn.html: id -> rarity (0 common .. 5 mythic)
const RARITY = {
  trainer: 0, rebar: 0, surplus: 0, ashcan: 0, pipefitter: 0,
  hornet: 1, bluecoat: 1, dune: 1, mercury: 1, pitch: 1,
  halogen: 2, kingfisher: 2, reliquary: 2, static: 2, ironclad: 2,
  wraith: 3, hydra: 3, leech: 3,
  chronos: 4, magnetar: 4, solaris: 4,
  ouroboros: 5, seraph: 5,
};
const IDS = Object.keys(RARITY);
const STARTER = "trainer";

const RUNS_PER_S = 1 / 0.7, RUNS_BURST = 3;
const MAX_SCRAP_PER_PULL = 2000;             // SCRAP_VALUE = [15, 35, 90, 240, 700, 2000]
const BEST_CAP = 2000;                       // BEST_CAP in hardburn.html
const BIG = 1e12, COUNT = 1e9;
const KEY_RE = /^.{1,24}\|[0-3]$/;           // "SEED|difficulty"; the seed box is maxlength 12

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** PBs from both saves, best per course, highest BEST_CAP kept. A PB never goes
 *  down, and one missing from the new save (the game trimmed it) is kept, so a
 *  merge between devices never loses a course's record. */
function cleanBest(prevBest, nextBest) {
  const m = new Map();
  for (const src of [obj(prevBest), obj(nextBest)]) {
    for (const k of Object.keys(src)) {
      if (!KEY_RE.test(k)) continue;
      const v = int(src[k], 0, BIG, 0);
      if (!m.has(k) || v > m.get(k)) m.set(k, v);
    }
  }
  const out = {};
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, BEST_CAP)
    .forEach(([k, v]) => { out[k] = v; });
  return out;
}

module.exports = {
  maxBytes: 256 * 1024,                      // see SIZE above

  clean(prev, next, ctx) {
    ctx = ctx || {};
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Reject("not a save");
    const p = prev && typeof prev === "object" && !ctx.first ? prev : null;
    // A missing elapsedSec would turn a ceiling into NaN; treat it as no time passed.
    const t = Number.isFinite(ctx.elapsedSec) ? Math.max(0, ctx.elapsedSec) : 0;
    const rc = Object.assign({}, ctx, { elapsedSec: t });

    // --- pulls and the collection -------------------------------------------
    let rolls = int(next.rolls, 0, COUNT, 0);
    if (p) rolls = Math.max(rolls, int(p.rolls, 0, COUNT, 0));          // never goes down

    const ownedIn = obj(next.owned), owned = {};
    for (const id of IDS) {
      const n = int(ownedIn[id], 0, COUNT, 0);
      if (n > 0) owned[id] = n;
    }
    if (!owned[STARTER]) owned[STARTER] = 1;

    let excess = IDS.reduce((a, id) => a + (owned[id] || 0), 0) - (1 + rolls);
    if (excess > 0) {
      const rarestFirst = IDS.slice().sort((a, b) => RARITY[b] - RARITY[a]);
      for (const id of rarestFirst) {
        if (excess <= 0) break;
        if (!owned[id]) continue;
        const take = Math.min(owned[id] - (id === STARTER ? 1 : 0), excess);
        owned[id] -= take;
        excess -= take;
        if (owned[id] <= 0) delete owned[id];
      }
    }

    const equip = typeof next.equip === "string" && has(owned, next.equip) ? next.equip : STARTER;

    const seenIn = obj(next.seen), seen = {};
    for (const id of IDS) if (seenIn[id]) seen[id] = 1;

    const pityEpic = int(next.pityEpic, 0, 39, 0);
    const pityLeg = int(next.pityLeg, 0, 150, 0);

    // --- balances -----------------------------------------------------------
    const cred = int(next.cred, 0, BIG, 0);                              // see NOT RATE-LIMITED
    let scrap = int(next.scrap, 0, BIG, 0);
    if (p) {
      const newPulls = Math.max(0, rolls - int(p.rolls, 0, COUNT, 0));
      scrap = gain(int(p.scrap, 0, BIG, 0), scrap, 0, rc, MAX_SCRAP_PER_PULL * newPulls);
    }

    // --- runs ---------------------------------------------------------------
    const runs = grow(p ? int(p.runs, 0, COUNT, 0) : null, int(next.runs, 0, COUNT, 0),
                      RUNS_PER_S, rc, RUNS_BURST);
    let kills = grow(p ? int(p.kills, 0, COUNT, 0) : null, int(next.kills, 0, COUNT, 0),
                     RUNS_PER_S, rc, RUNS_BURST);
    kills = Math.min(kills, runs);

    // --- records ------------------------------------------------------------
    const best = cleanBest(p && p.best, next.best);
    let bestEver = int(next.bestEver, 0, BIG, 0);
    if (p) bestEver = Math.max(bestEver, int(p.bestEver, 0, BIG, 0));
    for (const k of Object.keys(best)) if (best[k] > bestEver) bestEver = best[k];

    return { cred, scrap, owned, equip, rolls, pityEpic, pityLeg, best, runs, kills, bestEver, seen };
  },

  // Metrics with a ceiling set by the game's own timers (working in RATES above).
  // Not declared: score, credits, gates, pulls - no physical per-second maximum.
  // runs is timer-bound too but left out on purpose: launching and aborting at
  // once counts as a run, so an event on it would reward ESC-spamming.
  events: {
    targets: { perSecond: RUNS_PER_S, burst: RUNS_BURST },
  },
};
