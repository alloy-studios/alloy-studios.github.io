"use strict";
/**
 * Neon Speed Simulator — ported rule-for-rule from its original saveProgress
 * function (Desktop/SpeedSimulator/protected/functions/index.js), so moving to
 * Alloy does not weaken any check it already had:
 *   - every field clamped to a hard limit, malformed numbers rejected
 *   - prestige never goes backwards
 *   - prestige never jumps more than +50 in one save
 * The field list matches the legacy users/{uid} document exactly, which is
 * what lets alloySession copy old saves across unchanged.
 */
const { Reject } = require("./lib");

const LIMITS = { prestiges: 100000, level: 100000, energy: 1e12, upgradeLevel: 500 };

/** Integer in [0, max], or null if it is not one. */
function strict(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.floor(n);
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

  clean(prev, d) {
    const clean = {
      prestiges: strict(d.prestiges, LIMITS.prestiges),
      level: strict(d.level, LIMITS.level),
      energy: strict(d.energy, LIMITS.energy),
      xp: strict(d.xp, 1e12),
      xpNeeded: strict(d.xpNeeded, 1e12),
      skin: typeof d.skin === "string" && d.skin.length < 32 ? d.skin : "classic",
      secretSkins: Array.isArray(d.secretSkins)
        ? d.secretSkins.filter((s) => typeof s === "string" && s.length < 32).slice(0, 16)
        : [],
      upgrades: Array.isArray(d.upgrades)
        ? d.upgrades.slice(0, 32).map((v) => strict(v, LIMITS.upgradeLevel) ?? 0)
        : [],
      tutorialDone: !!d.tutorialDone,
      infinityQuest: cleanQuest(d.infinityQuest),
      apexQuest: cleanQuest(d.apexQuest),
      nullQuest: cleanQuest(d.nullQuest),
    };

    for (const k of ["prestiges", "level", "energy", "xp", "xpNeeded"]) {
      if (clean[k] === null) throw new Reject("bad " + k);
    }

    if (prev && typeof prev.prestiges === "number") {
      if (clean.prestiges < prev.prestiges) clean.prestiges = prev.prestiges;
      if (clean.prestiges > prev.prestiges + 50) throw new Reject("implausible prestige jump");
    }
    return clean;
  },

  // No event metrics yet — the Speed Simulator session adds these when it
  // moves onto Alloy saves and knows its real per-second rates.
  events: {},
};
