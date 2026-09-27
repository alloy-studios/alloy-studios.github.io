# Putting a game on Alloy Accounts

This is the contract every Alloy Studios game follows to use the shared
account system. The reference implementation is Orbit Dash:
`C:\Users\fatih\OneDrive\Desktop\AlloyStudios\games\orbit-dash\index.html`
— search it for `AlloyAccount`.

## What it is

Every game runs inside an iframe on `alloy-studios.github.io`. The site around
it owns sign-in (the button top right) and exposes one object to the game:

```js
const AA = (() => {
  try { return window.parent !== window ? window.parent.AlloyAccount || null : null; }
  catch (_) { return null; }
})();
```

`AA` is `null` when the game is opened on its own (a local file, its own repo).
**The game must work fully without it.** Keep your existing localStorage save —
that is the guest save and the offline save. Alloy is a sync layer on top.

**Prefix every localStorage key with your game's name** (`redwater.save`,
`flashpoint_progress`). Every game runs on the same origin,
`alloy-studios.github.io`, so localStorage is shared between all of them — a bare
`save` or `highscore` key will be overwritten by another game.

Don't write to the cloud until your first `AA.load` has finished. Otherwise a
slow load can let an empty device upload over a real account.

Your game never loads Firebase, never shows a login screen, and never talks to
a database. If it has its own account system today, remove it.

## The API

| Call | Returns | Notes |
|---|---|---|
| `AA.ready` | Promise → `{uid, name}` or `null` | Resolves once sign-in state is known. |
| `AA.user()` | `{uid, name}` or `null` | Synchronous. |
| `AA.onChange(fn)` | unsubscribe fn | `fn(user)` on sign-in, sign-out, name change. |
| `AA.signIn()` | — | Opens the site's sign-in window. |
| `AA.load(gameId)` | Promise → `{data, rewards, verified}` or `null` | `data` is `null` when the account has no cloud save for this game yet — `rewards` is still there. The whole result is `null` only for guests or when the account server is unreachable. |
| `AA.save(gameId, data, {now})` | Promise → `{ok, data}` or `{ok:false, error}` | Routine calls coalesce to one per 20 s per game. `{now:true}` skips that wait, down to the server's floor of one save per ~4.5 s — use it at checkpoints (end of a run, a purchase, a level-up). Anything pending is sent automatically when the page is hidden or closed, so you don't need your own unload handler. `data` in the reply is what the server actually stored — adopt it. |
| `AA.events(gameId)` | Promise → event list | Each has `live`, `metric`, `type`, `tiers`, and (signed in) `state: {progress, best, total, top, claimed}`. |
| `AA.progress(eventId, n)` | Promise | Adds `n` to a personal/community event counter. Batched every 10 s. |
| `AA.score(eventId, value)` | Promise | Submits a run's score to a leaderboard event (best-of). |
| `AA.claim(eventId, tierIndex)` | Promise → `{reward}` or `{error}` | The server checks the player earned it. |

`gameId` is your game's id on the site — the folder name under `games/`
(`redwater`, `grand-line`, `meridian`, `leveling-the-system`, …).

## What to build

1. **Load on start and on sign-in.** `AA.ready.then(sync)` and `AA.onChange(sync)`.
   In `sync`, if signed in: `AA.load(id)`. Merge sensibly for your game — for
   most games, take the cloud save if it exists; if it doesn't, upload the
   local save with `AA.save(id, local, {now:true})`. For a "best score" game,
   keep the higher of the two.
2. **Save at checkpoints**, not every frame: end of a run, a purchase, a
   level-up, closing a menu. Routine calls are fine too — they are coalesced.
3. **Adopt the server's reply.** `save()` resolves with the cleaned data. If the
   server clamped a value, that is the value that exists.
4. **Show sync state somewhere small**, e.g. on the game-over screen: "Saved to
   your Alloy account" / "Sign in to keep your progress".
5. **Remove admin, debug and redeem panels** that grant currency, items or
   progress (Speed Simulator's code panel, "+100,000" debug buttons, backtick
   admin menus). Anyone can trigger them from DevTools. They were harmless
   when saves stayed in one browser; with cloud saves they are a cheat that
   follows the player everywhere. If you need a test mode, gate it on
   `location.hostname === "localhost"`.
6. **Write your validator** (below). This is the part that actually stops
   cheating.

## The validator — the anti-cheat

Your save is only as trustworthy as the server's check on it. Write
`alloy/validator.js` **in your own game's repo** (the site owner copies it into
the server). It is plain Node, CommonJS, and runs as if it lives in
`firebase/functions/validators/` — so `require("./lib")` gives you the helpers
in `C:\Users\fatih\OneDrive\Desktop\AlloyStudios\firebase\functions\validators\lib.js`.
Read that file, and read `orbit-dash.js` and `speed-simulator.js` next to it
as examples.

```js
"use strict";
const { int, num, bool, str, arr, grow, gain, owns, Reject } = require("./lib");

module.exports = {
  maxBytes: 8 * 1024,           // hard ceiling on the JSON size of one save

  // prev: last accepted save (or null). next: what the game sent.
  // ctx: { first, elapsedSec, rewards }  — elapsedSec is SERVER time since
  // the last accepted save. Return the cleaned save. Throw Reject only for
  // malformed data.
  clean(prev, next, ctx) {
    return {
      coins: gain(prev && prev.coins, int(next.coins, 0, 1e9), 40, ctx, 500),
      bestWave: grow(prev && prev.bestWave, int(next.bestWave, 0, 1000), 0.2, ctx, 3),
      skins: arr(next.skins, 64, s => str(s, 32)).filter(s => BASE_SKINS.includes(s) || owns(ctx, s)),
      // ...every field you save, each clamped
    };
  },

  // What events can measure in your game, with a PHYSICAL maximum rate.
  events: {
    kills: { perSecond: 4, burst: 20 },
  },
};
```

Rules for writing one:

- **Clean every field.** Anything you don't copy out is dropped. Never
  `return next`.
- **Derive rates from your code, not from feel.** Orbit Dash's 3000 points/s
  comes from its spawn intervals and multipliers — the comment in
  `orbit-dash.js` shows the working. Put yours in a comment the same way.
- **Only declare event metrics that have an honest ceiling.** Things bound by
  a timer, a spawn interval or a cooldown qualify ("one prestige per 9.5 s",
  "one boss per 20 s"). In incremental games, currency, distance and score
  compound without limit, so they have no physical maximum. Leave them out
  rather than invent a number: a guess either lets cheaters win or clamps honest
  endgame players. A game with only one or two timer-bound metrics is fine, and
  so is `events: {}`. Speed Simulator's validator is the worked example.
- **Clamp, don't reject — a reachable `Reject` is a permanent lockout.** A
  rejected save never replaces the stored one. So if any honest path can hit a
  `Reject`, every later save is compared against the same old save and rejected
  too, silently and forever. Honest paths include offline play, playing as a
  guest before signing in, and very long sessions. Over-cap or too-fast values
  must be **clamped** to the cap. `Reject` is only for garbage: non-numbers,
  negatives, wrong types. Speed Simulator's validator found two such lockouts in
  its own legacy rules. Read it before writing yours.
- **`grow`** for things that only go up (best score, lifetime stats, levels).
  **`gain`** for spendable balances (may drop freely, may only rise at a rate).
- **Event rewards** arrive as reward ids in `ctx.rewards`; only let a save
  contain an event-exclusive item if `owns(ctx, id)`.
- The **first cloud save** (`ctx.first`) cannot be rate-checked — it is
  progress from before the account existed. Clamp it to absolute maxima only.
  Events and leaderboards don't read saves, so this can't be used to win them.

## Events

Events are defined by the site owner in `data/events.json` in the site repo:

```json
{
  "id": "redwater-bounty-week",
  "gameId": "redwater",
  "type": "personal",
  "metric": "bounties",
  "title": "Bounty Week",
  "blurb": "Bring in 25 bounties before Sunday.",
  "startsAt": "2026-10-03T00:00:00Z",
  "endsAt": "2026-10-10T00:00:00Z",
  "claimDays": 7,
  "tiers": [
    { "at": 10, "reward": { "id": "badge-deputy", "label": "Deputy badge" } },
    { "at": 25, "reward": { "id": "skin-marshal", "label": "Marshal coat" } }
  ]
}
```

`type` is `personal` (your own counter), `community` (everyone's counters
summed), or `leaderboard` (best score, public player names). `metric` must be
one your validator lists in `events` — an event on a metric the validator
doesn't declare is refused by the server.

In the game: on load, `AA.events(id)` and keep the `live` ones. When the
metric happens, call `AA.progress(eventId, n)` (or `AA.score` for
leaderboards) — batching is handled for you. Show progress from
`event.state`, and a claim button per tier that calls `AA.claim`. Grant the
reward in-game from `load().rewards`, which lists every reward id the server
has recorded as claimed — so a reward survives reinstalling or changing device.

## Checklist before you report back

- [ ] Game works identically with `AA === null` (open the file directly)
- [ ] Own login / account UI removed
- [ ] Admin / debug / redeem grant panels removed or localhost-only
- [ ] Loads cloud save on start and on sign-in; uploads local save if the cloud is empty
- [ ] Saves at checkpoints with `{now:true}`, adopts the server's reply
- [ ] Sync status visible to the player
- [ ] `alloy/validator.js` written, every field cleaned, every rate derived in a comment
- [ ] Event metrics declared in the validator (or `events: {}` if none yet)
- [ ] Pushed to GitHub
