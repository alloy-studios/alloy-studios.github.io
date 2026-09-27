"use strict";
/**
 * Used for any game that has no validator of its own yet.
 *
 * Its saves sync between devices, but the server can only check that they are
 * well-formed JSON — not that the numbers in them are possible. So they are
 * stored as `verified: false`, and the game cannot take part in events or
 * leaderboards (it has no `events` metrics) until it ships a real validator.
 */
const { plain } = require("./lib");

module.exports = {
  generic: true,
  maxBytes: 32 * 1024,
  clean: (prev, next) => plain(next),
  events: {},
};
