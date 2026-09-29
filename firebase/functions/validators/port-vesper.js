"use strict";
/**
 * Port Vesper - Alloy Accounts validator.   (game: port-vesper.html, id "port-vesper")
 *
 * Every rate below is derived from the game's own constants, with the working
 * shown, so an honest save is never clamped. Source parts are in the game repo
 * under .build/parts/ (the shipped port-vesper.html is those parts concatenated).
 *
 * SPEED CEILING, used by several rates. The fastest thing in the game is a
 * Vela Spyder (CARS.hyper, top 600) with engine upgrade 3 (carTop: x1.27) under
 * nitrous (driveCar: x1.30) = 990.6 world units per second. Nothing pushes a car
 * faster: collisions and explosions only take speed away.
 *
 * MONEY - the fastest honest earner is the chop shop (chopShop):
 *     pay = price * 0.42 * condition(<= 0.95) * want-list mult(<= 2.0) * Ray perk(1.35)
 *         = price * 1.0773 at most, and only for a car the player does NOT own.
 *   Cars that can be stolen without a bar tip are the CIVIL / gang set; the best is
 *   the Comet GT (sport, $52,000) => $56,020 a car. Each sale needs a different
 *   vehicle driven into range, a menu opened, a car entered: >= ~2 s a cycle even
 *   with parked cars lined up at the door => <= 28,010 / s.
 *   The Vela Spyder ($165,000 => $177,754) only comes from a bar tip, which the game
 *   allows once per 60 s (tipWait) => <= 2,963 / s on top.
 *   Everything else is far slower: vault $9,400 per >= 6.3 s hold then 220 s
 *   cooldown; contracts are one-off (largest $42,000 + <= $840 time bonus); drift
 *   pays <= $600 a bank; property pays <= $14,240 a sleep, one sleep per >= 378 s.
 *     => 32,000 / s.  Burst 250,000 covers one-off lumps landing inside one save
 *        window: a tipped Spyder 177,754 + the largest contract 42,840 + a vault
 *        9,400 + a night's property 14,240 = 244,234.
 *   Three honest loops would have broken this bound, so the game was changed with
 *   this validator: sleep only in daytime (was free to spam, paying property each
 *   click), one bar tip per minute (was farmable), and an OWNED car sells at the
 *   resale rate (a bought Spyder used to chop for more than it cost).
 *
 * RESPECT - the fastest source is the bar's "buy the room a round": +2 per click,
 *   and the panel closes on each click, so a round costs two inputs => <= ~3 / s,
 *   6 respect / s. Other sources are per event (+3 contract, +1 robbery or odd job,
 *   +0.5 per gang kill or per unlisted chop, +0.25 per drift, +2 per property,
 *   +4 finishing Ray). A grenade can drop a whole wipe squad (<= 10) at once.
 *     => 8 / s, burst 40.
 *
 * CONTRACT PROGRESS - a contract ends at the earliest when a delivery lands. Its
 *   drop point is > 900 units away when accepted (acceptContract: shops.filter(far))
 *   and completes within 66: >= 834 / 990.6 = 0.84 s. Freelance deliveries (> 800,
 *   so >= 0.74 s) set the jobs event below.
 *     => 1.2 contracts / s per contact, burst 2.
 *
 * DRIFT - scoreDrift adds speed * slip * dt * 1.6 with slip <= pi/2, so the raw
 *   score grows <= 990.6 * 1.571 * 1.6 = 2,490 / s; banked points are score * mult,
 *   mult = 1 + score/850 capped at 6. d(pts)/dt peaks just before the cap at
 *   2,490 * (1 + 2*4250/850) = 27,390 / s.  => bestDrift rises <= 28,000 / s.
 *
 * NIGHTS - +1 per sleep, one sleep per >= 378 s (see money). => 1/377 per s, burst 2.
 *
 * KILLS - automatic fire kills <= ~5 civilians a second (rifle 0.105 s, 2 shots
 *   each); a grenade or a car blast kills everything within 132-140 units, and the
 *   streamed crowd is <= 52 civilians plus cops and gang. => 12 / s, burst 120.
 * STOLEN - enterCar counts any non-owned car; entering and leaving are two
 *   keypresses. => 6 / s, burst 20.   CRIMES - a stat, several per action.
 *   => 30 / s, burst 200.
 * AMMO - bought with money; the most rounds per dollar is 9mm at the gun shop, 30
 *   for $74 = 0.405 / $, so any type rises <= 0.41 * 32,000 = 13,120 / s.
 *
 * NEW NIGHT resets everything, so every counter uses gain(): free to fall, only
 * rate-limited when rising. Nothing here is grow().
 *
 * CLAMP, DON'T REJECT. Reject fires only for data no build of the game produces:
 * a save that is not an object, or money / respect that is not a finite
 * non-negative number. Everything merely too big is clamped. A reachable Reject
 * would be a permanent, silent lockout (see speed-simulator.js).
 *
 * `seq` is echoed untouched: the game tags each payload with it so it can tell
 * which payload a coalesced reply answers, and adopt clamps as a difference
 * instead of rolling back progress made while the save was in flight.
 */
const { Reject, int, num, bool, gain } = require("./lib");

const WORLD = 7000;                         // WORLD_W 6857, WORLD_H 6586
const MONEY_MAX = 1e10;

// 03_data.js WEAPONS, in index order: the save stores indices.
const WEAPON_IDS = ["fist", "bat", "pistol", "smg", "shotgun", "rifle", "nade", "molo"];
const CLIP = { fist: 0, bat: 0, pistol: 15, smg: 34, shotgun: 7, rifle: 30, nade: 1, molo: 1 };
const AMMO = ["pistol", "smg", "shell", "rifle", "nade", "molo"];
// 03_data.js CONTACTS: jobs per chain. A finished chain is what grants the perk.
const CHAIN = { ray: 5, mira: 5, duke: 5, odessa: 4 };
const BUYABLE = ["spray", "chop", "diner", "club"];     // PROPERTY; lockup is always owned
const FACTIONS = ["kessler", "dockmen", "vela"];

const RATE = {
  money: 32000, moneyBurst: 250000,
  respect: 8, respectBurst: 40,
  contract: 1.2, contractBurst: 2,
  drift: 28000, driftBurst: 30000,
  nights: 1 / 377, nightsBurst: 2,
  kills: 12, killsBurst: 120,
  stolen: 6, stolenBurst: 20,
  crimes: 30, crimesBurst: 200,
  ammo: 13120, ammoBurst: 3000,
};

/** A core number: finite and non-negative, or the save is garbage. */
function core(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Reject("bad " + name);
  return n;
}
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

module.exports = {
  // A full save is ~650 bytes and every field is fixed-size (no list grows with
  // play time), so a long-time player's save is the same size as a new one.
  maxBytes: 4 * 1024,

  clean(prev, next, ctx) {
    ctx = ctx || {};
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Reject("not a save");
    const p = prev && typeof prev === "object" ? prev : null;
    const rated = !!p && !ctx.first;
    const t = Number.isFinite(ctx.elapsedSec) ? Math.max(0, ctx.elapsedSec) : 0;
    const rc = Object.assign({}, ctx, { elapsedSec: t });
    const up = (key, v, lo, hi, per, burst, from) => {
      if (!rated) return v;
      const src = from || p;
      return gain(int(src[key], lo, hi, lo), v, per, rc, burst);
    };

    // --- money: spendable; falls freely, rises no faster than the chop shop pays ---
    let money = Math.min(Math.floor(core(next.money, "money")), MONEY_MAX);
    if (rated) money = gain(int(p.money, 0, MONEY_MAX, 0), money, RATE.money, rc, RATE.moneyBurst);

    // --- respect: never spent, but NEW NIGHT resets it, so gain() not grow() ---
    let respect = Math.min(core(next.respect, "respect"), 1e7);
    if (rated) respect = gain(num(p.respect, 0, 1e7, 0), respect, RATE.respect, rc, RATE.respectBurst);

    // --- contract chains; perks and the granted properties follow from them ---
    const progIn = obj(next.progress), progPrev = obj(p && p.progress), progress = {};
    for (const c of Object.keys(CHAIN)) {
      progress[c] = up(c, int(progIn[c], 0, CHAIN[c], 0), 0, CHAIN[c],
                       RATE.contract, RATE.contractBurst, progPrev);
    }
    const perks = {};
    for (const c of Object.keys(CHAIN)) if (progress[c] >= CHAIN[c]) perks[c] = true;

    const propIn = obj(next.props), props = { lockup: true };
    for (const k of BUYABLE) if (bool(propIn[k])) props[k] = true;
    if (perks.odessa) props.club = true;          // Odessa's chain hands you the club
    if (perks.duke) props.docks = true;           // Duke's chain is the ONLY way to own the docks

    // --- body ---
    const maxhp = int(next.maxhp, 100, 150, 100);  // painkillers: +10 each, 150 max
    const hp = num(next.hp, 0, maxhp, maxhp);
    const armor = num(next.armor, 0, 100, 0);

    // --- arms: indices into WEAPONS; fists are always owned ---
    // Drop anything that is not a real index BEFORE deduping, so one bad entry
    // costs nothing.
    const ownedIn = Array.isArray(next.owned) ? next.owned.slice(0, 32) : [];
    const owned = [...new Set([0].concat(ownedIn.filter(
      (i) => Number.isInteger(i) && i >= 0 && i < WEAPON_IDS.length)))].sort((a, b) => a - b);
    const wep = owned.includes(next.wep) ? next.wep : owned[owned.length - 1];
    const magIn = obj(next.mag), mag = {};
    for (const id of WEAPON_IDS) mag[id] = int(magIn[id], 0, CLIP[id], 0);
    const ammoIn = obj(next.ammo), ammoPrev = obj(p && p.ammo), ammo = {};
    for (const k of AMMO)
      ammo[k] = up(k, int(ammoIn[k], 0, 1e7, 0), 0, 1e7, RATE.ammo, RATE.ammoBurst, ammoPrev);

    // --- the city's grudges ---
    const hosIn = obj(next.hostility), hostility = {};
    for (const k of FACTIONS) hostility[k] = num(hosIn[k], 0, 1, 0);

    return {
      v: 1,
      money, respect,
      hp, maxhp, armor,
      owned, wep, mag, ammo,
      props, perks, progress, hostility,
      kills:     up("kills",     int(next.kills, 0, 1e9, 0),     0, 1e9, RATE.kills,  RATE.killsBurst),
      stolen:    up("stolen",    int(next.stolen, 0, 1e9, 0),    0, 1e9, RATE.stolen, RATE.stolenBurst),
      crimes:    up("crimes",    int(next.crimes, 0, 1e9, 0),    0, 1e9, RATE.crimes, RATE.crimesBurst),
      bestDrift: up("bestDrift", int(next.bestDrift, 0, 1e10, 0), 0, 1e10, RATE.drift, RATE.driftBurst),
      nights:    up("nights",    int(next.nights, 1, 1e6, 1),    1, 1e6, RATE.nights, RATE.nightsBurst),
      tipAt: num(next.tipAt, 0, 1e13, 0),        // epoch ms of the last bar tip
      x: num(next.x, 0, WORLD, 3000), y: num(next.y, 0, WORLD, 3000),
      time: num(next.time, 0, 1440, 1260),       // minutes past midnight
      seq: int(next.seq, 0, 2147483647, 0),
    };
  },

  // Only metrics with a physical ceiling from the code (derivations above).
  // Not declared: money, respect, kills - explosions and the chop shop give them no
  // honest per-second maximum worth publishing to an event.
  events: {
    jobs:        { perSecond: 1.4,   burst: 2 },      // any paid job: >= 0.74 s each
    robberies:   { perSecond: 0.32,  burst: 1 },      // shortest hold: 4.6 s x 0.7 = 3.22 s
    driftPoints: { perSecond: 28000, burst: 30000 },  // banked style points, see DRIFT
  },
};
