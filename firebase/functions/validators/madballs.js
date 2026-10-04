"use strict";
/**
 * MADBALLS — Alloy Accounts validator.
 * Game id: madballs   (game source: src/*.js, built into dist/madballs-public.html)
 *
 * THE CLOUD SAVE is the synced part of the game's local save `G.save`
 * (localStorage "madballs.save.v1"), built by Alloy.pack() in src/72-alloy.js:
 *
 *   rev         client payload counter, echoed back so the game can match a
 *               reply to the exact payload it validated. Not progress.
 *   coins       spendable balance
 *   inv         { skinId: count } — every crate adds exactly one unit to one
 *               skin (a duplicate raises that skin's count and refunds coins)
 *   equipped    skin id, must be owned
 *   pity, mythicPity, transPity   crates since the last legendary+ / mythic /
 *               transcendent; at cap-1 the next crate is forced to that tier
 *   opened      lifetime crates opened (display)
 *   unlocked    levels unlocked, 1..14
 *   best        { "L0".."L23": best score } (display only)
 *   firstCrate  the one-time free welcome crate has been claimed
 *
 * `muted` is a per-device preference and is deliberately not synced.
 *
 * CLAMP, DON'T REJECT. Reject fires only on data no build of the game can
 * produce: a save that is not an object. Everything out of range is clamped;
 * unknown skin ids are dropped. A reachable Reject would be a silent permanent
 * lockout (see speed-simulator.js).
 *
 * Nothing in the game ever removes a skin or lowers `unlocked`, `opened` or a
 * best, so those never fall here either — a stale second device cannot wipe
 * a collection. Coins and pity counters may fall freely (spending, a pity
 * reset); only their RISE is limited.
 *
 * ------------------------------------------------------------------ RATES
 * All derived from the game source. Game logic runs in fixed 1/60 s steps
 * (STEP_MS in 60-game.js), so "frames" below are 1/60 s of real time; slow
 * motion only ever makes things take longer, never shorter.
 *
 * crates   UI.openCrate() reveals after `total = 950 + skin.rar * 320` ms
 *          (70-ui.js), so crates are >= 0.95 s apart = 1.053 / s.
 *          => 1 / 0.95 s, burst 3. The cheapest crate costs 550 coins, so
 *          every crate past the one free welcome crate (firstCrate false ->
 *          true) must also have been paid for — see coins.
 *
 * coins    Coins reach the save only at two kinds of checkpoint.
 *   1. The end of a level: onCleared banks coinsEarned + a clear bonus,
 *      onFailed banks half of coinsEarned (60-game.js). Per level the most
 *      that can be banked is TOTALITY (7 balls) with THE HOUSE:
 *        jackpots   7 x (1500 + 13 * 250)             = 33,250
 *        madballs   11 + 6 blob runts, pts * .09       =  1,113
 *        blocks     23 x 22 (steel, the dearest)      =    506
 *        clear      180 + 13 * 60 + 6 * 70            =  1,380   => 36,249
 *      (MIDAS triples kill/block coins but cannot also be THE HOUSE: one
 *      skin per attempt; gilded TOTALITY is 3 x 1,619 + 1,380 = 6,237.)
 *   2. A crate: a duplicate refunds DUPE_COINS[rarity]. The best net gain of
 *      one crate is a VOID crate (5,400) rolling an owned transcendent
 *      (25,000) = +19,600.
 *   A crate checkpoint can land right behind a level checkpoint inside the
 *   server's ~4.5 s floor: 36,249 + 19,600 = 55,849 => BURST 60,000.
 *   Sustained, adding every path as if they could stack (they cannot):
 *      jackpots    4,750 per 200 frames (14 + 6 * 26 + 30, 62-elite-systems.js)
 *                  = 1,425 / s
 *      DICE        300 per ball; a ball settles (still > 44 frames) and the
 *                  next loads 34 frames later: >= 80 frames = 225 / s
 *      clears      <= 6,237 per clear; a clear needs the ball in flight (>= 1
 *                  frame) and onCleared's after(28) under slowmo(.28), whose
 *                  timeScale eases .28 + .72 * .88^k: 28 game frames take 82
 *                  real frames => >= 83 frames = 1.38 s, so 4,520 / s
 *      dupes       a mythic dupe nets 7,500 - 5,400 = 2,100 per >= 2.55 s
 *                  (950 + 5 * 320 ms) = 824 / s
 *   1,425 + 225 + 4,520 + 824 = 6,994 => 7,000 / s.
 *   That is far above any real play; it is a ceiling, not a target.
 *
 * unlocked onCleared sets unlocked = max(unlocked, levelIndex + 2) and only
 *          unlocked levels can be played, so it rises by 1 per clear, and a
 *          clear takes >= 1.38 s (above) => 0.75 / s, burst 2.
 *
 * pity     Each crate adds 1 or resets to 0, so a counter can rise by at most
 *          the number of crates opened since the last save.
 *
 * best     Score is 0.55 per point of damage dealt (damageBody) and damage is
 *          not capped at a block's remaining hp, so a single GLITCH "NULL"
 *          (99,999 x TIER_POWER 2.1) is worth 115,499 on its own. There is no
 *          tight physical ceiling. Bests are display-only — no event or
 *          leaderboard reads a save — so they get an absolute cap of 1e8 and
 *          a loose 250,000 / s (burst 5,000,000) to stop a forged save
 *          jumping straight to it. A best only exists for an unlocked level.
 *
 * ---------------------------------------------------------------- LIMITS
 * A crate's pull comes from Math.random() on the player's machine, so the
 * server cannot verify WHICH skin a crate gave. The checks above bound HOW
 * MANY units appear (by time and by coins spent) and, when a save claims more
 * than that, the rarest additions are the ones dropped. A forged save can
 * still claim its crates were lucky; that only affects the forger's own
 * collection.
 *
 * NEW SKINS added to the game must be added to SKINS below, or the validator
 * drops them from saves.
 */
const { Reject, int, bool, str, grow } = require("./lib");

// ------------------------------------------------------ tables (game source)
// id -> rarity: 0 common, 1 uncommon, 2 rare, 3 epic, 4 legendary, 5 mythic,
// 6 transcendent. From 30-skins.js, 32-skins-extra.js, 34-skins-elite.js.
const SKINS = {
  pebble: 0, rubber: 0, spud: 0, eight: 0, egg: 0, cog: 0,
  trinity: 1, bomb: 1, frost: 1, dart: 1, swarm: 1, coil: 1,
  boomer: 2, magneto: 2, storm: 2, anchor: 2, dice: 2, slime: 2,
  phantom: 3, nova: 3, magma: 3, tempest: 3, virus: 3,
  prism: 4, chronos: 4, orbital: 4, phoenix: 4, hydra: 4, siren: 4, midas: 4,
  glitch: 5, bloom: 5, arcade: 5, eclipse: 5, deluge: 5, colossus: 5,
  house: 6,
};
const SKIN_IDS = Object.keys(SKINS);
const LEVELS = 34;                                           // LEVELS.length
const PITY_CAPS = { pity: 14, mythicPity: 70, transPity: 180 }; // PITY_LEG / _MYTH / _TRANS
const CHEAPEST_CRATE = 550;                                  // WOODEN CRATE

// ------------------------------------------------------------------ rates
const CRATES_PER_S = 1 / 0.95, CRATE_BURST = 3;
const COINS_PER_S = 7000, COINS_BURST = 60000;
const UNLOCK_PER_S = 0.75, UNLOCK_BURST = 2;
const BEST_PER_S = 250000, BEST_BURST = 5000000;

// ----------------------------------------------------------- absolute caps
const COINS_MAX = 1e10, COUNT_MAX = 1e6, OPENED_MAX = 1e7, BEST_MAX = 1e8;

// --------------------------------------------------------------- helpers
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** { skinId: count } with only real skins and sane counts. */
function readInv(v) {
  const o = obj(v), out = {};
  for (const id of SKIN_IDS) {
    const n = int(o[id], 0, COUNT_MAX, 0);
    if (n > 0) out[id] = n;
  }
  return out;
}

module.exports = {
  // An honest save is ~1 KB: 37 skin counts, 34 bests and a dozen scalars,
  // even with every number at its absolute cap it stays under 2 KB.
  maxBytes: 8 * 1024,

  clean(prev, next, ctx) {
    ctx = ctx || {};
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Reject("not a save");
    const p = prev && typeof prev === "object" && !Array.isArray(prev) && !ctx.first ? prev : null;
    const t = Number.isFinite(ctx.elapsedSec) ? Math.max(0, ctx.elapsedSec) : 0;
    const rc = Object.assign({}, ctx, { elapsedSec: t });

    // --- the free welcome crate: once claimed, always claimed -------------
    const prevFirst = !!(p && bool(p.firstCrate));
    const firstCrate = prevFirst || bool(next.firstCrate);
    const freeNow = firstCrate && !prevFirst ? 1 : 0;

    // --- skins ------------------------------------------------------------
    const nextInv = readInv(next.inv);
    const prevCoins = p ? int(p.coins, 0, COINS_MAX, 0) : 0;
    const coinRoom = COINS_PER_S * t + COINS_BURST;          // how far coins could rise
    let inv, newUnits = 0;
    if (!p) {
      inv = nextInv;                                         // first save: caps only
    } else {
      const prevInv = readInv(p.inv);
      // crates since the last save: bound by the reveal animation, and every
      // one past the free crate had to be paid for out of coins that existed
      const byTime = Math.floor(CRATES_PER_S * t + CRATE_BURST);
      const byCoins = Math.floor((prevCoins + coinRoom) / CHEAPEST_CRATE) + freeNow;
      let allowance = Math.min(byTime, byCoins);
      inv = Object.assign({}, prevInv);                      // nothing ever removes a skin
      const adds = SKIN_IDS
        .map((id) => [id, (nextInv[id] || 0) - (prevInv[id] || 0)])
        .filter((a) => a[1] > 0)
        .sort((a, b) => SKINS[a[0]] - SKINS[b[0]]);          // keep commons, drop the rarest
      for (const [id, extra] of adds) {
        const keep = Math.min(extra, Math.max(0, allowance));
        allowance -= keep;
        newUnits += keep;
        if (keep > 0) inv[id] = (inv[id] || 0) + keep;
      }
    }
    if (!Object.keys(inv).length) inv.pebble = 1;            // UI.init grants the starting ball

    // --- coins: may fall freely; a rise is capped, less what crates cost ---
    let coins = int(next.coins, 0, COINS_MAX, 0);
    if (p) {
      const spent = CHEAPEST_CRATE * Math.max(0, newUnits - freeNow);
      const ceiling = Math.floor(prevCoins + coinRoom - spent);
      coins = Math.max(0, Math.min(coins, ceiling));
    }

    // --- pity counters: +1 per crate, or a reset --------------------------
    const pity = {};
    for (const [k, cap] of Object.entries(PITY_CAPS)) {
      let v = int(next[k], 0, cap - 1, 0);
      if (p) v = Math.min(v, int(p[k], 0, cap - 1, 0) + newUnits);
      pity[k] = v;
    }

    // --- lifetime crate count ---------------------------------------------
    let opened = int(next.opened, 0, OPENED_MAX, 0);
    if (p) {
      const po = int(p.opened, 0, OPENED_MAX, 0);
      opened = Math.max(po, Math.min(opened, po + newUnits));
    }

    // --- levels -----------------------------------------------------------
    let unlocked = int(next.unlocked, 1, LEVELS, 1);
    if (p) unlocked = grow(int(p.unlocked, 1, LEVELS, 1), unlocked, UNLOCK_PER_S, rc, UNLOCK_BURST);

    const bestIn = obj(next.best), bestPrev = p ? obj(p.best) : {}, best = {};
    for (let i = 0; i < unlocked; i++) {
      const k = "L" + i;
      let v = int(bestIn[k], 0, BEST_MAX, 0);
      if (p) v = grow(int(bestPrev[k], 0, BEST_MAX, 0), v, BEST_PER_S, rc, BEST_BURST);
      if (v > 0) best[k] = v;
    }

    // --- equipped: must be owned -----------------------------------------
    let equipped = str(next.equipped, 16);
    if (!inv[equipped]) equipped = inv.pebble ? "pebble" : Object.keys(inv)[0];

    return {
      v: 1,
      rev: int(next.rev, 0, 2147483647, 0),
      coins, inv, equipped,
      pity: pity.pity, mythicPity: pity.mythicPity, transPity: pity.transPity,
      opened, unlocked, best, firstCrate,
    };
  },

  // Metrics with a ceiling set by the game's own timers. Not declared: coins
  // (a checkpoint balance, not a per-event count) and score (damage-based,
  // no tight ceiling — see `best` above).
  events: {
    // >= 1.38 s per clear (ball in flight + onCleared's slowed after(28)).
    levelsCleared: { perSecond: 0.75, burst: 3 },
    // <= 17 madballs in a level (TOTALITY: 11 + 3 blobs x 2 runts); an attempt
    // can be restarted at once, and PRISM's seven beams fire within 12 frames
    // of the ability, which needs >= 1 frame of flight: 17 / 14 frames = 73 / s.
    madballsPopped: { perSecond: 75, burst: 20 },
    // One reveal per >= 0.95 s (950 + rar * 320 ms).
    cratesOpened: { perSecond: 1.06, burst: 3 },
  },
};
