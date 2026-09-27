"use strict";
/**
 * MERIDIAN - Alloy Accounts validator.   Site id: meridian.
 *
 * The save is Econ.snapshot() in src/js/50_economy.js, unchanged:
 *   { v, cr, inv: [{uid, skin, weapon, rarity, float, stat, crate, ts}],
 *     eq: {weaponId: uid}, lo: {primary, sidearm, melee},
 *     cr8: {crateId: count}, st: {...}, cal, dft }
 *
 * RATES - derived from the game's code, not from feel.
 *
 * credits. There are exactly two sources: a drill payout (Drill.finish in
 *   src/js/68_drill.js) and selling an item (Econ.sell).
 *     payout = round((score * .045 + broke * 9) * pay * (1 + acc * .5))
 *   A hit scores base * distMul * chainMul, each at its maximum:
 *     base     200   centre ring
 *     distMul  1.62  1 + (38 - 12) / 42, the farthest plate is 38 m
 *     chainMul 2.5   1 + min(chain, 30) * .05
 *   => <= 810 score per hit, and a hit that breaks a plate adds 9, so
 *     per hit <= (810 * .045 + 9) * 1.6 (Gauntlet pay) * 1.5 (100% acc) = 109.1
 *   Hits are bounded by the trigger. Fastest: Hornet, interval 1/15 s, one
 *   pellet = 15 hits/s (Bulkhead 9 pellets / 0.769 s = 11.7, Cinder 10.3).
 *     => <= 1637 credits per second of play.   CREDITS_PER_SEC = 1650.
 *   This is a physical ceiling and deliberately far above real play (a strong
 *   60 s Calibration pays ~900). A payout lands all at once at the END of a
 *   drill, but the drill itself lasts >= 11 s (below), so the rate covers it;
 *   the burst only covers a drill paused mid-run to open crates, which puts a
 *   save inside the drill.
 *   Selling is not a rate: an item that left the inventory since the last save
 *   was worth exactly valueOf(item), computed below from the game's own table,
 *   so that much more is allowed. Trade-ups also remove items and are counted
 *   as sales - loose on purpose, trade-up has no UI and a false positive here
 *   only ever ALLOWS credits.
 *   Calibration levels are bought with credits (Econ.CAL.cost), so their cost
 *   comes out of the same allowance.
 *
 * items. A new item only comes out of a crate open, and the reel runs
 *   U.dur = 5.2 s before the reveal adds it (src/js/85_unbox.js).
 *     => 1 per 5.2 s, burst 2.
 *   The admin panel's "Give" exists only on localhost. Items never change
 *   after they are created, so an item already in the last save is taken from
 *   THAT save - a uid cannot be re-skinned into a Zenith.
 *   Not checkable: which tier a new item is. The roll happens in the browser
 *   and the server never sees it, so rarity is only bounded by the RATE of new
 *   items, not by the odds.
 *
 * crates held. Only Drill.finish -> Econ.rollDrop adds one, at most one per
 *   drill; Drill.abort pays nothing. The shortest drill is a failed Gauntlet:
 *   D.wave++ happens before the first spawn, so speed = .9 + .22 = 1.12 and a
 *   plate crosses its 12.4 m rail in 11.07 s, which ends the run.
 *     => 1 per 11 s, burst 2.   Opening a crate may lower the count freely.
 *
 * calibration 0..5, only ever bought (Econ.calBuy), never sold back.
 * drift       0..60 - the longest guarantee is 43 (Foundry, level 0).
 *
 * CLAMP, DON'T REJECT. The only Reject is a save that is not an object at all.
 * Every other bad value is clamped or replaced with the last accepted one, so
 * an honest save can never be locked out.
 */
const { Reject, int, num, bool, str, oneOf } = require("./lib");

// skin id -> [weapon, rarity, floatMin, floatMax, valueMul]   (src/js/40_skins.js)
const SKINS = {
  "cin_millscale":     ["cinder",  1, 0.04, 0.72, 1],
  "cin_blueprint":     ["cinder",  1, 0.02, 0.55, 1],
  "cin_olivedrab":     ["cinder",  1, 0.06, 0.8, 1],
  "cin_hotroll":       ["cinder",  2, 0.01, 0.48, 1],
  "cin_tigerquench":   ["cinder",  2, 0.05, 0.62, 1],
  "cin_nightshift":    ["cinder",  3, 0, 0.4, 1],
  "cin_patternweld":   ["cinder",  3, 0, 0.32, 1],
  "cin_overtemp":      ["cinder",  4, 0, 0.26, 1],
  "hor_ferrite":       ["hornet",  1, 0.05, 0.78, 1],
  "hor_safety":        ["hornet",  1, 0.08, 0.85, 1],
  "hor_seaglass":      ["hornet",  2, 0.02, 0.5, 1],
  "hor_waspline":      ["hornet",  2, 0.04, 0.58, 1],
  "hor_coldweld":      ["hornet",  3, 0, 0.35, 1],
  "hor_vaporlock":     ["hornet",  4, 0, 0.24, 1],
  "spu_parkerised":    ["spur",    1, 0.06, 0.8, 1],
  "spu_boneyard":      ["spur",    1, 0.1, 0.9, 1],
  "spu_slagbloom":     ["spur",    2, 0.03, 0.55, 1],
  "spu_ionblue":       ["spur",    2, 0, 0.42, 1],
  "spu_orchid":        ["spur",    3, 0, 0.36, 1],
  "spu_deepfield":     ["spur",    4, 0, 0.22, 1],
  "lon_annealed":      ["longbow", 1, 0.05, 0.75, 1],
  "lon_surveyor":      ["longbow", 1, 0.04, 0.6, 1],
  "lon_dustline":      ["longbow", 2, 0.08, 0.8, 1],
  "lon_gunmetal":      ["longbow", 2, 0, 0.44, 1],
  "lon_crucible":      ["longbow", 3, 0, 0.3, 1],
  "lon_lastlight":     ["longbow", 4, 0, 0.2, 1],
  "bul_shopfloor":     ["bulkhead", 1, 0.1, 0.9, 1],
  "bul_scaled":        ["bulkhead", 1, 0.08, 0.82, 1],
  "bul_redlead":       ["bulkhead", 2, 0.05, 0.65, 1],
  "bul_frostbite":     ["bulkhead", 2, 0.02, 0.5, 1],
  "bul_ingot":         ["bulkhead", 3, 0, 0.34, 1],
  "tan_shopgrade":     ["tang",    3, 0.04, 0.6, 1],
  "tan_forgeblack":    ["tang",    4, 0, 0.35, 1],
  "tan_damascene":     ["tang",    4, 0, 0.18, 1.3],
  "tan_goldpour":      ["tang",    4, 0, 0.14, 1.9],
  "hoo_shopgrade":     ["hook",    3, 0.04, 0.6, 1],
  "hoo_bloodline":     ["hook",    4, 0, 0.3, 1],
  "hoo_eventhorizon":  ["hook",    5, 0, 0.16, 1.6],
  "hoo_aperture":      ["hook",    6, 0, 0.12, 2.2],
  "cin_teardown":      ["cinder",  6, 0, 0.09, 2.6],
  "tan_afterimage":    ["tang",    6, 0, 0.08, 2.5],
  "spu_roulette":      ["spur",    6, 0, 0.09, 2.4],
  "hor_swarm":         ["hornet",  6, 0, 0.09, 2.5],
  "lon_spotter":       ["longbow", 6, 0, 0.08, 2.6],
  "bul_phase":         ["bulkhead", 6, 0, 0.1, 2.5],
  "cin_overclock":     ["cinder",  5, 0, 0.12, 2.1],
  "lon_parallax":      ["longbow", 5, 0, 0.1, 2.4],
  "tan_filament":      ["tang",    5, 0, 0.09, 2.3],
  "hor_greyscale":     ["hornet",  2, 0.04, 0.66, 1],
  "lon_chalkline":     ["longbow", 2, 0.05, 0.7, 1],
  "bul_deckhand":      ["bulkhead", 2, 0.07, 0.78, 1],
  "spu_flashover":     ["spur",    4, 0, 0.25, 1],
  "cin_slagheap":      ["cinder",  3, 0, 0.42, 1],
  "bul_cupola":        ["bulkhead", 3, 0, 0.38, 1],
  "hor_toolroom":      ["hornet",  1, 0.06, 0.8, 1],
  "spu_benchgrade":    ["spur",    1, 0.07, 0.84, 1],
  "lon_shopcoat":      ["longbow", 2, 0.05, 0.68, 1],
  "bul_bluecoat":      ["bulkhead", 2, 0.02, 0.5, 1],
  "cin_workhorse":     ["cinder",  2, 0.06, 0.74, 1]
};
// weapon id -> slot   (src/js/30_arsenal.js)
const WEAPONS = { cinder: "primary", hornet: "primary", longbow: "primary", bulkhead: "primary",
                  spur: "sidearm", tang: "melee", hook: "melee" };
const DEFAULT_LOADOUT = { primary: "cinder", sidearm: "spur", melee: "tang" };
const CRATES = ["foundry", "slag", "quench", "crucible"];
// Econ.RAR[tier].sell, Econ.WEAR [hi, mul], Econ.CAL.cost
const SELL = [0, 26, 83, 266, 858, 3400, 15000];
const WEAR = [[0.07, 1.55], [0.15, 1.25], [0.38, 1], [0.45, 0.82], [1, 0.68]];
const CAL_COST = [0, 1500, 4200, 9500, 21000, 46000];

const MAX_INV = 400;             // Econ.add truncates the inventory at 400
const MAX_CREDITS = 1e10;
const CREDITS_PER_SEC = 1650, CREDIT_BURST = 5000;
const ITEMS_PER_SEC = 1 / 5.2, ITEM_BURST = 2;
const CRATES_PER_SEC = 1 / 11, CRATE_BURST = 2;

/** Mirrors Econ.valueOf exactly. */
function valueOf(it) {
  const s = SKINS[it.skin];
  let w = WEAR[4];
  for (const x of WEAR) if (it.float < x[0]) { w = x; break; }
  return Math.max(4, Math.round(SELL[s[1]] * w[1] * (it.stat ? 1.35 : 1) * s[4]));
}

/** One item, or null if it cannot be one. Weapon and rarity come from the
 *  skin table, never from the save. */
function cleanItem(x) {
  if (!x || typeof x !== "object") return null;
  const skin = str(x.skin, 40);
  const s = SKINS[skin];
  const uid = str(x.uid, 40);
  if (!s || !uid) return null;
  return {
    uid, skin, weapon: s[0], rarity: s[1],
    float: num(x.float, s[2], s[3], s[2]),
    stat: bool(x.stat),
    crate: oneOf(x.crate, CRATES, null),
    ts: int(x.ts, 0, 4102444800000, 0),
  };
}

/** A finite number, else the fallback. Garbage is replaced, never rejected. */
const finite = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : fallback);

const sumCal = (from, to) => CAL_COST.slice(from + 1, to + 1).reduce((a, b) => a + b, 0);

module.exports = {
  // 400 items at ~140 bytes each is ~56 KB; the default 32 KB would refuse a
  // full inventory, and a refused save is a player who can never sync again.
  maxBytes: 96 * 1024,

  clean(prev, next, ctx) {
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Reject("not a save");
    ctx = ctx || {};
    const first = !prev || typeof prev !== "object" || !!ctx.first;
    const t = Number.isFinite(ctx.elapsedSec) ? Math.max(0, ctx.elapsedSec) : 0;
    const P = first ? {} : prev;

    // ---- inventory: known skins, unique uids, existing items immutable
    const prevById = new Map();
    for (const x of Array.isArray(P.inv) ? P.inv : []) {
      const it = cleanItem(x);
      if (it) prevById.set(it.uid, it);
    }
    let fresh = first ? Infinity : Math.floor(ITEMS_PER_SEC * t + ITEM_BURST);
    const seen = new Set();
    const inv = [];
    for (const x of Array.isArray(next.inv) ? next.inv.slice(0, MAX_INV) : []) {
      const it = cleanItem(x);
      if (!it || seen.has(it.uid)) continue;
      if (prevById.has(it.uid)) { seen.add(it.uid); inv.push(prevById.get(it.uid)); continue; }
      if (fresh <= 0) continue;          // too many new items for the time: drop the extras
      fresh--;
      seen.add(it.uid);
      inv.push(it);
    }

    // ---- calibration and credits, one ledger
    let cal = int(next.cal, 0, 5, first ? 0 : int(P.cal, 0, 5, 0));
    let cr = Math.floor(Math.min(MAX_CREDITS, Math.max(0, finite(next.cr, first ? 0 : finite(P.cr, 0)))));
    if (!first) {
      const prevCal = int(P.cal, 0, 5, 0);
      const prevCr = Math.max(0, finite(P.cr, 0));
      if (cal < prevCal) cal = prevCal;                  // levels are never sold back
      let sold = 0;
      for (const [uid, it] of prevById) if (!seen.has(uid)) sold += valueOf(it);
      let budget = prevCr + CREDITS_PER_SEC * t + CREDIT_BURST + sold;
      while (cal > prevCal && sumCal(prevCal, cal) > budget) cal--;
      budget -= sumCal(prevCal, cal);
      cr = Math.min(cr, Math.max(0, Math.floor(budget)));
    }

    // ---- crates held: fall freely, rise only by drill drops
    const cr8 = {};
    const src = next.cr8 && typeof next.cr8 === "object" ? next.cr8 : {};
    const was = P.cr8 && typeof P.cr8 === "object" ? P.cr8 : {};
    let rise = first ? Infinity : Math.floor(CRATES_PER_SEC * t + CRATE_BURST);
    for (const k of CRATES) {
      let n = int(src[k], 0, 9999, 0);
      const before = first ? 0 : int(was[k], 0, 9999, 0);
      if (n > before) { const up = Math.min(n - before, rise); rise -= up; n = before + up; }
      if (n) cr8[k] = n;
    }

    // ---- what is carried and worn must be real
    const lo = {};
    const nlo = next.lo && typeof next.lo === "object" ? next.lo : {};
    for (const slot of Object.keys(DEFAULT_LOADOUT)) {
      lo[slot] = WEAPONS[nlo[slot]] === slot ? nlo[slot] : DEFAULT_LOADOUT[slot];
    }
    const eq = {};
    const neq = next.eq && typeof next.eq === "object" ? next.eq : {};
    const byUid = new Map(inv.map((i) => [i.uid, i]));
    for (const wid of Object.keys(WEAPONS)) {
      const it = byUid.get(neq[wid]);
      if (it && it.weapon === wid) eq[wid] = it.uid;
    }

    const st = {};
    const nst = next.st && typeof next.st === "object" ? next.st : {};
    for (const k of Object.keys(nst).slice(0, 16)) {
      if (k.length <= 24) st[k] = int(nst[k], 0, 1e9, 0);
    }

    return { v: 4, cr, inv, eq, lo, cr8, st, cal, dft: int(next.dft, 0, 60, 0) };
  },

  /* No event metrics yet. The game reports none to AA.progress, and a metric
     the game never reports would let the owner build an event that can never
     move. Honest candidates if events are wanted later, each timer-bound:
       platesBroken  <= 15 per second (the trigger, as above)
       drills        <= 1 per 11 s    (the shortest Gauntlet)
       cratesOpened  <= 1 per 5.2 s   (the reel)                            */
  events: {},
};
