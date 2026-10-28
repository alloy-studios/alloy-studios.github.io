"use strict";
/**
 * PROJECT HERO (site id "project-hero") - Alloy Accounts validator.
 *
 * Save shape (index.html DEFAULT_SAVE, plus hotbar / gear / q added further down):
 *   { level, xp, coins, rank, questsDone, clawPlays, kills, tutorialDone,
 *     owned:{heroId:true}, ranks:{heroId:n}, index:{heroId:true},
 *     potions:{xp,coins,dmg}, active:{xp,coins,dmg},     potions held / seconds left
 *     settings:{low,collide,rain,shake,sens,fov},
 *     hotbar:[6 x heroId|null], gear:[{uid,type,r}], equip:[3 x uid|null],
 *     gearTokens, clawTickets, gearUid,
 *     q:{ active:{questId:{step,have,...}}, done:{questId:true}, tracked, cd:{questId:ms} } }
 *
 * Every rule below mirrors a rule the game already enforces, so an honest save
 * cannot trip one:
 *   - lifetime totals never go backwards (total XP, kills, quests done, claw
 *     plays). A save with less of any is a stale tab or device: the stored save is
 *     kept whole, and the game adopts it. Total XP rises at a rate derived below;
 *     level follows from total XP.
 *   - coins may fall freely (claws, upgrades, evolutions) and rise at a rate
 *   - rank = 1 + one per 3 quests completed (completeQuest, questEvent)
 *   - the Hero Claw is the only source of regular heroes, one per play (playClaw)
 *   - The Flash and Aoi Todo are quest rewards (barry3, todo2); an evolution
 *     needs its base hero, level 10, base rank 2 and 2,500 coins (canEvolve)
 *   - rank upgrades cost upgradeCost() coins, so rank gained since the last save
 *     must be covered by coins that could have been spent. Duplicate files give
 *     free ranks, at most one per claw play.
 *   - potions and accessories come from claw plays or a fixed few quest rewards;
 *     fusing turns two accessories into one
 *   - a quest can only be done once its prerequisites are and the player has
 *     its level (questAvail)
 *   - hotbar / equip slots only hold owned heroes / held accessories
 *
 * CLAMP, DON'T REJECT. A rejected save never replaces `prev`, so a Reject an
 * honest save can reach is a permanent, silent lockout. Reject is used only for
 * garbage: a core number that is not a finite number, or is negative. Anything
 * merely too big is clamped. Honest paths that must survive: playing offline or
 * as a guest and then signing in far ahead of the cloud save, very long
 * sessions, and saving coins up to spend them all at once.
 */
const { Reject, int, num, str, arr, grow, gain } = require("./lib");

/* ------------------------------------------------------------------------
 * The game's own tables, copied from index.html
 * ---------------------------------------------------------------------- */
const MAX_LEVEL = 50;                                   // MAX_LEVEL
const xpNeeded = (l) => Math.floor(90 + l * l * 16);    // xpNeeded
const POTION_TIME = 120;                                // POTION_TIME
const EVO_REQ = { level: 10, rank: 2, coins: 2500 };    // EVO_REQ
// upgradeCost(id) with S.ranks[id] = r: the price of going from rank r to r + 1
const upgradeCost = (r) => Math.round(250 * Math.pow(r + 1, 1.6));

// HERO_ORDER. Batman is everyone's starting hero (DEFAULT_SAVE).
const BASE_HEROES = [
  "hulk", "ironman", "loki", "venom", "strange", "batman", "superman", "cyborg",
  "beastboy", "greenlantern", "flash", "invincible", "omniman", "rexsplode",
  "monstergirl", "allen", "yuji", "maki", "mechamaru", "megumi", "gojo", "todo",
  "ichigo", "kenpachi", "byakuya", "lillebarro", "aizen",
];
const QUEST_HEROES = { flash: "barry3", todo: "todo2" };   // QDEF reward.hero
const EVOS = {                                             // EVOS
  hulk: "worldbreaker", batman: "hellbat", venom: "kinginblack", invincible: "bluesuit",
  megumi: "mahoraga", ichigo: "vastolorde", flash: "speedforce",
};
const EVO_BASE = Object.fromEntries(Object.entries(EVOS).map(([b, e]) => [e, b]));
const HEROES = [...BASE_HEROES, ...Object.values(EVOS)];
const HERO_SET = new Set(HEROES);
const isHero = (id) => HERO_SET.has(id);
// what the Hero Claw can drop: not Batman (owned from the start), not quest or evolved heroes
const CLAW_HEROES = BASE_HEROES.filter((h) => h !== "batman" && !QUEST_HEROES[h]);

const ACC = ["ring", "vest", "boots", "amulet", "watch", "coin", "specs", "fang", "lens", "jetpack"];
const POTIONS = ["xp", "coins", "dmg"];

// QDEF: id -> [lvl, req]
const QUESTS = {
  main1: [1, []], main2: [1, ["main1"]], main3: [2, ["main2"]], main4: [3, ["main3"]],
  main5: [4, ["main4"]], main6: [5, ["main5"]], main7: [6, ["main6"]], main8: [9, ["main7"]],
  main9: [11, ["main8"]], main10: [13, ["main9"]], main11: [15, ["main10"]],
  contract: [1, ["main11"]],
  barry1: [3, ["main4"]], barry2: [3, ["barry1"]], barry3: [5, ["barry2"]],
  todo1: [6, ["main7"]], todo2: [7, ["todo1"]],
  joe1: [4, ["main5"]], joe2: [4, ["joe1"]],
  jen1: [6, ["main5"]], jen2: [8, ["jen1"]],
  dusty1: [9, ["main8"]],
  bounty: [1, ["main2"]], press: [4, ["main6"]],
};
const REPEAT = new Set(["contract", "bounty", "press"]);   // repeat: true
const QUEST_GEAR = 9;      // quests with reward.gear: main3 main5 main8 main9 main10 main11 joe2 jen1 dusty1
const QUEST_POTIONS = 3;   // quests with reward.potion: main5 barry2 joe1
// One-time quests: id -> [reward.coins, reward.xp, boss coins, boss xp] (EDEF of the
// step's boss: cursedwomb, raiderking, viltelite, espada, rifttitan, alphawolf, todoboss)
const ONE_TIME = {
  main1: [250, 0, 0, 0], main2: [300, 250, 0, 0], main3: [400, 350, 0, 0], main4: [300, 400, 0, 0],
  main5: [500, 600, 0, 0], main6: [600, 800, 0, 0], main7: [700, 1000, 150, 420],
  main8: [900, 1400, 180, 460], main9: [1100, 1800, 210, 540], main10: [1300, 2400, 230, 620],
  main11: [3000, 5000, 650, 1600],
  barry1: [400, 500, 0, 0], barry2: [500, 600, 0, 0], barry3: [600, 800, 160, 400],
  todo1: [500, 700, 0, 0], todo2: [700, 900, 0, 300],
  joe1: [450, 500, 0, 0], joe2: [500, 600, 0, 0], jen1: [450, 600, 0, 0], jen2: [600, 800, 0, 0],
  dusty1: [700, 900, 0, 0],
};

/* ------------------------------------------------------------------------
 * Absolute ceilings. Only the first cloud save leans on these; after that the
 * rates below are the real bound. Generous on purpose.
 * ---------------------------------------------------------------------- */
const MAX_COINS = 1e12;
const MAX_COUNT = 1e9;      // kills, questsDone, clawPlays
const MAX_RANK = 1000;      // the shop has no cap; rank 1000 costs ~4e8 coins on its own
const MAX_TOKENS = 1e6;
const MAX_GEAR = 1500;      // ~50 KB of accessories; the game never trims the list itself

/*
 * RATES - derived from index.html, not from feel. All times are real seconds:
 * every timer below runs on the frame clock, so a slower frame only slows it.
 *
 * Enemy level. updateSpawner and updateEncounters use
 *   lvl = clamp(max(Z.min + randi(0, 2), S.level + randi(-1, 1)), 1, 60)
 * and the highest Z.min is 12 (Seireitei, Viltrumite Warzone), so lvl <= max(14, L + 1).
 * Quest spawns use clamp(L, ql, ql + 3) or max(L, ql), and a quest is only
 * accepted at L >= ql (questAvail), so they are <= L.
 *   => lvlMax(L) = min(60, max(14, L + 1)) for a player at level L.
 *
 * Kills. These are the only things that create enemies:
 *   updateSpawner: a tick every 1.2 s adds at most 4 (randi(2, 4))   3.33 / s
 *   defend waves: the next wave waits until the last is dead, then
 *     a.gap = 3 s, and a wave is at most 6 enemies                    2.00 / s
 *   updateEncounters: encT = rand(45, 80) -> one per >= 45 s, and an
 *     encounter is at most 5 (vehicle + 4 crew, rift 4, pod 3)       0.11 / s
 *   'vehicle' quest steps: a.spawnT = 30 -> one encounter per 30 s    0.17 / s
 *   bounty / contract bosses: repeat cooldown 20 s (S.q.cd), 1 each   0.10 / s
 *   story spawns (crates, bosses, the training garage): one-off, so they go in
 *   the burst, not the rate
 *   => KPS = 5.71 enemies per second at most.
 *
 * Multipliers. gainCoins / gainXP: x2 while that potion runs, x(1 + gearStat).
 * gearStat sums the 3 equip slots, Lucky Coin / Scholar Specs give 60% at
 * Legendary, and nothing stops all three slots holding the same accessory.
 *   => MULT = 2 x (1 + 3 x 0.6) = 5.6
 *
 * Coins per second at level L (cm = 1 + (lvlMax - 1) x 0.1, onEnemyKilled):
 *   spawner + wave kills   5.33 x (42 cm + 8)   42 = Hollow / Viltrumite, the richest
 *                                               regular enemy; +8 is dropCoins and
 *                                               gainCoins rounding, 8 coins at most
 *   encounters             (125 cm + 40) per encounter, (1/45 + 1/30) per s
 *                                               125 = gunship 80 + 3 Flaxan 15
 *   repeat bosses          0.1 x (30 cm + 8)     a brute, the richest bounty target
 *   bounty board           3 slots, each pays n x 12 x (1 + 0.15 L) (+60 brute/traffic)
 *                          for n events and is replaced 2.5 s after it completes.
 *                          The richest per second is 'zone', n = 14:
 *                          3 x 168 m / (2.5 + 14 / KPS)    with m = 1 + 0.15 L
 *   muggings               (40 + 6 L) per encounter, at most one per 45 s
 *   repeatable quests      contract 600 + bounty 350 + press 380 per 20 s cooldown
 *   all of it x MULT.       L = 1: ~4,800 / s     L = 50: ~13,200 / s
 *
 * XP per second, the same sources (xm = 1 + (lvlMax - 1) x 0.12):
 *   spawner + wave kills   5.33 x (120 xm + 1)   120 = Hollow / Viltrumite; +1 rounding
 *   encounters             (312 xm + 5) per encounter    gunship 180 + 3 Flaxan 44
 *   repeat bosses          0.1 x (80 xm + 1)
 *   bounty board           3 x 14 x 22 m / (2.5 + 14 / KPS)
 *   muggings               (60 + 8 L) / 45
 *   repeatable quests      900 + 400 + 450 per 20 s
 *   all of it x MULT.       L = 1: ~13,000 / s     L = 50: ~35,500 / s
 * The XP rate grows with level, so the ceiling is walked level by level, each
 * level at its own rate (maxTotal), not the final level's rate for the whole time.
 *
 * Burst, the one-off income a save can bank on top of the rate - only what the
 * stored save has not had yet (oneOff):
 *   every one-time quest not done yet: its reward, plus its boss (ONE_TIME;
 *     spawnBoss caps a story boss at quest lvl + 3 <= 18)
 *   the hero index: +100 for each hero not transformed into yet
 *   the tutorial's 200 coins (paid unmultiplied), if not done yet
 *   a full field of 30 live enemies at the stored level
 *   all of it x MULT.
 *
 * Counters:
 *   kills       KPS, burst 30 live enemies + ~60 one-off story spawns      -> 5.8 / s, 90
 *   questsDone  bounty board: a slot completes at most once per
 *               2.5 + 1 / KPS s (brute, n = 1) -> 3 / 2.68 = 1.12 / s,
 *               repeatables 3 per 20 s -> 0.15 / s; burst 21 one-time
 *               quests + 3 board slots                                       -> 1.3 / s, 24
 *   clawPlays   2 machines, each locked while its claw runs (m.state):
 *               descend + grab 0.5 s + lift + drop 0.45 s >= 2 s            -> 1 / s, 2
 *   gearTokens  bounty and contract pay 1 each per 20 s cooldown; burst the
 *               one-time 8 (main1 1, main9 2, main11 3, jen2 2) + 2         -> 0.1 / s, 10
 *   clawTickets only main6 gives one, ever                                  -> 0 or 1
 */
const KPS = 4 / 1.2 + 6 / 3 + 5 / 45 + 5 / 30 + 2 / 20;
const MULT = 2 * (1 + 3 * 0.6);
const ENC_PER_SEC = 1 / 45 + 1 / 30;
const BOARD_CYCLE = 2.5 + 14 / KPS;
const LIVE = 30;
const lvlMax = (L) => Math.min(60, Math.max(14, L + 1));
const coinMul = (lv) => 1 + (lv - 1) * 0.1;    // onEnemyKilled: def.coins x this
const xpMul = (lv) => 1 + (lv - 1) * 0.12;     //                def.xp x this

/** Most coins and XP per second a player at level L can earn. */
function rates(L) {
  const lv = lvlMax(L), cm = coinMul(lv), xm = xpMul(lv), m = 1 + 0.15 * L;
  return {
    coins: MULT * (
      (4 / 1.2 + 6 / 3) * (42 * cm + 8) +
      (125 * cm + 40) * ENC_PER_SEC +
      0.1 * (30 * cm + 8) +
      3 * 168 * m / BOARD_CYCLE +
      (40 + 6 * L) / 45 +
      (600 + 350 + 380) / 20),
    xp: MULT * (
      (4 / 1.2 + 6 / 3) * (120 * xm + 1) +
      (312 * xm + 5) * ENC_PER_SEC +
      0.1 * (80 * xm + 1) +
      3 * 14 * 22 * m / BOARD_CYCLE +
      (60 + 8 * L) / 45 +
      (900 + 400 + 450) / 20),
  };
}

/** One-off income still open to a player whose stored save is P (see Burst above). */
function oneOff(P) {
  const lv = lvlMax(int(P.level, 1, MAX_LEVEL, 1)), done = obj(obj(P.q).done), index = obj(P.index);
  const bcm = coinMul(18), bxm = xpMul(18);
  let coins = 100 * BASE_HEROES.filter((h) => index[h] !== true).length, xp = 0;
  for (const id of Object.keys(ONE_TIME)) {
    if (done[id] === true) continue;
    const [c, x, bc, bx] = ONE_TIME[id];
    coins += c + bc * bcm;
    xp += x + bx * bxm;
  }
  coins += LIVE * (42 * coinMul(lv) + 8);
  xp += LIVE * (120 * xpMul(lv) + 1);
  return { coins: MULT * coins + (P.tutorialDone === true ? 0 : 200), xp: MULT * xp };
}
const RATE = {
  kills: [5.8, 90],
  questsDone: [1.3, 24],
  clawPlays: [1, 2],
  gearTokens: [0.1, 10],
};

/* ------------------------------------------------------------------------
 * The level curve and cumulative XP to reach a level
 * ---------------------------------------------------------------------- */
const CUM = [0, 0]; // CUM[L] = XP spent getting from level 1 to level L
function cumTo(level) {
  while (CUM.length <= level) {
    const l = CUM.length - 1;
    CUM.push(CUM[l] + xpNeeded(l));
  }
  return CUM[level];
}
/** Highest level whose cumulative XP is <= total. */
function levelFor(total) {
  let lv = 1;
  while (lv < MAX_LEVEL && cumTo(lv + 1) <= total) lv++;
  return lv;
}

/* ------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
/** Finite, non-negative number or null (garbage). */
function nonneg(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
/** A set of ids saved as {id: true}, kept to the ids `keep` allows, in the order given. */
function idSet(v, ids, keep) {
  const src = obj(v), out = {};
  for (const id of ids) if (src[id] === true && keep(id)) out[id] = true;
  return out;
}

/**
 * The most total XP reachable from `total` in `t` seconds, earning at the full
 * rate of whichever level is held at each moment.
 */
function maxTotal(total, t) {
  let level = levelFor(total);
  while (t > 0) {
    const r = rates(level).xp;
    if (level >= MAX_LEVEL) return total + r * t;
    const need = cumTo(level + 1) - total, dt = need / r;
    if (dt >= t) return total + r * t;
    total += need; t -= dt; level++;
  }
  return total;
}

/** Total coins of going from rank `from` to rank `to`, each step at upgradeCost. */
function rankCosts(from, to) {
  const out = [];
  for (let r = from; r < to; r++) out.push(upgradeCost(r));
  return out;
}

/** Active quest state is client-shaped: copy the fields the game writes, each by type. */
function cleanActive(a) {
  a = obj(a);
  const out = {};
  const ints = { step: 20, have: 1000, cp: 100 };
  for (const k of Object.keys(ints)) if (has(a, k)) out[k] = int(a[k], 0, ints[k], 0);
  for (const k of ["gap", "left", "spawnT"]) if (has(a, k)) out[k] = num(a[k], -1e6, 1e6, 0);
  if (has(a, "wave")) out.wave = a.wave === null ? null : int(a.wave, 0, 50, 0);
  for (const k of ["pending", "run"]) if (has(a, k)) out[k] = a[k] === true;
  for (const k of ["got", "broke", "herded"]) if (has(a, k)) out[k] = arr(a[k], 16, (x) => x === true);
  if (has(a, "dest")) out.dest = arr(a.dest, 2, (x) => num(x, -1e4, 1e4, 0));
  if (has(a, "steps")) out.steps = arr(a.steps, 8, cleanStep);
  return out;
}
/** A generated quest step (bounty / contract gen): only plain fields, bounded. */
function cleanStep(s) {
  s = obj(s);
  const out = {};
  const strs = { type: 16, text: 160, zone: 16, npc: 16, boss: 24, elite: 48 };
  for (const k of Object.keys(strs)) if (typeof s[k] === "string") out[k] = str(s[k], strs[k]);
  if (has(s, "n")) out.n = int(s.n, 0, 100, 0);
  if (has(s, "at")) out.at = arr(s.at, 2, (x) => num(x, -1e4, 1e4, 0));
  if (has(s, "lines")) out.lines = arr(s.lines, 8, (x) => str(x, 240));
  return out;
}

module.exports = {
  maxBytes: 64 * 1024,

  clean(prev, d, ctx) {
    ctx = ctx || {};
    if (!d || typeof d !== "object" || Array.isArray(d)) throw new Reject("not an object");

    // --- garbage check on the core numbers; everything else only clamps ---
    const raw = { level: nonneg(d.level), xp: nonneg(d.xp), coins: nonneg(d.coins) };
    for (const k of Object.keys(raw)) if (raw[k] === null) throw new Reject("bad " + k);

    const t = Number.isFinite(ctx.elapsedSec) && ctx.elapsedSec > 0 ? ctx.elapsedSec : 0;
    const P = prev && typeof prev === "object" && !ctx.first ? prev : null;
    const rctx = Object.assign({}, ctx, { elapsedSec: t });

    // --- level + XP ---
    let level = Math.min(MAX_LEVEL, Math.max(1, Math.floor(raw.level)));
    // after gainXP's loop xp < xpNeeded(level); at the level cap gainXP stops adding,
    // so whatever was left over from the last level-up stays
    let xp = Math.floor(Math.min(raw.xp, level < MAX_LEVEL ? xpNeeded(level) - 1 : 1e7));

    // Lifetime totals never go down in play: total XP, kills, quests done, claw
    // plays (XP alone stops at the level cap). If any is lower, the whole save is
    // old (a second tab, a device that was offline). Keep what we hold - all of
    // it, or its stale coins would clamp the up-to-date tab's next save. The game
    // adopts the reply, which brings the old tab up to date. `prev` was cleaned
    // when it was stored, so this pass returns it unchanged.
    const burst = P ? oneOff(P) : null;
    if (P) {
      const pLevel = int(P.level, 1, MAX_LEVEL, 1);
      const prevTotal = cumTo(pLevel) + (Number(P.xp) || 0);
      const older = cumTo(level) + xp < prevTotal ||
        ["kills", "questsDone", "clawPlays"].some((k) => int(d[k], 0, MAX_COUNT, 0) < int(P[k], 0, MAX_COUNT, 0));
      if (older) return module.exports.clean(null, P, { first: true });
      // the one-off XP is banked first: reaching a level sooner only raises the rate after it
      const cap = Math.floor(maxTotal(prevTotal + burst.xp, t));
      if (cumTo(level) + xp > cap) {
        level = levelFor(cap);
        xp = cap - cumTo(level);
        if (level < MAX_LEVEL) xp = Math.min(xp, xpNeeded(level) - 1);
      }
    }

    // --- coins: spendable balance, at the rate of the highest level reached ---
    let coins = Math.min(MAX_COINS, Math.floor(raw.coins));
    let spendable = Infinity;   // coins that could have been spent since prev
    if (P && Number.isFinite(Number(P.coins))) {
      const pc = Number(P.coins), rate = rates(level).coins;
      coins = Math.floor(gain(pc, coins, rate, rctx, burst.coins));
      spendable = Math.max(0, pc + rate * t + burst.coins - coins);
    }

    // --- counters that only go up ---
    const counter = (k) => {
      const v = int(d[k], 0, MAX_COUNT, 0);
      return P ? grow(int(P[k], 0, MAX_COUNT, 0), v, RATE[k][0], rctx, RATE[k][1]) : v;
    };
    const kills = counter("kills");
    const questsDone = counter("questsDone");
    const clawPlays = counter("clawPlays");
    const rank = int(d.rank, 1, 1 + Math.floor(questsDone / 3), 1);

    // --- quests: done needs the prerequisites done and the quest's level (questAvail) ---
    const qd = obj(obj(d.q).done), done = {};
    for (const id of Object.keys(QUESTS)) {
      const [lvl, req] = QUESTS[id];
      if (qd[id] === true && level >= lvl && req.every((r) => done[r])) done[id] = true;
    }
    const qa = obj(obj(d.q).active), active = {};
    for (const id of Object.keys(QUESTS)) {
      const [lvl, req] = QUESTS[id];
      if (!has(qa, id) || (done[id] && !REPEAT.has(id))) continue;
      if (level >= lvl && req.every((r) => done[r])) active[id] = cleanActive(qa[id]);
    }
    const qcd = obj(obj(d.q).cd), cd = {};
    for (const id of REPEAT) if (has(qcd, id)) cd[id] = num(qcd[id], 0, 1e14, 0);
    const tracked = has(active, d.q && d.q.tracked) ? d.q.tracked : null;

    // --- heroes ---
    // Batman from the start; claw heroes one per play; quest heroes from their quests;
    // an evolution from its base, at level 10 and base rank 2 (canEvolve)
    const rawRanks = obj(d.ranks);
    let clawLeft = clawPlays;
    const owned = idSet(d.owned, HEROES, (id) => {
      if (id === "batman") return true;
      if (QUEST_HEROES[id]) return !!done[QUEST_HEROES[id]];
      if (EVO_BASE[id]) return false;   // decided below, once the bases are known
      return clawLeft-- > 0;
    });
    owned.batman = true;
    const ownedEvo = obj(d.owned);
    for (const [base, evo] of Object.entries(EVOS)) {
      if (ownedEvo[evo] === true && owned[base] && level >= EVO_REQ.level && int(rawRanks[base], 0, MAX_RANK, 0) >= EVO_REQ.rank) owned[evo] = true;
    }

    // --- rank upgrades and evolutions are paid for in coins ---
    let ranks = {};
    for (const id of HEROES) if (owned[id] && has(rawRanks, id)) ranks[id] = int(rawRanks[id], 0, MAX_RANK, 0);
    if (P && Number.isFinite(spendable)) {
      const pOwned = obj(P.owned), pRanks = obj(P.ranks);
      // evolutions first: each one new since prev costs EVO_REQ.coins
      for (const evo of Object.values(EVOS)) {
        if (!owned[evo] || pOwned[evo] === true) continue;
        if (spendable >= EVO_REQ.coins) spendable -= EVO_REQ.coins;
        else { delete owned[evo]; delete ranks[evo]; }
      }
      // then every rank gained since prev, step by step. Duplicate files (at most one
      // per claw play since prev) are free; spend them on the dearest steps.
      const steps = [];
      for (const id of Object.keys(ranks)) {
        let from = int(pRanks[id], 0, MAX_RANK, 0);
        // evolveHero copies the base's rank onto the new hero
        if (EVO_BASE[id] && pOwned[id] !== true) {
          const b = EVO_BASE[id];
          from = Math.min(ranks[id], Math.max(int(pRanks[b], 0, MAX_RANK, 0), ranks[b] || 0));
        }
        steps.push(...rankCosts(from, ranks[id]));
      }
      steps.sort((a, b) => b - a);
      const free = Math.max(0, clawPlays - int(P.clawPlays, 0, MAX_COUNT, 0));
      const cost = steps.slice(free).reduce((s, c) => s + c, 0);
      // over budget can only be a forged save: keep the ranks held before it
      if (cost > spendable) {
        const back = {};
        for (const id of Object.keys(ranks)) if (has(pRanks, id)) back[id] = int(pRanks[id], 0, MAX_RANK, 0);
        ranks = back;
      }
    }

    const index = idSet(d.index, HEROES, (id) => !!owned[id]);
    const hotbar = [0, 1, 2, 3, 4, 5].map((i) => {
      const h = Array.isArray(d.hotbar) ? d.hotbar[i] : null;
      return isHero(h) && owned[h] ? h : null;
    });

    // --- potions: each came from a gear-claw play or one of the quest rewards ---
    const potionCap = clawPlays + QUEST_POTIONS;
    const rp = obj(d.potions), ra = obj(d.active);
    const potions = {}, act = {};
    for (const k of POTIONS) potions[k] = int(rp[k], 0, potionCap, 0);
    for (let over = POTIONS.reduce((s, k) => s + potions[k], 0) - potionCap; over > 0; over--) {
      const k = POTIONS.reduce((a, b) => (potions[b] > potions[a] ? b : a));
      potions[k]--;
    }
    // drinking adds POTION_TIME per potion, and every potion drunk was obtained
    for (const k of POTIONS) act[k] = num(ra[k], 0, POTION_TIME * potionCap, 0);

    // --- accessories: from gear-claw plays or quest rewards; fusing makes 2 into 1 ---
    const seen = new Set();
    const gear = arr(d.gear, MAX_GEAR, (g) => {
      g = obj(g);
      const uid = int(g.uid, 1, 1e7, 0);
      if (!uid || seen.has(uid) || !ACC.includes(g.type)) return null;
      seen.add(uid);
      return { uid, type: g.type, r: int(g.r, 0, 4, 0) };
    }).filter(Boolean).slice(0, clawPlays + QUEST_GEAR);
    const uids = new Set(gear.map((g) => g.uid));
    const equip = [0, 1, 2].map((i) => {
      const u = Array.isArray(d.equip) ? d.equip[i] : null;
      return uids.has(u) ? u : null;
    });
    for (let i = 1; i < 3; i++) if (equip[i] !== null && equip.indexOf(equip[i]) < i) equip[i] = null;
    const gearUid = int(d.gearUid, Math.max(1, ...gear.map((g) => g.uid + 1)), 1e7 + 1);

    const tokens = int(d.gearTokens, 0, MAX_TOKENS, 0);
    const gearTokens = P ? gain(int(P.gearTokens, 0, MAX_TOKENS, 0), tokens, RATE.gearTokens[0], rctx, RATE.gearTokens[1]) : tokens;
    const clawTickets = done.main6 ? int(d.clawTickets, 0, 1, 0) : 0;

    // --- settings: the System tab's own ranges ---
    const rs = obj(d.settings);
    const settings = {
      low: rs.low === true,
      collide: rs.collide !== false,
      rain: rs.rain !== false,
      shake: rs.shake !== false,
      sens: num(rs.sens, 0.2, 3, 1),
      fov: num(rs.fov, 65, 110, 85),
    };

    return {
      level, xp, coins, rank, questsDone, clawPlays,
      owned, ranks, index,
      potions, active: act,
      tutorialDone: d.tutorialDone === true,
      kills,
      settings,
      hotbar, gear, equip, gearTokens, clawTickets, gearUid,
      q: { active, done, tracked, cd },
    };
  },

  /*
   * No event metrics yet: the game doesn't report any. `kills` has an honest
   * ceiling (spawn-bound, see RATES: 5.8 / s, burst 90) and can be declared as
   *   kills: { perSecond: 5.8, burst: 90 },
   * once the game calls AA.progress for it.
   * NOT declarable: coins and XP. They are bounded per second, but the bound
   * grows with level, so an event on them would favour whoever grinds the
   * highest sector rather than measure anything fair.
   */
  events: {},
};
