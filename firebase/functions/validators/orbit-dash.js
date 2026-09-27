"use strict";
/**
 * Orbit Dash — games/orbit-dash/index.html
 *
 * The scoring ceiling is derived from the game's own constants, not guessed:
 *   passive   12 x chain (chain <= 9.9)                    ~  119 / s
 *   gates     55 x chain each, a gate spawns every >= 0.5s  ~ 1089 / s
 *   shatter   90 x chain each, debris spawns every >= 0.5s  ~ 1782 / s
 *   total                                                   ~ 2990 / s
 * So no run can score faster than 3000 points per second of real time, and no
 * run can thread more than 2 gates per second.
 */
const { int, grow } = require("./lib");

const MAX_SCORE_PER_SEC = 3000;
const MAX_BEST = 50000000;

module.exports = {
  maxBytes: 512,

  clean(prev, next, ctx) {
    const best = int(next.best, 0, MAX_BEST, 0);
    const before = prev ? int(prev.best, 0, MAX_BEST, 0) : null;
    return { best: grow(before, best, MAX_SCORE_PER_SEC, ctx, MAX_SCORE_PER_SEC * 5) };
  },

  // Metrics an Alloy event may track for this game, with their physical rates.
  events: {
    gates: { perSecond: 2.2, burst: 6 },
    score: { perSecond: MAX_SCORE_PER_SEC, burst: MAX_SCORE_PER_SEC * 5 },
  },
};
