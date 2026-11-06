"use strict";
/**
 * Starsong - Alloy Accounts validator.
 *
 * Big numbers in this game are stored as their base 10 logarithm in a plain number:
 * 1e1400 Light is the number 1400, and "nothing" is ZERO (-1e300). So a save is small
 * and JSON safe however far the player gets, and every Light rule below is in orders of
 * magnitude.
 *
 * ONE RATE, THEN EXACT RULES. In-run Light has no useful speed limit: a run climbs
 * about 260 orders of magnitude a second just after a reset, because permanent bonuses
 * make the first planets huge. So only the player's best-ever Light (stats.bestRun) is
 * rate limited. Everything else is tied to it by rules that are exact in the game code,
 * so an honest save can never trip them:
 *     light <= runLight <= bestRun              addLight() raises all three together
 *     totalLight <= bestRun + 6                 lifetime Light is a sum of runs
 *     planet level <= what bestRun could buy    levelPrice(), at its very cheapest
 *     stardust <= stardustTotal <= the most bestRun could have earned   stardustGain()
 *     voidCur + stars bought <= voidTotal <= the most bestRun could have earned   voidGain()
 *
 * CLAMP, DON'T REJECT. Nothing here rejects a save the game could send. A missing or
 * garbage value keeps the last accepted one. Run values may always fall, because a
 * Supernova or Collapse resets a run. Lifetime Light is the exception: a save with less
 * of it than the stored one came from a device that is behind, so the stored save stays.
 *
 * Checked by tools/validator-worker.js: active, casual and idle bots played the whole
 * game plus 6 hours past the ending, and not one field of one save was changed.
 * The ID tables below must match js/data.js. That same check fails if they drift.
 */
const { Reject, int, num, bool, oneOf, gain } = require("./lib");

const ZERO = -1e300;

// Absolute caps. Measured after 6 hours past the ending: Light 1e1558, Void 1,733,
// planet level 5,386, Stardust 1e987. Light creeps up with the square root of Void from
// there, so 20,000 orders of magnitude is out of honest reach.
const LIGHT_CAP = 20000;
const VOID_CAP = 1e9;
const LEVEL_CAP = 100000;
const COUNT_CAP = 1e9;
const SONG_REQ = 1400;   // data.js: Light needed for the ending

/*
 * RATES - derived from js/game.js and js/ui.js, and measured with the bots.
 *
 * bestRun: no physical limit, so this comes from measurement. The fastest honest rise
 *   was 36 orders of magnitude a second across a 4.6 s save gap (165 in that gap) and
 *   8 a second across a 20 s gap (160). 15 a second plus a burst of 300 allows 369 in
 *   the 4.6 s gap and 600 in the 20 s gap, over twice the honest peak in both. Being too
 *   tight costs an honest player progress, so this errs wide. It still stops a save
 *   jumping straight from early game to the ending.
 *
 * time: tick() adds real seconds only, and a hidden tab still ticks in real time.
 *   Offline payouts add no time. => 1 a second, burst 60 for network delay.
 *
 * supernovas: runSupernova() holds a lock for its 750 ms timer. => 1 / 0.75 a second.
 * collapses: no timer, but each needs a dialog and two clicks. => 2 a second.
 * crescendos: one lasts crescLen, at least 10 s, and cannot restart early. => 1 / 10.
 * grands: one per 48 beats. Tempo is capped at 150 BPM and a Crescendo adds 25%, so
 *   3.125 beats a second at most. => 48 beats takes 15.36 s, so 1 / 15.
 * comets: the fastest timer is a shower at 1.2 s divided by cometRate, at most x12
 *   (Comet Lure x2, Comet Watch x1.5, Binary x4), and a shower is 5 comets. => 2 a second.
 * taps: tap() has no limiter, so this only stops absurd values. => 30 a second.
 */
const RATE = {
  bestRun: 15, time: 1, supernovas: 1 / 0.75, collapses: 2,
  crescendos: 1 / 10, grands: 1 / 15, comets: 2, taps: 30,
};
const BURST = {
  bestRun: 300, time: 60, supernovas: 3, collapses: 3,
  crescendos: 2, grands: 2, comets: 10, taps: 120,
};

// js/data.js NODES: id -> highest level
const NODE_MAX = {
  root: 1, forge1: 1, forge2: 1, forge3: 1, forge4: 1, forge5: 1, forge6: 1, forge7: 1, core: 500,
  lyre1: 1, lyre2: 1, lyre3: 1, lyre4: 1, lyre5: 1, lyre6: 1, lyre7: 1, lyre8: 40,
  hand1: 1, hand2: 1, hand3: 1, hand4: 1, hand5: 1, hand6: 1, hand7: 1,
  crown1: 1, crown2: 1, crown3: 1, crown4: 1, crown5: 1, crown6: 1, crown7: 1, heavy: 500,
  comet1: 1, comet2: 1, comet3: 1, comet4: 1, comet5: 1, comet6: 1, comet7: 1,
  hour1: 1, hour2: 1, hour3: 1, hour4: 1, hour5: 1, hour6: 1, hour7: 1,
};
// js/data.js SKY: id -> Void cost
const SKY_COST = {
  vega: 1, sirius: 2, altair: 4, rigel: 8, deneb: 14, antares: 22,
  capella: 34, polaris: 50, spica: 70, aldebaran: 100, betelgeuse: 140, procyon: 200,
};
const TUNINGS = [
  "touch1", "tempo1", "chorus1", "chord1", "align1", "sustain1", "chorus2", "touch2", "tempo2", "lure1",
  "chorus3", "overtone1", "tempo3", "chorus4", "align2", "crown1", "chorus5", "tempo4", "chorus6",
  "chorus7", "chorus8", "chorus9", "chorus10",
  "p0_0", "p0_1", "p0_2", "p0_3", "p1_0", "p1_1", "p1_2", "p1_3", "p2_0", "p2_1", "p2_2", "p2_3",
  "p3_0", "p3_1", "p3_2", "p3_3", "p4_0", "p4_1", "p4_2", "p4_3", "p5_0", "p5_1", "p5_2", "p5_3",
  "p6_0", "p6_1", "p6_2", "p6_3", "p7_0", "p7_1", "p7_2", "p7_3",
];
const DEEDS = [
  "spark", "orbit", "intime", "metronome", "perfectionist", "duet", "quartet", "octet", "octave",
  "centurion", "fivehundred", "million", "billion", "dawnbreak", "crescendo", "crescendo25", "grand",
  "grand8", "catch", "catch50", "nova1", "nova10", "nova50", "fastnova", "chart5", "chart25", "chartall",
  "class", "allclass", "trial1", "trialall", "e50", "collapse1", "sky3", "sky12", "e500", "song",
];
const TRIALS = ["silence", "three", "molasses", "bare", "gravity", "flat", "drought", "requiem"];
const CLASSES = ["main", "giant", "dwarf", "pulsar", "binary"];
const STAGE_MAX = 5;
const AUTO_EVERY = [0, 5, 15, 30, 60, 300];      // js/ui.js AUTO_EVERY
const AUTO_SHARE = [1, 0.5, 0.25, 0.1];          // js/ui.js AUTO_SHARE

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
// The game's NaN arrives here as null, and Number(null) is 0, which would quietly wipe a
// balance. Only a real number counts. Anything else keeps the last accepted value.
const log = (v, was) => num(isNum(v) ? v : was, ZERO, LIGHT_CAP, ZERO);
const whole = (v, was, cap = COUNT_CAP) => int(isNum(v) ? v : was, 0, cap, 0);

/** A map of known ids that are simply owned. */
function owned(v, ids) {
  const out = {};
  if (isObj(v)) for (const id of ids) if (v[id] === true) out[id] = true;
  return out;
}

/** Highest planet level a best-ever Light could have paid for. Uses the cheapest price
 *  any planet can have: Cinder's 10, less 2 orders of magnitude from the Three Bodies
 *  reward, at the 1.12 growth floor, plus the climb above level 300 (levelPrice). */
function levelCeiling(best) {
  const price = (lv) => {
    const over = lv > 300 ? lv - 300 : 0;
    return -1 + lv * Math.log10(1.12) + over * over * 0.00005;
  };
  let lo = 0, hi = LEVEL_CAP;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (price(mid - 1) <= best + 1) lo = mid; else hi = mid;
  }
  return lo;
}

/** Most lifetime Stardust a best-ever Light could have earned. stardustGain() is
 *  ((run - 12) * sdExp + log10(4) + sdMult) * sdPow, at the best sdExp (0.39), sdPow
 *  (1.08 twice) and sdMult (x2 node, requiem's +3, and 3x per Heavy Elements level),
 *  then log10 of how many gains there could have been. */
function stardustCeiling(best, heavy, gains) {
  const run = Math.max(best - 12, 0);
  return (run * 0.39 + 0.61 + 0.31 + 3 + heavy * 0.4772) * 1.1664 + Math.log10(gains + 10) + 1;
}

/** Most lifetime Void a best-ever Light could have earned: voidGain() at the best
 *  voidMult (x3), for every Collapse so far. */
function voidCeiling(best, collapses) {
  return Math.ceil(collapses * Math.pow(Math.max(best, 0) / 100, 1.8) * 3);
}

function cleanNodes(v) {
  const out = {};
  if (!isObj(v)) return out;
  for (const id of Object.keys(NODE_MAX)) {
    const lv = int(v[id], 0, NODE_MAX[id], 0);
    if (lv > 0) out[id] = lv;
  }
  return out;
}

function cleanSky(v, voidTotal) {
  const out = {};
  let spent = 0;
  if (isObj(v)) {
    for (const id of Object.keys(SKY_COST)) {
      if (v[id] === true && spent + SKY_COST[id] <= voidTotal) { out[id] = true; spent += SKY_COST[id]; }
    }
  }
  return { sky: out, spent };
}

function cleanStory(v) {
  const out = {};
  if (!isObj(v)) return out;
  for (const k of Object.keys(v).slice(0, 64)) {
    if (/^[A-Za-z0-9]{1,24}$/.test(k)) out[k] = num(v[k], -1, 1e14, 0);
  }
  return out;
}

function cleanAuto(a) {
  const v = isObj(a) ? a : {};
  const on = Array.isArray(v.planetOn) ? v.planetOn : [];
  const out = { planetOn: [] };
  for (let i = 0; i < 8; i++) out.planetOn.push(on[i] !== false);
  for (const k of ["planets", "savePlanet", "saveTuning", "tunings", "cresc", "keeper"]) out[k] = v[k] !== false;
  for (const k of ["supernova", "open"]) out[k] = bool(v[k]);
  out.every = oneOf(v.every, AUTO_EVERY, 0);
  out.share = oneOf(v.share, AUTO_SHARE, 1);
  out.snTarget = num(v.snTarget, 0.1, 1e6, 2);
  return out;
}

module.exports = {
  // A finished save is about 3.4 KB. Going over this fails the save outright, so it is wide.
  maxBytes: 16 * 1024,

  clean(prev, next, ctx) {
    if (!isObj(next)) throw new Reject("save must be an object");
    const p = isObj(prev) ? prev : {};
    const ps = isObj(p.stats) ? p.stats : {};
    const st = isObj(next.stats) ? next.stats : {};
    const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();

    // Lifetime Light never falls within one save, so a lower figure means this came from
    // a device that is behind, like a school laptop left open while the player went on at
    // home. Keep what is stored. The reply then hands that device the newer progress.
    if (isNum(next.totalLight) && isNum(p.totalLight) && next.totalLight < p.totalLight - 1e-6) {
      return { ...p, seq: whole(next.seq, 0, 1e15) };
    }

    const count =(v, key, was) => gain(whole(was, 0), whole(v, was), RATE[key], ctx, BURST[key]);

    // Best-ever Light first, because nearly everything else hangs off it. ZERO is -1e300,
    // and adding an allowance to that changes nothing, so the rate counts up from 1.
    const wasBest = log(ps.bestRun);
    const best = gain(Math.max(wasBest, 0), log(st.bestRun, wasBest), RATE.bestRun, ctx, BURST.bestRun);

    const runLight = Math.min(log(next.runLight, p.runLight), best);
    const light = Math.min(log(next.light, p.light), runLight);
    const totalLight = Math.min(log(next.totalLight, p.totalLight), best + 6);

    const supernovas = count(next.supernovas, "supernovas", p.supernovas);
    const collapses = count(next.collapses, "collapses", p.collapses);
    const comets = count(st.comets, "comets", ps.comets);
    const taps = count(st.taps, "taps", ps.taps);
    const grands = count(st.grands, "grands", ps.grands);

    const nodes = cleanNodes(next.nodes);
    const sdCap = stardustCeiling(best, nodes.heavy || 0, supernovas + comets);
    const stardustTotal = Math.min(log(next.stardustTotal, p.stardustTotal), sdCap);
    const stardust = Math.min(log(next.stardust, p.stardust), stardustTotal);

    const voidTotal = Math.min(whole(next.voidTotal, p.voidTotal, VOID_CAP), voidCeiling(best, collapses));
    const { sky, spent } = cleanSky(next.sky, voidTotal);
    const voidCur = Math.min(whole(next.voidCur, p.voidCur, VOID_CAP), voidTotal - spent);

    const levelMax = levelCeiling(best);
    const sentLevels = Array.isArray(next.planets) ? next.planets : [];
    const wasLevels = Array.isArray(p.planets) ? p.planets : [];
    const planets = [];
    for (let i = 0; i < 8; i++) planets.push(Math.min(whole(sentLevels[i], wasLevels[i], LEVEL_CAP), levelMax));

    return {
      seq: whole(next.seq, 0, 1e15),
      light, runLight, totalLight, planets,
      tunings: owned(next.tunings, TUNINGS),
      stage: whole(next.stage, p.stage, STAGE_MAX),
      runTime: num(isNum(next.runTime) ? next.runTime : p.runTime, 0, 1e10, 0),
      stardust, stardustTotal, nodes,
      supernovas,
      starClass: oneOf(next.starClass, CLASSES, "main"),
      nextClass: oneOf(next.nextClass, CLASSES, "main"),
      trial: oneOf(next.trial, TRIALS, null),
      trialsDone: owned(next.trialsDone, TRIALS),
      voidCur, voidTotal, collapses, sky,
      ended: bool(next.ended) && best >= SONG_REQ,
      deeds: owned(next.deeds, DEEDS),
      story: cleanStory(next.story),
      auto: cleanAuto(next.auto),
      stats: {
        time: gain(num(ps.time, 0, 1e10, 0), num(isNum(st.time) ? st.time : ps.time, 0, 1e10, 0), RATE.time, ctx, BURST.time),
        taps,
        perfects: Math.min(whole(st.perfects, ps.perfects), taps),
        goods: Math.min(whole(st.goods, ps.goods), taps),
        bestStreak: Math.min(whole(st.bestStreak, ps.bestStreak), taps),
        crescendos: count(st.crescendos, "crescendos", ps.crescendos),
        grands,
        grand8: Math.min(whole(st.grand8, ps.grand8), grands),
        comets,
        bestRun: best,
        fastestNova: num(isNum(st.fastestNova) ? st.fastestNova : ps.fastestNova, 0, 1e308, 1e308),
        classesPlayed: owned(st.classesPlayed, CLASSES),
        created: int(isNum(st.created) ? st.created : ps.created, 0, now, now),
      },
      lastSeen: int(isNum(next.lastSeen) ? next.lastSeen : p.lastSeen, 0, now, now),
    };
  },

  // No events yet. These stats have honest ceilings if the owner wants one later:
  // crescendos (1 per 10 s), grands (1 per 15 s) and supernovas (1 per 0.75 s). The game
  // would also need to report them with AA.progress. Light and Stardust compound without
  // limit, so they can never be event metrics.
  events: {},
};
