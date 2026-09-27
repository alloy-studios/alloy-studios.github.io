"use strict";
/**
 * Neon Speed Simulator - Alloy Accounts validator.
 *
 * Starts from the rule-for-rule port of the original saveProgress Cloud Function
 * (protected/functions/index.js) and keeps its bounds:
 *   - every field bounded, malformed numbers rejected
 *   - prestige never goes backwards
 *   - prestige rise bounded - the old crude "+50 per save" is replaced by a real
 *     time-based rate, and survives only as the fallback if that rate is off
 * and adds the checks the game's own code makes provable, each mirroring a rule
 * the game already enforces, so an honest save can never trip one:
 *   - prestige rises at most 1 per 9.5 s of server time (see RATES)
 *   - equipped skin must be one this save has actually unlocked (skinUnlocked)
 *   - secretSkins limited to the real secret ids, de-duplicated
 *   - each upgrade level <= baseMaxLevel + prestiges (the shop's own cap)
 *
 * CLAMP, DON'T REJECT. Only garbage (non-numbers, negatives) is rejected. A value
 * that is merely too big is clamped to its bound. This matters more than it looks:
 * a rejected save never replaces `prev`, so the game keeps sending the same data
 * and is rejected again, forever. Any Reject an honest save can reach is a
 * permanent, silent lockout - the player still sees "SAVED AS ...". The original
 * saveProgress rejected over-cap numbers and +50 prestige jumps; neither rejects
 * now. That gives a cheater nothing new - sending exactly the cap was always
 * accepted - and it removes two honest lockouts: a player who plays offline, or
 * as a guest, and then signs in more than 50 prestiges ahead of their cloud save.
 *
 * The +50 is gone entirely while the rate is on. It was a time-less stand-in for a
 * rate limit, and next to grow() it was only ever the TIGHTER bound for honest
 * catch-up: 30 min offline allows ~190 prestiges by rate but 50 by the clamp, and
 * the game adopts the server's reply, so the player would lose the rest for good.
 * It bounded nothing a cheater cares about either - saves are allowed every few
 * seconds, so +50 per save is unbounded over time. grow() is the real bound.
 *
 * The save shape is UNCHANGED from the legacy users/{uid} document - the same 12
 * fields - so saves the site mirrored across before the switch load as they are.
 */
const { Reject, grow, owns } = require("./lib");

const LIMITS = { prestiges: 100000, level: 100000, energy: 1e12, xp: 1e12, xpNeeded: 1e12 };

/*
 * RATES - derived from index.html, not from feel.
 *
 * prestiges: triggerPrestige() returns early while isPrestiging is true, and
 *   isPrestiging is cleared only by the LAST of its wall-clock timers:
 *       setTimeout(.., 2000) / 3500 / 6500 / 8500 / 9500 -> isPrestiging = false
 *   So two prestiges are at least 9.5 s of real time apart, whatever the speed,
 *   upgrades or Focus time-dilation (setTimeout does not read the game clock).
 *   The player must also climb back to level 50 + prestiges first (checkLevelUp),
 *   so 9.5 s is a floor no honest player gets near.
 *       => 1 / 9.5 per second, burst 1.
 *
 * wraithOutruns: a chase spawns only once enemy.spawnTimer passes 20 s, and that
 *   timer only accumulates while no chase is active (update(): `if (!enemy.active
 *   ...)`). It advances by scaledDt = dt * player.timeScale * gauntletFactor, and
 *   both factors are <= 1, so 20 s of spawn timer is at least 20 s of real time;
 *   the chase itself then takes more on top. A chase ends as exactly one of caught
 *   / outrun (dist > 5200) / evaded (35 s), and the two uncaught endings each
 *   report once. APEX's own hunt ("APEX KILL" / "QUARRY ESCAPED") does not report.
 *       => 1 / 20 per second, burst 1.
 *
 * NOT declared, on purpose: orbs, distance, energy, xp, levels. Their rates scale
 * with speed, and speed compounds with no ceiling - maxSpeedBase grows with level,
 * and the engine upgrade is x1.05 per level up to 30 + prestiges. A measured run
 * reached 263,817 sp/s. There is no physical per-second maximum to write down, so
 * any number here would be a guess that either lets cheaters win an event or
 * clamps honest endgame players.
 */
const RATES = { prestiges: 1 / 9.5, wraithOutruns: 1 / 20 };

/*
 * Prestige RATE limit - ON. It was held off while legacy users/{uid} saves were
 * mirrored in, because a stale mirror as `prev` would clamp an honest player's
 * first native save back to it. alloySave no longer passes a mirrored save as
 * prev: the first native save arrives with prev = null and ctx.first = true.
 */
const ENFORCE_PRESTIGE_RATE = true;

// index.html `upgrades`: all six have baseMaxLevel 30, and the shop caps a level at
// baseMaxLevel + prestiges (window.buyUpgrade). That is the ONLY bound: the
// original saveProgress also capped levels at 500 and turned anything above it
// into 0, which would have wiped an upgrade outright for a player past 470
// prestiges, whose shop cap is higher than 500.
const UPGRADE_BASE_MAX = 30;

// index.html `skins`: id -> prestige requirement. admin_god is deliberately absent -
// it is a localhost-only tool and must never exist in a cloud save.
const SKIN_REQ = {
  classic: 0, crimson: 1, toxic: 2, void: 3, celestial: 4, solar: 6,
  neon_glitch: 8, absolute_zero: 10, prismatic: 13, omega_point: 16,
  phantom: 19, supernova: 23, dark_matter: 27, chronos: 32,
  dream_eater: 37, event_bloom: 42,
};
// Unlocked by finishing their quests in-game (codes infinity / apex / null), or for
// jackpot by holding exactly 777 cores for 60 s. Accepted as sent: they are
// cosmetic, events and leaderboards never read saves, and requiring the quest to be
// "done" in the same save would be exactly as easy to forge.
const SECRET_SKINS = ["jackpot", "nullspace", "apex", "infinity"];
// Server-issued, never stored in secretSkins: the gift account's reward id.
const GIFT_REWARD = "shinobi";

/**
 * Whole number in [0, max]. null for garbage (not a finite number, or negative);
 * a value above max is CLAMPED to max, never rejected - see the header.
 */
function whole(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.floor(n), max);
}

/** Quest state is client-shaped: plain object, few keys, primitives only. */
function cleanQuest(q) {
  if (!q || typeof q !== "object" || Array.isArray(q)) return null;
  const out = {};
  for (const k of Object.keys(q).slice(0, 12)) {
    if (k.length > 32) continue;
    const v = q[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && v.length < 64) out[k] = v;
  }
  return out;
}

module.exports = {
  maxBytes: 8 * 1024,

  clean(prev, d, ctx) {
    ctx = ctx || {};
    const clean = {
      prestiges: whole(d.prestiges, LIMITS.prestiges),
      level: whole(d.level, LIMITS.level),
      energy: whole(d.energy, LIMITS.energy),
      xp: whole(d.xp, LIMITS.xp),
      xpNeeded: whole(d.xpNeeded, LIMITS.xpNeeded),
      skin: typeof d.skin === "string" && d.skin.length < 32 ? d.skin : "classic",
      secretSkins: Array.isArray(d.secretSkins)
        ? [...new Set(d.secretSkins.filter((s) => SECRET_SKINS.includes(s)))]
        : [],
      // garbage entries become 0, exactly as before; the real cap is applied below
      upgrades: Array.isArray(d.upgrades)
        ? d.upgrades.slice(0, 32).map((v) => whole(v, Infinity) ?? 0)
        : [],
      tutorialDone: !!d.tutorialDone,
      infinityQuest: cleanQuest(d.infinityQuest),
      apexQuest: cleanQuest(d.apexQuest),
      nullQuest: cleanQuest(d.nullQuest),
    };

    for (const k of ["prestiges", "level", "energy", "xp", "xpNeeded"]) {
      if (clean[k] === null) throw new Reject("bad " + k);
    }

    // --- prestige: never backwards, and bounded by real server time ---
    if (prev && typeof prev.prestiges === "number") {
      if (clean.prestiges < prev.prestiges) clean.prestiges = prev.prestiges;
      if (ENFORCE_PRESTIGE_RATE) {
        // A missing elapsedSec would make grow() return NaN and silently corrupt
        // prestige for good; treat it as "no time has passed" instead.
        const t = Number.isFinite(ctx.elapsedSec) ? ctx.elapsedSec : 0;
        clean.prestiges = grow(prev.prestiges, clean.prestiges, RATES.prestiges,
                               Object.assign({}, ctx, { elapsedSec: t }), 1);
      } else if (clean.prestiges > prev.prestiges + 50) {
        clean.prestiges = prev.prestiges + 50;   // crude time-less fallback
      }
    }

    // --- the shop's own cap on upgrade levels ---
    const upCap = UPGRADE_BASE_MAX + clean.prestiges;
    clean.upgrades = clean.upgrades.map((v) => Math.min(v, upCap));

    // --- the equipped skin must be unlocked by THIS save (mirrors skinUnlocked) ---
    const s = clean.skin;
    const unlocked =
      (Object.prototype.hasOwnProperty.call(SKIN_REQ, s) && clean.prestiges >= SKIN_REQ[s]) ||
      clean.secretSkins.includes(s) ||
      (s === GIFT_REWARD && owns(ctx, GIFT_REWARD));
    if (!unlocked) clean.skin = "classic";

    return clean;
  },

  events: {
    prestiges:     { perSecond: RATES.prestiges,     burst: 1 },
    wraithOutruns: { perSecond: RATES.wraithOutruns, burst: 1 },
  },
};
