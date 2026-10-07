"use strict";
/**
 * Speed Simulator 2 - Alloy Accounts validator.
 * The site owner copies this into AlloyStudios/firebase/functions/validators/
 * as speed-simulator-2.js. The save shape is js/save.js (SS.defaultSave /
 * SS.cleanSave) - keep the two identical.
 *
 * CLAMP, DON'T REJECT. A rejected save never replaces `prev`, so any Reject an
 * honest save can reach is a permanent, silent lockout. Only garbage rejects:
 * a non-object save, or a core number that is not a finite, non-negative
 * number. Everything merely too big, too fast or unknown is clamped or dropped.
 */
const { grow, Reject } = require("./lib");

const LIMITS = { level: 100000, prestiges: 100000, big: 1e15 };

// Ids the game knows (js/ships/*.js, js/regions/*.js, SS.TIERS, SS.SECRETS).
// deadair / maw / hollow are Halloween event ships, given to everyone who plays
// while the event is active (SS.EVENTS in js/core.js). Accepted as sent like
// the rest; to make them provably event-earned later, issue them as Alloy event
// rewards and require owns(ctx, id) here.
const SHIPS = ["lance", "claw", "drill", "frost", "needle", "magnet", "prism", "deadair", "maw", "hollow"];
const REGIONS = ["shallows", "gale", "wells", "storm"];
const WILD = ["gale", "wells", "storm"];                  // regions with a Wraith
const TIERS = ["mote", "surge", "mega", "nova"];
const SECRETS = ["stillness", "windborne", "horizon", "eye", "lastbreath", "ouroboros"];
const GOALS = ["sh1", "sh2", "sh3", "ga1", "ga2", "ga3", "ga4", "we1", "we2", "we3", "we4", "st1", "st2", "st3"];
const UPGRADES = ["engine", "cell", "magnet", "resonance"];

// js/progress.js: the shop caps an upgrade at 20 + 5 per prestige (stats.upgradeCap),
// and levels stop at the prestige level, also 20 + 5 per prestige (stats.prestigeLevel).
const UPGRADE_BASE_CAP = 20, UPGRADE_PER_PRESTIGE = 5;
const LEVEL_BASE_CAP = 20, LEVEL_PER_PRESTIGE = 5;

/*
 * RATES - derived from the code, not from feel.
 *
 * prestiges: SS.beginPrestige() (js/progress.js) refuses while a prestige is in
 *   progress, and a prestige completes only when its setTimeout(.., 6000) fires
 *   - WALL-CLOCK time, unaffected by the game clock, slow motion or hitstop.
 *   The player must also reach level 20 + 5*prestiges again first, from level 1.
 *       => 1 / 6 per second, burst 1.
 *
 * wraithEscapes (stats.escapes): a Wraith can only arrive once performance.now()
 *   passes W.cooldownUntil, set to now + 20,000 ms when the previous chase ENDS
 *   (js/wraith.js end()). Arrival then takes 1.9 s before the chase can end in
 *   an escape. So two escapes are more than 20 s of real time apart.
 *       => 1 / 20 per second, burst 1.
 *
 * NOT declared, on purpose: orbs, energy, xp, level, best speed. They grow
 * without a ceiling (orb value x1.12 per resonance level and +30% per prestige;
 * cruise speed rises with level, engine +6% per level and +5% per prestige, and
 * past 1,600 sp/s tapers logarithmically but never stops), so there is no
 * physical per-second maximum to write down. Absolute caps only.
 */
const RATES = { prestiges: 1 / 6, wraithEscapes: 1 / 20 };

/** Whole number in [0, max]; null for garbage. Over max CLAMPS. */
function whole(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.floor(n), max);
}
/** Like whole(), but garbage becomes 0 - for fields nothing depends on. */
const soft = (v, max) => { const n = whole(v, max); return n === null ? 0 : n; };
const known = (v, ids) => (Array.isArray(v) ? [...new Set(v.filter((x) => ids.includes(x)))] : []);

module.exports = {
  maxBytes: 4 * 1024,

  clean(prev, d, ctx) {
    ctx = ctx || {};
    if (!d || typeof d !== "object" || Array.isArray(d)) throw new Reject("save is not an object");
    // A missing elapsedSec would make grow() write NaN into the save for good.
    const c = Object.assign({}, ctx, { elapsedSec: Number.isFinite(ctx.elapsedSec) ? ctx.elapsedSec : 0 });

    const out = {
      v: 1,
      level: whole(d.level, LIMITS.level),
      xp: whole(d.xp, LIMITS.big),
      energy: whole(d.energy, LIMITS.big),
      prestiges: whole(d.prestiges, LIMITS.prestiges),
    };
    for (const k of ["level", "xp", "energy", "prestiges"]) if (out[k] === null) throw new Reject("bad " + k);
    out.level = Math.max(1, out.level);

    // prestige: never backwards, at most 1 per 6 s of server time
    if (prev && typeof prev.prestiges === "number") {
      out.prestiges = grow(prev.prestiges, Math.max(out.prestiges, prev.prestiges), RATES.prestiges, c, 1);
    }

    // level: capped at the prestige level, 20 + 5 per prestige (SS.gain stops there)
    out.level = Math.min(out.level, LEVEL_BASE_CAP + LEVEL_PER_PRESTIGE * out.prestiges);

    // upgrades: the shop's own cap
    const cap = UPGRADE_BASE_CAP + UPGRADE_PER_PRESTIGE * out.prestiges;
    const up = d.upgrades && typeof d.upgrades === "object" ? d.upgrades : {};
    out.upgrades = {};
    for (const k of UPGRADES) out.upgrades[k] = Math.min(soft(up[k], 1e6), cap);

    // discoveries: known ids only. Cosmetic or exploration state - events and
    // leaderboards never read saves, and requiring proof here would be exactly
    // as easy to forge as the list itself.
    out.ships = known(d.ships, SHIPS);
    if (!out.ships.includes("lance")) out.ships.unshift("lance");
    out.ship = out.ships.includes(d.ship) ? d.ship : "lance";
    out.regions = known(d.regions, REGIONS);
    if (!out.regions.includes("shallows")) out.regions.unshift("shallows");
    const cx = d.codex && typeof d.codex === "object" ? d.codex : {};
    out.codex = { tiers: known(cx.tiers, TIERS), secrets: known(cx.secrets, SECRETS), wraiths: known(cx.wraiths, WILD) };
    out.goals = known(d.goals, GOALS);

    const st = d.stats && typeof d.stats === "object" ? d.stats : {};
    const ps = prev && prev.stats && typeof prev.stats === "object" ? prev.stats : null;
    out.stats = {
      orbs: soft(st.orbs, LIMITS.big),
      escapes: soft(st.escapes, 1e7),
      catches: soft(st.catches, 1e7),
      bestSpeed: soft(st.bestSpeed, 1e12),
      maxLevel: Math.max(soft(st.maxLevel, LIMITS.level), out.level),
      playtime: soft(st.playtime, 1e10),
    };
    if (ps && typeof ps.escapes === "number") {
      out.stats.escapes = grow(ps.escapes, Math.max(out.stats.escapes, ps.escapes), RATES.wraithEscapes, c, 1);
    }
    return out;
  },

  events: {
    prestiges: { perSecond: RATES.prestiges, burst: 1 },
    wraithEscapes: { perSecond: RATES.wraithEscapes, burst: 1 },
  },
};
