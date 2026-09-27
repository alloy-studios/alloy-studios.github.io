"use strict";
/**
 * Redwater - Alloy Accounts validator.   (game: redwater.html)
 *
 * Every rate below is derived from the game's own constants, with the working
 * shown, so an honest save can never be clamped:
 *
 *   BOARD WORK is the fastest way to earn anything, so it sets the ceilings.
 *     makeBountyOffer():  pay  = (90 + r*140) * (1 + lvl*0.22) * (outlaw ? 1.25 : 1)
 *                         => at most 287.5 * (1 + 0.22 L)
 *                         enemies n = 2 + floor(r*4) + floor(lvl*0.4) => at most 5 + 0.4 L
 *                         the law board's boss carries loot = pay >> 1
 *     kill loot:          makeEnt loot <= rndi(16,44) = 43 (posse), SCAVENGER perk x1.5 => 66
 *     job XP:             80 + n*26, plus 26 per kill (160 for a boss)
 *     timing:             three offers can be taken at once and can share a place. The
 *                         nearest place to any board is Boot Hill, 864 units from the town
 *                         board; inside the 200-unit arrival radius that is >= 1328 units
 *                         there and back at the horse's 340 u/s sprint => >= 3.9 s per cycle
 *                         of at most three jobs.
 *     money / s  <= 3 * (1.5*287.5*(1+0.22L) + (5+0.4L)*66) / 3.9  (+ duels, below)
 *                 = 658 (L=1), 4317 (L=40), 9822 (L=99)   ->  700 * (1 + 0.22 L) covers all
 *     XP / s     <= 3 * (80 + 2*26*(5+0.4L) + 134) / 3.9 + 40
 *                 = 420 (L=1), 1044 (L=40)                ->  420 + 17 L covers all
 *
 *   DUELS (startDuel / updateDuel): the stare holds rnd(1.8, 3.6) s, a winning shot
 *     needs the sweep (2.6/s) past 0.31 = 0.12 s, and the result holds 2.2 s
 *     => >= 4.12 s a duel, $40 stake, pays 240 + 40 L.
 *     => (200 + 40 L) / 4.12 per second: 58 (L=1), 437 (L=40). Well inside the above.
 *
 * NEW GAME is an honest path that resets every field to its starting value, so
 * nothing here is grow(). Level and lifetime kills use gain(): free to fall,
 * rate-limited to rise. (A grow() level would make New Game impossible to save,
 * and would push a Frankenstein level-30 into a fresh ride through the reply.)
 *
 * CLAMP, DON'T REJECT. Reject only fires on data no build of the game can
 * produce - a save that is not an object, or money/level/xp that is not a
 * finite non-negative number. Everything merely too big is clamped. A reachable
 * Reject would be a silent permanent lockout (see speed-simulator.js).
 *
 * Gun ownership is NOT tied to quest state. The legendaries only come from
 * story jobs, but a save that forged the gun could forge "done" just as easily,
 * so the check would only add a way to lock an honest player out.
 */
const { Reject, int, num, bool, str, oneOf, arr, gain } = require("./lib");

const LVL_MAX = 99;            // lvlNeed(60) is ~3e8 XP; no honest ride gets near 99
const WORLD_W = 6400, WORLD_H = 6600, MAP_H = 4800;

// redwater.html GUNS: id -> cylinder size (mags are clamped to it)
const GUN_MAG = {
  rusted: 6, navy: 6, peace: 6, coach: 2, trapper: 5,
  cattle: 6, dblbarrel: 2, lever: 12, varmint: 8,
  rattler: 6, sawtooth: 4, whisper: 5, roadagent: 8, thunder: 3, vaquero: 15, longrider: 7,
  deadmans: 8, judgment: 5, widow: 6, ironhorse: 60,
};
const LEGENDARY = ["deadmans", "judgment", "widow", "ironhorse"];
const PERKS = ["grit", "quick", "eye", "slinger", "light", "scav", "iron", "sharp", "nerve", "bandit"];
const STORY_Q = ["arrival", "crate", "twooffers", "badge", "deadoralive", "thestage", "raid",
                 "black", "bankjob", "rustle", "hangsheriff", "ledger", "widowhunt", "minetrouble"];
const Q_STATES = ["locked", "avail", "active", "done"];
const ITEMS = ["whiskey", "bandage", "dynamite", "tonic"];
const AMMO = ["pistol", "shell", "rifle"];

const moneyPerSec = (L) => 700 * (1 + 0.22 * L);
const xpPerSec = (L) => 420 + 17 * L;
// Kills are bounded by the enemies board work can put in front of you:
// 3 jobs x (5 + 0.4 L) enemies per 3.9 s, plus awakenings that finish 8 at once.
const killsPerSec = (L) => 5 + 0.32 * L;
// Ammo and items only come from the shop (money) or small quest/gun grants.
// Pistol ammo is the cheapest round at 24 for $22; the cheapest item is a $12 bandage.
const ammoPerSec = (L) => 1.1 * moneyPerSec(L);
const itemsPerSec = (L) => moneyPerSec(L) / 12;

// redwater.html lvlNeed()
const lvlNeed = (l) => Math.round(120 * Math.pow(1.28, l - 1));

/** The highest level `xpBudget` can buy starting from `from`. */
function maxLevelFrom(from, xpBudget) {
  let L = from, b = xpBudget;
  while (L < LVL_MAX) { const need = lvlNeed(L); if (b < need) break; b -= need; L++; }
  return L;
}

/** A core number: finite and non-negative, or the save is garbage. */
function core(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Reject("bad " + name);
  return n;
}

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const uniq = (list) => [...new Set(list)];

module.exports = {
  maxBytes: 8 * 1024,          // a full save is ~1.6 KB (board jobs are no longer saved)

  clean(prev, next, ctx) {
    ctx = ctx || {};
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Reject("not a save");
    const p = prev && typeof prev === "object" ? prev : null;
    const rated = !!p && !ctx.first;
    const t = Number.isFinite(ctx.elapsedSec) ? Math.max(0, ctx.elapsedSec) : 0;
    const rc = Object.assign({}, ctx, { elapsedSec: t });

    // --- level: may fall (New Game), may only rise as fast as XP can buy it ---
    let lvl = Math.max(1, Math.min(LVL_MAX, Math.floor(core(next.lvl, "lvl"))));
    if (rated) {
      const pl = int(p.lvl, 1, LVL_MAX, 1);
      if (lvl > pl) {
        const budget = int(p.xp, 0, 1e12, 0) + xpPerSec(lvl) * t + 2000;
        lvl = Math.min(lvl, maxLevelFrom(pl, budget));
      }
    }
    const xp = Math.min(Math.floor(core(next.xp, "xp")), lvlNeed(lvl) + 10000);

    // --- perks and skill points: one point per level past 1, one point per perk ---
    const perkIn = obj(next.perks);
    const owned = PERKS.filter((k) => perkIn[k] === true).slice(0, Math.max(0, lvl - 1));
    const perks = {};
    for (const k of owned) perks[k] = true;
    const sp = int(next.sp, 0, Math.max(0, lvl - 1 - owned.length), 0);

    // --- vitality: 140 at level 1, +6 a level, +25 for GRIT ---
    const maxhp = int(next.maxhp, 1, 140 + 6 * (lvl - 1) + (perks.grit ? 25 : 0), 140);
    const hp = num(next.hp, 1, maxhp, maxhp);

    // --- money: spendable, rises no faster than board work can pay ---
    let money = Math.floor(core(next.money, "money"));
    money = Math.min(money, 1e12);
    if (rated) money = gain(int(p.money, 0, 1e12, 0), money, moneyPerSec(lvl), rc, 25000);

    // --- lifetime kills: falls only on New Game ---
    let kills = int(next.kills, 0, 1e9, 0);
    if (rated) kills = gain(int(p.kills, 0, 1e9, 0), kills, killsPerSec(lvl), rc, 60);

    // --- arms ---
    // Drop unknown ids BEFORE capping at five, or one bad entry costs a real gun.
    let guns = uniq(arr(next.guns, 32, (s) => str(s, 16)).filter((g) => GUN_MAG[g] != null)).slice(0, 5);
    if (!guns.length) guns = ["rusted"];
    const gi = int(next.gi, 0, guns.length - 1, 0);
    const magIn = obj(next.mags), mags = {};
    for (const g of guns) mags[g] = int(magIn[g], 0, GUN_MAG[g], GUN_MAG[g]);

    const ammoIn = obj(next.ammo), ammoPrev = obj(p && p.ammo), ammo = {};
    for (const k of AMMO) {
      let v = int(ammoIn[k], 0, 1e6, 0);
      if (rated) v = gain(int(ammoPrev[k], 0, 1e6, 0), v, ammoPerSec(lvl), rc, 2000);
      ammo[k] = v;
    }
    const itemIn = obj(next.items), itemPrev = obj(p && p.items), items = {};
    for (const k of ITEMS) {
      let v = int(itemIn[k], 0, 1e5, 0);
      if (rated) v = gain(int(itemPrev[k], 0, 1e5, 0), v, itemsPerSec(lvl), rc, 50);
      items[k] = v;
    }

    // --- story ---
    const qIn = obj(next.q), q = {};
    for (const id of STORY_Q) {
      const e = qIn[id];
      if (!e || typeof e !== "object") continue;
      q[id] = { s: oneOf(e.s, Q_STATES, "locked"), c: int(e.c, 0, 4, 0), p: num(e.p, 0, 1e5, 0) };
    }
    const active = uniq(arr(next.active, STORY_Q.length, (s) => str(s, 16)).filter((s) => STORY_Q.includes(s)));
    const tracked = STORY_Q.includes(next.tracked) ? next.tracked : null;

    const legIn = obj(next.legend), legend = {};
    for (const k of LEGENDARY) if (legIn[k] === true) legend[k] = true;

    let outside = null;
    if (Array.isArray(next.outside) && next.outside.length === 2)
      outside = [num(next.outside[0], 0, WORLD_W, 2000), num(next.outside[1], 0, MAP_H, 2400)];

    return {
      v: 1,
      x: num(next.x, 0, WORLD_W, 1950), y: num(next.y, 0, WORLD_H, 2400),
      hp, maxhp, money, xp, lvl, sp,
      side: oneOf(next.side, [null, "law", "outlaw"], null),
      honor: num(next.honor, -1e6, 1e6, 0), noto: num(next.noto, 0, 1e6, 0),
      wanted: num(next.wanted, 0, 5, 0), bounty: num(next.bounty, 0, 1e8, 0),
      guns, gi, mags, ammo, items, perks,
      awaken: num(next.awaken, 0, 100, 0), kills,
      dayT: num(next.dayT, 0, 0.9999, 0.32),
      flags: { finished: bool(obj(next.flags).finished) },
      legend, outside, q, active, tracked,
    };
  },

  // Only metrics with a physical ceiling from the code (derivations above).
  // Not declared: money, XP, kills - they scale with level and have no fixed cap.
  events: {
    bounties: { perSecond: 3 / 3.9, burst: 3 },   // board jobs, law or Kane's, finished
    duels:    { perSecond: 1 / 4.12, burst: 2 },  // saloon duels won
  },
};
