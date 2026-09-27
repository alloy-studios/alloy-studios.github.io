"use strict";
/**
 * RANK ZERO (site id "leveling-the-system") - Alloy Accounts validator.
 *
 * Save shape (rank-zero.html packSave):
 *   { level, exp, nextExp, gold, ap, baseStats:{str,agi,vit,per,int}, job,
 *     inventory:[itemId], equipment:{weapon, armor} }
 *
 * Every rule below mirrors a rule the game already enforces, so an honest save
 * cannot trip one:
 *   - level never goes backwards (a lower-level save is a stale tab: the stored
 *     save is kept whole), and total EXP rises at a rate derived below
 *   - gold may fall freely (the shop), and rises at a rate derived below
 *   - stat points: ap + points spent = 5 per level + 3 per Stat Manual bought,
 *     and Manuals are bounded by gold that could actually have been spent
 *   - a job needs level >= its req (renderJobs' canEquip)
 *   - an item that only drops in a rift needs level >= that rift's levelRec
 *     (renderGates' `locked`), shop items need nothing
 *   - equipped weapon/armor must be owned (equipSelectedItem)
 *
 * CLAMP, DON'T REJECT. A rejected save never replaces `prev`, so any Reject an
 * honest save can reach is a permanent silent lockout. Reject is used only for
 * garbage: a core number that is not a finite number, or is negative. Anything
 * merely too big is clamped. Honest paths that must survive: playing offline or
 * as a guest and then signing in far ahead of the cloud save, very long
 * sessions, and saving up gold then spending it all at once in the shop.
 */
const { Reject, str, arr } = require("./lib");

/* ------------------------------------------------------------------------
 * The game's own tables, copied from rank-zero.html
 * ---------------------------------------------------------------------- */
const STATS = ["str", "agi", "vit", "per", "int"];
const START_STAT = 10;          // player.baseStats
const AP_PER_LEVEL = 5;         // checkLevelUp: player.ap += 5 ; start ap is also 5
const MANUAL_AP = 3;            // SHOP_STOCK stat_manual: amount 3
const MANUAL_PRICE = 900;       //                          price 900
const EXP_PER_GOLD = 700 / 620; // SHOP_STOCK train_exp_m, the better of the two EXP buys
const INVENTORY_SIZE = 32;

const WEAPONS = new Set([
  "w_rusty", "w_vaskar", "w_kryal", "w_katana", "w_knights", "w_halberd", "w_scythe",
  "w_bow", "w_staff", "w_orb", "w_twinfang", "w_moonbow", "w_bear_claws", "w_orc_totem",
  "w_frost_spear", "w_curator_cube",
]);
const ARMOR = new Set(["a_leather", "a_highorc", "a_shadow"]);

// Lowest level at which each item can exist honestly. Sold in the shop (or the
// starting sword, or an E-rank drop) -> 1. Otherwise the lowest levelRec of any
// rift that drops it, because a rift below your level is locked.
//   E 1: w_rusty a_leather w_twinfang   D 5: w_bear_claws w_knights w_staff w_halberd
//   C 12: w_vaskar a_highorc w_bow w_moonbow   B 20: w_orc_totem a_highorc w_scythe
//   A 30: w_kryal w_frost_spear w_orb   S 40 / S+ 55: a_shadow w_katana w_curator_cube (+w_orb)
//   Shop: w_staff w_halberd w_knights w_twinfang a_highorc w_moonbow w_vaskar w_bow w_scythe a_shadow
const ITEM_MIN_LEVEL = {
  w_rusty: 1, a_leather: 1, w_twinfang: 1, w_knights: 1, w_staff: 1, w_halberd: 1,
  w_vaskar: 1, a_highorc: 1, w_bow: 1, w_moonbow: 1, w_scythe: 1, a_shadow: 1,
  w_bear_claws: 5, w_orc_totem: 20, w_kryal: 30, w_frost_spear: 30, w_orb: 30,
  w_katana: 40, w_curator_cube: 40,
};

// JOBS[*].req
const JOB_REQ = {
  none: 1, fighter: 10, assassin: 10, mage: 10, sovereign: 30, frost_sovereign: 32,
  beast_sovereign: 34, plague_sovereign: 36, white_flames_sovereign: 38,
  iron_body_sovereign: 40, transfiguration_sovereign: 42, giants_sovereign: 44,
  destruction_sovereign: 48,
};

/* ------------------------------------------------------------------------
 * Absolute ceilings. Only the first cloud save leans on these; after that the
 * rates below are the real bound. Generous on purpose.
 * ---------------------------------------------------------------------- */
const MAX_LEVEL = 5000;
const MAX_GOLD = 1e12;
const MAX_STAT = 1e7;
const MAX_AP = 1e7;
const MAX_EXTRA_AP = MANUAL_AP * 1e6;   // points from Stat Manuals (1e6 manuals)

/*
 * RATES - derived from rank-zero.html, not from feel.
 *
 * Time. The simulation advances one step per requestAnimationFrame
 * (mainLoop -> updateCombat), so the game runs faster on a faster screen.
 * Every rate is taken at FPS_MAX = 500 steps per second, above any shipping
 * monitor, so a high-refresh player can never be clamped.
 *
 * Spawns. updateCombat spawns while enemiesToSpawn > 0 and combatFrame % 30 === 0,
 * one spawn tick at a time, and a tick is at most 3 enemies (a swarm pack).
 * Nothing else creates enemies. So at most 3 enemies per 30 steps.
 *
 * Fastest possible rift clears (the spawn cadence is the floor however strong
 * the player is). startWave gives normal wave w: 4 + 2w spawns -> (4 + 2w - 1) * 30
 * steps of spawning; every wave change waits queueAction(120); the boss wave is
 * one spawn; clearing the boss waits 120 more before winGate.
 *   E  (2 waves): 150 + 120 + 120                                 =  ~420 steps
 *   C  (3):       150 + 210 + 2*120 + 120                         =   720
 *   B  (4):       150 + 210 + 270 + 3*120 + 120                   =  1110
 *   A  (5):       150..330 (960) + 4*120 + 120                     =  1560
 *   S  (6):       150..390 (1350) + 5*120 + 120                    =  2070
 *   S+ (8):       150..510 (2310) + 7*120 + 120                    =  3270
 *
 * Gold. winGate is the only source (goldReward), at most
 *   floor((levelRec*85 + waves*75) * (1 + 5*0.15))      [best grade S -> x1.75]
 *   A: 5119 / 1560 = 3.28 per step  (S 3.25, B 3.15, C 3.03, S+ 2.82, E 1.05)
 *   => 3.28 * 500 = 1640/s. GOLD_RATE 1700, burst one S+ clear (9231) -> 9500.
 *
 * EXP. From gems (die(): expAmt = (boss ? R*50 : R*5) * (elite ? 3 : 1) * K.hp),
 * with R = the rift's levelRec <= 55. The richest single spawn is an elite warden
 * at S+: 55*5*3*2.8 = 2310 per 30 steps = 77/step. Bosses: one per rift,
 * 55*50*10 = 27500 per >= 3270 steps at S+ (A: 15000/1560 = 9.6) -> <= 10/step.
 *   => (77 + 10) * 500 = 43500/s. EXP_RATE 45000, burst one S+ boss -> 30000.
 * EXP can also be bought (train_exp_m, 700 per 620 gold). That is bounded by gold
 * that could have been spent, not by time, because saving up and then buying
 * EXP in one burst is an honest path. See `spendable` in clean().
 *
 * Stat points. Earned 5 per level (checkLevelUp) and 3 per Stat Manual. Manuals
 * are likewise bounded by gold that could have been spent.
 */
const FPS_MAX = 500;
const GOLD_RATE = 1700, GOLD_BURST = 9500;
const EXP_RATE = 45000, EXP_BURST = 30000;

/* ------------------------------------------------------------------------
 * The level curve (getNextExpForLevel) and cumulative EXP to reach a level.
 * ---------------------------------------------------------------------- */
function nextExpFor(level) {
  return Math.floor(70 + Math.pow(level, 1.45) * 45 + level * 18);
}
const CUM = [0, 0]; // CUM[L] = EXP spent getting from level 1 to level L
function cumTo(level) {
  while (CUM.length <= level) {
    const l = CUM.length - 1;
    CUM.push(CUM[l] + nextExpFor(l));
  }
  return CUM[level];
}
/** Highest level whose cumulative EXP is <= total. */
function levelFor(total) {
  let lo = 1, hi = MAX_LEVEL;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumTo(mid) <= total) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/* ------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */
/** Finite, non-negative number or null (garbage). */
function nonneg(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function wholeIn(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}
/** ap + points spent, less what levels grant: 3 x Stat Manuals in honest play. */
function extraPoints(level, ap, stats) {
  let spent = 0;
  for (const s of STATS) spent += stats[s] - START_STAT;
  return ap + spent - AP_PER_LEVEL * level;
}
function cleanStats(v) {
  const src = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const out = {};
  for (const s of STATS) out[s] = wholeIn(src[s], START_STAT, MAX_STAT, START_STAT);
  return out;
}
/**
 * Remove `excess` stat points: unspent AP first, then from the stats in
 * proportion to what was put into each, never below the starting 10.
 */
function trimPoints(ap, stats, excess) {
  const fromAp = Math.min(ap, excess);
  ap -= fromAp; excess -= fromAp;
  if (excess <= 0) return { ap, stats };
  let spent = 0;
  for (const s of STATS) spent += stats[s] - START_STAT;
  const keep = Math.max(0, spent - excess);
  const out = {};
  let kept = 0;
  for (const s of STATS) {
    const share = spent > 0 ? Math.floor(((stats[s] - START_STAT) * keep) / spent) : 0;
    out[s] = START_STAT + share;
    kept += share;
  }
  // hand the rounding remainder back to the largest stats first
  const order = STATS.slice().sort((a, b) => stats[b] - stats[a]);
  for (let i = 0; kept < keep; i = (i + 1) % order.length) {
    if (out[order[i]] < stats[order[i]]) { out[order[i]]++; kept++; }
  }
  return { ap, stats: out };
}

module.exports = {
  maxBytes: 4 * 1024,

  clean(prev, d, ctx) {
    ctx = ctx || {};
    if (!d || typeof d !== "object" || Array.isArray(d)) throw new Reject("not an object");

    // --- garbage check on the core numbers; everything else only clamps ---
    const raw = { level: nonneg(d.level), exp: nonneg(d.exp), gold: nonneg(d.gold), ap: nonneg(d.ap) };
    for (const k of Object.keys(raw)) if (raw[k] === null) throw new Reject("bad " + k);

    const t = Number.isFinite(ctx.elapsedSec) && ctx.elapsedSec > 0 ? ctx.elapsedSec : 0;
    const P = prev && typeof prev === "object" && !ctx.first ? prev : null;

    // Level never goes down in play, so a lower level means the whole save is old
    // (a second tab, a device that was offline). Keep what we hold - all of it,
    // or its stale gold would clamp the up-to-date tab's next save. The game
    // adopts the reply, which brings the old tab up to date. `prev` was cleaned
    // when it was stored, so this pass returns it unchanged.
    if (P && Math.floor(raw.level) < wholeIn(P.level, 1, MAX_LEVEL, 1)) {
      return module.exports.clean(null, P, { first: true });
    }

    // --- gold: spendable balance, rises only by winGate ---
    let gold = Math.min(MAX_GOLD, Math.floor(raw.gold));
    let spendable = Infinity; // gold that could have been spent since prev
    if (P && Number.isFinite(P.gold)) {
      const income = GOLD_RATE * t + GOLD_BURST;
      if (gold > P.gold + income) gold = Math.floor(P.gold + income);
      spendable = Math.max(0, P.gold + income - gold);
    }

    // --- level + EXP: never backwards; total EXP rises at EXP_RATE plus what the
    //     spendable gold could have bought ---
    let level = Math.min(MAX_LEVEL, Math.max(1, Math.floor(raw.level)));
    // after every checkLevelUp exp < nextExp; legacy saves may carry nextExp up to
    // 1.25x the curve (loadProgress). 2x + 1000 is a sanity bound, not a rule.
    let exp = Math.min(raw.exp, 2 * nextExpFor(level) + 1000);
    let nextExp = Number(d.nextExp);
    let ap = Math.min(MAX_AP, Math.floor(raw.ap));
    let stats = cleanStats(d.baseStats);

    if (P) {
      const pLevel = wholeIn(P.level, 1, MAX_LEVEL, 1);
      const prevTotal = cumTo(pLevel) + Math.max(0, Number(P.exp) || 0);
      const allow = EXP_RATE * t + EXP_BURST + spendable * EXP_PER_GOLD;
      const total = cumTo(level) + exp;
      if (total > prevTotal + allow) {
        const capped = prevTotal + allow;
        level = Math.max(pLevel, levelFor(capped));
        exp = Math.max(0, capped - cumTo(level));
        nextExp = NaN; // re-derived below from the clamped level
      }
    }
    exp = Math.round(exp * 100) / 100; // gem EXP is fractional (K.hp 0.3 / 0.75 / 0.9)

    // loadProgress keeps a stored nextExp in [100, 1.25 x curve], else uses the curve
    const tuned = nextExpFor(level);
    nextExp = Number.isFinite(nextExp) && nextExp >= 100 && nextExp <= tuned * 1.25
      ? Math.floor(nextExp) : tuned;

    // --- stat points: 5 per level, plus 3 per Stat Manual the spendable gold covers ---
    {
      const extra = extraPoints(level, ap, stats);
      let allowExtra = MAX_EXTRA_AP;
      if (P) {
        const pLevel = wholeIn(P.level, 1, MAX_LEVEL, 1);
        const pExtra = extraPoints(pLevel, wholeIn(P.ap, 0, MAX_AP, 0), cleanStats(P.baseStats));
        allowExtra = Math.max(0, pExtra) + (Number.isFinite(spendable)
          ? MANUAL_AP * Math.floor(spendable / MANUAL_PRICE) : MAX_EXTRA_AP);
      }
      if (extra > allowExtra) ({ ap, stats } = trimPoints(ap, stats, extra - allowExtra));
    }

    // --- job: renderJobs only lets you take one at or above its req ---
    const job = Object.prototype.hasOwnProperty.call(JOB_REQ, d.job) && level >= JOB_REQ[d.job]
      ? d.job : "none";

    // --- inventory: known ids, level-gated drops, no duplicates, starter sword kept ---
    let inventory = arr(d.inventory, 64, (x) => str(x, 32))
      .filter((id) => Object.prototype.hasOwnProperty.call(ITEM_MIN_LEVEL, id) && level >= ITEM_MIN_LEVEL[id]);
    inventory = [...new Set(inventory)];
    if (!inventory.includes("w_rusty")) inventory.unshift("w_rusty");
    inventory = inventory.slice(0, INVENTORY_SIZE);

    // --- equipment must be owned (equipSelectedItem) ---
    const eq = d.equipment && typeof d.equipment === "object" && !Array.isArray(d.equipment) ? d.equipment : {};
    const weapon = WEAPONS.has(eq.weapon) && inventory.includes(eq.weapon) ? eq.weapon : "w_rusty";
    const armor = ARMOR.has(eq.armor) && inventory.includes(eq.armor) ? eq.armor : null;

    return {
      level, exp, nextExp, gold, ap,
      baseStats: stats,
      job,
      inventory,
      equipment: { weapon, armor },
    };
  },

  /*
   * Event metrics with a physical ceiling (see RATES above):
   *   kills - at most 3 enemies per 30 steps (the spawn tick), nothing else makes
   *           enemies: 0.1/step * 500 = 50/s. Burst: one wave's spawns, <= 18 ticks
   *           of up to 3 -> 54, rounded to 60.
   *   rifts - a clear takes >= ~420 steps (E-rank, above): 500 / 420 = 1.19/s.
   * NOT declared: gold and EXP. They are bounded per second, but they compound
   * with level (richer rifts unlock), so any event built on them would favour
   * whoever grinds the endgame rift rather than measuring anything fair.
   */
  events: {
    kills: { perSecond: 50, burst: 60 },
    rifts: { perSecond: 1.2, burst: 2 },
  },
};
