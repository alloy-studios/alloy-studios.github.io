"use strict";
/**
 * Echoes — Alloy Accounts validator.
 *
 * WHAT IS SAVED
 *   { v: 1, cleared: [bool x3], best: [seconds x3] }
 *   One flag and one best time per track. A best time of 0 means "no time yet".
 *   The save never grows: three tracks, fixed shape, well under 100 bytes.
 *
 * WHY THERE IS NO RATE LIMIT
 *   Nothing here accumulates. A best time only ever improves (falls), and a
 *   recovered track stays recovered. The one thing worth bounding is how fast
 *   a track can possibly be cleared, and that is bounded absolutely - by the
 *   game's own hold timers - not per second of server time. A per-elapsedSec
 *   check would only add honest failures: a player who clears a track offline
 *   on one device and signs in on it seconds after another device saved would
 *   have a real clear clamped away. Saves are not read by events or
 *   leaderboards, so a cheater gains nothing beyond a fake time on their own
 *   account, which the floors below already hold to the physically possible.
 *
 * THE FLOORS, from the game's code (echoes.html, objective controllers).
 *   Every use in the game is a hold: updateUse() adds the frame's dt to
 *   player.useT and only fires onUse() once useT >= that item's useTime, and
 *   resets useT to 0 after. G.elapsed advances by the same dt in sim(), before
 *   updateUse runs, and keeps advancing during the struggle QTE when holds do
 *   not. So a run's elapsed time is always >= the sum of the holds it needs:
 *     Track 01  3 sluices x 2.4 s + the stairwell exit 1.2 s     =  8.4 s
 *               (the exit only spawns after the third sluice)
 *     Track 02  4 voices x 3.0 s                                  = 12.0 s
 *     Track 03  lift the accumulator 0.5 s + seat it 1.6 s        =  2.1 s
 *   These ignore walking entirely, so they sit under any honest time on any
 *   generated map (layouts are random, so travel time has no safe minimum).
 *   Each floor keeps a small margin under the true sum for float drift in dt.
 *
 * CLAMP, DON'T REJECT. Only a save that is not an object at all is rejected.
 * Everything else is clamped: a time under its floor is raised to the floor,
 * an absurd time is capped, and garbage entries read as "no time". A rejected
 * save never replaces the stored one, so a reachable Reject would lock an
 * honest player out for good; nothing an honest client sends can reach it.
 */
const { Reject } = require("./lib");

const TRACKS = 3;
const FLOOR = [8.0, 11.5, 2.0];      // seconds - see the derivation above
const MAX_TIME = 86400;              // a day of game time; anything longer is capped

/** A best time in seconds, or 0 for "none". Never below the track's floor. */
function time(v, i) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const t = Math.min(MAX_TIME, Math.max(FLOOR[i], n));
  return Math.round(t * 100) / 100;
}

module.exports = {
  maxBytes: 512,

  clean(prev, next, ctx) {
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Reject("save is not an object");
    const pc = prev && Array.isArray(prev.cleared) ? prev.cleared : [];
    const pb = prev && Array.isArray(prev.best) ? prev.best : [];
    const nc = Array.isArray(next.cleared) ? next.cleared : [];
    const nb = Array.isArray(next.best) ? next.best : [];

    const out = { v: 1, cleared: [], best: [] };
    for (let i = 0; i < TRACKS; i++) {
      // a best time only improves: a device with a worse or missing time cannot regress the account
      const a = time(pb[i], i), b = time(nb[i], i);
      out.best[i] = a > 0 && b > 0 ? Math.min(a, b) : (a || b);
      // a recovered track stays recovered, and a track with a time was recovered
      out.cleared[i] = pc[i] === true || nc[i] === true || out.best[i] > 0;
    }
    return out;
  },

  // No event metrics yet. If the owner wants events later, these are hold-bound
  // and so have honest ceilings: sluices (1 per 2.4 s), voices (1 per 3.0 s),
  // tracks recovered (1 per 2.0 s). They need AA.progress calls in the game first.
  events: {},
};
