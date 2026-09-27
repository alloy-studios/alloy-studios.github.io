"use strict";
/**
 * Building blocks for per-game save validators.
 *
 * Philosophy: CLAMP rather than reject wherever a value is merely too big.
 * If a cap is tuned a little too tight, clamping costs an honest player a
 * sliver of progress; rejecting would throw their whole save away. Reserve
 * `Reject` for data that is malformed, not merely suspicious.
 */

class Reject extends Error {}

/** Integer in [min, max]; anything unusable becomes `dflt`. */
const int = (v, min, max, dflt = min) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/** Number in [min, max]; anything unusable becomes `dflt`. */
const num = (v, min, max, dflt = min) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

const bool = (v) => v === true;
const str = (v, maxLen, dflt = "") => (typeof v === "string" ? v.slice(0, maxLen) : dflt);
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
const arr = (v, maxLen, fn) => (Array.isArray(v) ? v.slice(0, maxLen).map(fn) : []);

/**
 * A value that only ever goes up (a best score, total prestiges, lifetime
 * gates) and cannot rise faster than `perSecond` since the last accepted save.
 * The first save is bounded only by the absolute cap the caller applied —
 * that is progress from before the player had an account, and the server has
 * no way to have witnessed it.
 */
function grow(prev, next, perSecond, ctx, burst = 0) {
  if (prev == null || ctx.first) return next;
  const ceiling = ceilingFor(prev, next, perSecond * ctx.elapsedSec + burst);
  return Math.max(prev, Math.min(next, ceiling));
}

/**
 * A spendable balance (coins, energy): may fall freely, may only rise at
 * `perSecond` since the last accepted save.
 */
function gain(prev, next, perSecond, ctx, burst = 0) {
  if (prev == null || ctx.first || next <= prev) return next;
  return Math.min(next, ceilingFor(prev, next, perSecond * ctx.elapsedSec + burst));
}

/**
 * elapsedSec is real time, so it is almost never whole — and a rate times a
 * fractional time is a fractional ceiling. For whole-number quantities
 * (prestiges, scores, coins) the ceiling is floored, or a clamped save would
 * hand the game back 12.05 prestiges.
 */
function ceilingFor(prev, next, allowance) {
  // A NaN allowance (a missing elapsedSec) would make the ceiling NaN, and
  // Math.min/max would then write NaN into the save for good. Treat it as 0.
  const c = prev + (Number.isFinite(allowance) ? allowance : 0);
  return Number.isInteger(prev) && Number.isInteger(next) ? Math.floor(c) : c;
}

/** True if the player has claimed this reward id from an Alloy event. */
const owns = (ctx, rewardId) => Array.isArray(ctx.rewards) && ctx.rewards.includes(rewardId);

/** Plain JSON only: bounded depth, key count, key length, string and array size. */
function plain(v, depth = 0) {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") return v.slice(0, 2000);
  if (depth >= 6) return null;
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => plain(x, depth + 1));
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).slice(0, 200)) {
      if (k.length <= 64) out[k] = plain(v[k], depth + 1);
    }
    return out;
  }
  return null;
}

module.exports = { Reject, int, num, bool, str, oneOf, arr, grow, gain, owns, plain };
