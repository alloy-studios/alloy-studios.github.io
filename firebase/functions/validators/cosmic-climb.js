"use strict";
/**
 * Cosmic Climb — games/cosmic-climb/index.html
 *
 * The save is two records: { best, bestScore }. Best altitude in metres and
 * best single-run score. Both only ever go up, so both use grow().
 *
 * Every ceiling below is derived from the game's own constants (CFG and the
 * addScore / bumpChain / flow calls in sim), not guessed.
 *
 * ── How fast can the player rise? ──────────────────────────────────────────
 *   The fastest upward launch is a kicker: JUMP * KICK = 1083 * 1.56 = 1690 px/s.
 *   Surge is 1560, a plain jump 1083, an up-dash 1190 * 0.86 = 1023. Nothing
 *   else pushes the player up, and gravity (3150 px/s^2) only slows them.
 *   METER = 22 px, so upward speed is at most 1690 / 22 = 76.8 m/s.
 *   The run ends at GOAL = 3000 m; the frame that crosses it can overshoot by
 *   at most 1690 px/s * 0.05 s (the frame clamp) / 22 = 3.8 m.
 *     -> ALT_PER_SEC 77, MAX_ALT 3010.
 *
 * ── How fast can a run score? ──────────────────────────────────────────────
 *   Every point is multiplied by chainMult() = min(4, 1 + chain * 0.13) <= 4.
 *   Platforms are generated at least GAPMIN = 94 px apart, and each carries at
 *   most one stardust and at most one debris, so a player moving at the
 *   ceiling above passes at most 1690 / 94 = 18 platforms per second.
 *     altitude   3.1 pts/m * 4 * 76.8 m/s                  ~   952 / s
 *     stardust   26 * 4 = 104 each, <= 18/s                ~ 1,872 / s
 *     debris     60 * 4 = 240 per shatter, <= 18/s         ~ 4,320 / s
 *     surge      220 * 4 = 880, needs flow 1.0; flow per platform is at most
 *                dust .085 + three chain bumps (.028 each) = .169, so
 *                <= 18 * .169 = 3.04 surges/s                ~ 2,675 / s
 *     total                                                 ~ 9,819 / s
 *   Realm gates pay 400 * 4 = 1,600, but there are only 7 in a whole run, so
 *   they are burst rather than rate: 7 * 1,600 + one surge = 12,080.
 *     -> SCORE_PER_SEC 10,000, SCORE_BURST 12,100.
 *
 * ── How much can one run score at all? ─────────────────────────────────────
 *   Score does not compound, and nothing can be farmed: dust and debris exist
 *   only on platforms, which are generated only as you climb, and altitude
 *   points only pay out on new height. 3000 m of sheet holds at most
 *   66,000 / 94 = 702 platforms.
 *     altitude   3000 * 3.1 * 4              37,200
 *     stardust   702 * 104                   73,008
 *     debris     702 * 240                  168,480
 *     surge      (702 * .169 + 7 gates * .328 flow) = 121 * 880   106,480
 *     gates      7 * 1,600                   11,200
 *     total                                ~396,368
 *     -> MAX_SCORE 450,000.
 *
 * ── Honest paths that can hit a clamp (none can hit a Reject) ──────────────
 *   Signing in mid-run uploads the pre-run record, so the save at the end of
 *   that run is rate-checked against only the seconds since sign-in. A large
 *   record from that run may be clamped once. The game keeps the higher value
 *   locally (it adopts replies with max()), re-sends it at the next run end,
 *   and the allowance has grown by then — so it heals itself, it never locks.
 *   Nothing here throws Reject: garbage becomes 0 and grow() keeps the stored
 *   record, which is always safe.
 */
const { int, grow } = require("./lib");

const MAX_ALT = 3010;
const ALT_PER_SEC = 77;
const ALT_BURST = 150;              // frame overshoot + clock slack between saves

const MAX_SCORE = 450000;
const SCORE_PER_SEC = 10000;
const SCORE_BURST = 12100;          // all 7 gates plus one surge

// Shortest possible summit run: 3000 m at 76.8 m/s = 39.1 s.
const MIN_SUMMIT_SEC = 39;

module.exports = {
  // The whole save is ~35 bytes ({"best":3010,"bestScore":450000}); 512 is
  // ample headroom for every player, however long they've played.
  maxBytes: 512,

  clean(prev, next, ctx) {
    const n = next && typeof next === "object" ? next : {};
    const p = prev && typeof prev === "object" ? prev : null;
    const best = int(n.best, 0, MAX_ALT, 0);
    const bestScore = int(n.bestScore, 0, MAX_SCORE, 0);
    return {
      best: grow(p ? int(p.best, 0, MAX_ALT, 0) : null, best, ALT_PER_SEC, ctx, ALT_BURST),
      bestScore: grow(p ? int(p.bestScore, 0, MAX_SCORE, 0) : null, bestScore, SCORE_PER_SEC, ctx, SCORE_BURST),
    };
  },

  // Metrics an Alloy event may track, each reported once at the end of a run.
  // All four are bounded by physics above, not by a feel-based guess.
  events: {
    score:   { perSecond: SCORE_PER_SEC, burst: SCORE_BURST },
    meters:  { perSecond: ALT_PER_SEC, burst: ALT_BURST },
    dust:    { perSecond: 18, burst: 20 },                 // <= 1 per platform, <= 18 platforms/s
    summits: { perSecond: 1 / MIN_SUMMIT_SEC, burst: 1 },  // <= 1 per run, run >= 39 s
  },
};
