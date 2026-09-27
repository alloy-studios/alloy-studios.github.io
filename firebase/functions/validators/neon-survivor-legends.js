"use strict";
/**
 * Neon Survivor Legends — Alloy Accounts validator.
 *
 * The save is the game's whole `meta` object (src/20_meta.js), sent at
 * checkpoints between runs: the end of a run, an Armory purchase, a reset.
 * Never mid-run — see src/96_account.js — so the server time since the last
 * accepted save always covers the whole run that the next save pays for.
 *
 * WHAT IS ACTUALLY PROTECTED. Alloy is the currency, and it buys the eleven
 * Armory upgrades and six starting weapons. Those are the only fields a cheat
 * wants. They are checked together as net worth: alloy in hand plus the cost
 * of everything owned. Buying an upgrade moves alloy into an upgrade and
 * leaves net worth unchanged, so only run payouts can raise it, and those are
 * rate-limited below. The rest (bests, lifetime totals) is display-only: no
 * payout, unlock or leaderboard reads it back, so it only needs to be sane.
 *
 * RATES — derived from the game's code, not from feel.
 *
 * alloy (net worth), 10 / s, burst 50.
 *   computePayout() (20_meta.js) pays 95 * (raw/95)^0.52 * mult per run, where
 *   raw = kills*0.22 + floor(t/20)*4 + bosses*55 + level*3 and the curve floors
 *   raw at 1. The curve is concave, so income per second is highest for the
 *   SHORTEST run, not the best one:
 *     - Only death ends a run (Player.takeDamage -> gameOver; there is no quit).
 *     - Hull is >= 100 and every hit grants 0.55 s of invulnerability.
 *     - Before the first boss (75 s) the only damage is contact, <= 20 (brute,
 *       ENEMY_DEF) scaled by min(1, 0.5 + t/60): 9+ hits, so >= 4.4 s of hits,
 *       and the first enemy spawns at t = 1 s, >= 120 px away (even in a 1 px
 *       viewport). A run lasts at least ~5 s.
 *     - A 5 s run is level 1-2 with no kills worth a point: raw ~= 3, curve ~= 16.
 *     - mult = (1 + refine*0.13) * rookie <= 1.65 * 1.35 = 2.23 (in practice
 *       <= 1.65: the rookie bonus needs runs < 5, Refinery 5 costs 578 alloy).
 *   So <= 16 * 2.23 / 5 ~= 7 alloy / s even at the impossible maximum, and
 *   longer runs pay less per second (15 s ~= 4.4 / s, 60 s ~= 2.8 / s, a
 *   10-minute run ~= 1.4 / s). 10 / s leaves headroom over every honest case.
 *   Burst: the server floors saves at one per ~4.5 s and a deferred save can
 *   carry up to ~5 s of play the elapsed time does not count — 5 s * 10 = 50.
 *
 * runs, 1 / 5 s, burst 2.       One per death; a run lasts >= ~5 s (above).
 *   Kept from falling: payout's rookie bonus is higher for runs < 5.
 * totalBosses, 1 / 62 s, burst 1.
 *   Boss.die() sets nextBossTime = gameTime + 62 and the first boss is at 75 s,
 *   so a run of T seconds has at most T/62 bosses. gameTime never runs ahead of
 *   real time: loop() clamps a frame to 50 ms and hitstop only slows it.
 * totalKills / bestChain, 700 / s, burst 4000.
 *   Every kill is an Enemy.die(). The wave spawner keeps <= 170 alive and fires
 *   at most every 0.26 s (<= 654 / s); THE MOTHERBOARD adds <= ~15 / s and only
 *   while < 130 are alive. A boss death kills everything alive at once (<= 169).
 *   A chain counts kills, so it shares the rate. Burst: 5 s * 700 + 170.
 * bestTime, 1 / s, burst 10.    A run's time is gameTime (see totalBosses).
 * bestScore, 12000 / s, burst 70000.
 *   computeScore() = kills*10 + t*5 + bosses*500 + level*40 + chain*6; the kill
 *   and chain terms dominate: 700 * 16 + boss + level terms < 12000 / s.
 * bestLevel, 1 / s, burst 30.   Loose on purpose and display-only: every level
 *   costs more XP than the last (x1.085-1.14 per level, Player.addXp), so an
 *   honest run averages well under one level every ten seconds.
 *
 * A RESET (the Armory's "Reset all progress") zeroes everything on purpose.
 * The game counts resets, and a save whose count went up is measured from
 * zero instead of from the previous save. That cannot be abused: from zero,
 * the same rates allow LESS than from any real save.
 *
 * CLAMP, DON'T REJECT. Only a save that is not an object is rejected. Every
 * other bad value is clamped, so no honest path — offline play, guest play
 * before signing in, a very long session — can lock a player out.
 *
 * KEEP IN SYNC with src/20_meta.js: UPGRADES (max, base, grow), START_UNLOCKS
 * and the tutorial step ids in src/94_tutorial.js. If the game raised an
 * upgrade's max or lowered a cost without this file, honest purchases would be
 * clamped back.
 */
const { Reject, int, num, bool, str, arr, grow, gain } = require("./lib");

// src/20_meta.js UPGRADES — id: [max, base, grow]. Level l -> l+1 costs round(base * grow^l).
const UPGRADES = {
  hull: [6, 38, 1.55], power: [6, 46, 1.62], thrust: [4, 42, 1.58], magnet: [4, 34, 1.5],
  siphon: [5, 44, 1.6], chip: [4, 50, 1.65], capac: [3, 48, 1.7], mend: [3, 52, 1.68],
  boot: [3, 70, 1.9], phoenix: [2, 120, 2.2], refine: [5, 40, 1.55],
};
// src/20_meta.js START_UNLOCKS. The blaster is free and always owned.
const UNLOCKS = { orbital: 60, aura: 70, tesla: 85, mines: 85, missiles: 100, frost: 110 };
// src/94_tutorial.js STEPS ids.
const TUTORIAL = ["move", "auto", "collect", "pick", "dash", "hp", "fuse", "fusion", "ascend", "boss", "alloy"];

const RATE = {
  alloy: [10, 50], runs: [1 / 5, 2], bosses: [1 / 62, 1], kills: [700, 4000],
  time: [1, 10], score: [12000, 70000], level: [1, 30],
};
const BIG = 1e9;

const upgradeCost = (id, level) => {
  const [, base, g] = UPGRADES[id];
  let c = 0;
  for (let l = 0; l < level; l++) c += Math.round(base * Math.pow(g, l));
  return c;
};
const spent = (s) =>
  Object.keys(UPGRADES).reduce((t, id) => t + upgradeCost(id, s.up[id]), 0) +
  s.unlocked.reduce((t, w) => t + (UNLOCKS[w] || 0), 0);

/** Absolute bounds and types only — no history. Also the whole check for a first save. */
function shape(d) {
  const up = {};
  const src = d.up && typeof d.up === "object" ? d.up : {};
  for (const id of Object.keys(UPGRADES)) up[id] = int(src[id], 0, UPGRADES[id][0], 0);
  const unlocked = ["blaster", ...new Set(arr(d.unlocked, 16, (w) => str(w, 16)).filter((w) => w in UNLOCKS))];
  return {
    alloy: int(d.alloy, 0, BIG, 0),
    up,
    unlocked,
    start: unlocked.includes(d.start) ? d.start : "blaster",
    runs: int(d.runs, 0, BIG, 0),
    bestTime: num(d.bestTime, 0, 1e7, 0),
    bestLevel: int(d.bestLevel, 1, 100000, 1),
    totalKills: int(d.totalKills, 0, 1e12, 0),
    totalBosses: int(d.totalBosses, 0, BIG, 0),
    lifetimeAlloy: int(d.lifetimeAlloy, 0, 1e12, 0),
    bestScore: int(d.bestScore, 0, 1e12, 0),
    bestChain: int(d.bestChain, 0, BIG, 0),
    tutorialDone: bool(d.tutorialDone),
    tutorialSeen: [...new Set(arr(d.tutorialSeen, 32, (s) => str(s, 16)).filter((s) => TUTORIAL.includes(s)))],
    resets: int(d.resets, 0, BIG, 0),
  };
}

module.exports = {
  maxBytes: 4 * 1024,

  clean(prev, next, ctx) {
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Reject("save is not an object");
    ctx = ctx || {};
    const s = shape(next);
    if (!prev || typeof prev !== "object" || ctx.first) return s;

    // A missing elapsedSec would turn every ceiling into NaN; treat it as no time passed.
    const c = Object.assign({}, ctx, { elapsedSec: Number.isFinite(ctx.elapsedSec) ? ctx.elapsedSec : 0 });
    const p = shape(prev);
    const base = s.resets > p.resets ? shape({}) : p;   // a reset: measure from zero
    s.resets = Math.max(s.resets, p.resets);

    const rise = (k, [rate, burst]) => { s[k] = grow(base[k], s[k], rate, c, burst); };
    rise("runs", RATE.runs);
    rise("totalBosses", RATE.bosses);
    rise("totalKills", RATE.kills);
    rise("bestChain", RATE.kills);
    rise("bestTime", RATE.time);
    rise("bestScore", RATE.score);
    rise("bestLevel", RATE.level);
    rise("lifetimeAlloy", RATE.alloy);

    // Net worth may fall freely (a reset) and rise only at the payout rate.
    const worth = s.alloy + spent(s);
    const allowed = gain(base.alloy + spent(base), worth, RATE.alloy[0], c, RATE.alloy[1]);
    if (worth > allowed) {
      // More than any run could have paid. Purchases this save cannot have paid
      // for are undone first (the previous save's were already accepted), then
      // the alloy in hand is cut to what is left.
      if (spent(s) > allowed) {
        for (const id of Object.keys(UPGRADES)) s.up[id] = Math.min(s.up[id], base.up[id]);
        s.unlocked = s.unlocked.filter((w) => base.unlocked.includes(w));
        if (!s.unlocked.includes(s.start)) s.start = "blaster";
      }
      s.alloy = Math.max(0, Math.min(s.alloy, allowed - spent(s)));
    }
    return s;
  },

  // Only bosses have an honest physical ceiling (one per 62 s of play, above).
  // Kills and score are bounded by the enemy cap but at ~700 kills / s, which
  // is no use as an event limit; alloy has none worth trusting. Left out.
  events: {
    bosses: { perSecond: RATE.bosses[0], burst: RATE.bosses[1] },
  },
};
