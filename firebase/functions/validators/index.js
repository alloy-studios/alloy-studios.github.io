"use strict";
/**
 * One validator per game, keyed by the game's id on the site (the folder name
 * under games/). A game without an entry here falls back to the generic
 * validator: its saves still sync, but are stored unverified and it cannot
 * take part in events or leaderboards.
 *
 * Adding a game: drop its validator in this folder, add one line below,
 * redeploy the "alloy" functions codebase.
 */
const { Reject } = require("./lib");
const generic = require("./generic");

const REGISTRY = {
  "orbit-dash": require("./orbit-dash"),
  "speed-simulator": require("./speed-simulator"),
  "meridian": require("./meridian"),
  "redwater": require("./redwater"),
};

function validatorFor(gameId) {
  const v = REGISTRY[gameId] || generic;
  return { maxBytes: 32 * 1024, events: {}, generic: v === generic, ...v };
}

module.exports = { validatorFor, Reject };
