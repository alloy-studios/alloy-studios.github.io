# Alloy Accounts — server

One account for every Alloy Studios game. This folder is the server half:
Cloud Functions that validate every save and event submission, and the
Firestore rules that stop the browser touching the database directly.

It lives in the **existing Speed Simulator Firebase project**
(`speed-simulator-dfac6`), so every Speed Simulator player keeps their login
and their progress moves across on their first visit.

| Where | What |
|---|---|
| `functions/index.js` | The server: sessions, saves, events, rewards |
| `functions/validators/` | One anti-cheat validator per game |
| `firestore.rules` | Denies the browser all direct database access |
| `GAMES.md` | The contract each game follows to use accounts |
| `../assets/account.js` | The browser half: sign-in window, `AlloyAccount` API |
| `../data/events.json` | Limited-time events — edited here, live on `git push` |

---

## One-time setup (Firebase console, 5 minutes)

Open <https://console.firebase.google.com> → project **speed-simulator-dfac6**.

1. **Project settings → General → Public-facing name** → `Alloy Studios`.
   This is the name on password-reset emails and the Google sign-in screen,
   instead of "speed-simulator-dfac6".
2. **Authentication → Sign-in method → Google → Enable**, pick your support
   email, **Save**. (Email/Password is already on.)
3. **Authentication → Settings → Authorized domains** — confirm
   `alloy-studios.github.io` is listed.
4. **Set a budget alert.** <https://console.cloud.google.com/billing> →
   **Budgets & alerts → Create budget** → $5, alerts at 50 / 90 / 100 %.
   Budgets **email you; they do not stop charges.** At hobby scale this should
   never fire — if it does, something is wrong and you want to know.

## Deploy (Google Cloud Shell)

This PC has no Node.js, so — exactly like Speed Simulator — the server is
deployed from Cloud Shell, which has Node and the Firebase CLI built in.

1. On this PC:
   ```
   powershell -ExecutionPolicy Bypass -File tools\pack-firebase.ps1
   ```
   That writes `alloy-firebase.zip` in the site folder.
2. Open Cloud Shell: <https://console.cloud.google.com/?cloudshell=true> (make
   sure the project picker says speed-simulator-dfac6). Use **⋮ → Upload** to
   upload `alloy-firebase.zip`.
3. In the Cloud Shell terminal:
   ```
   rm -rf ~/alloy-firebase && unzip -o ~/alloy-firebase.zip -d ~ && cd ~/alloy-firebase
   cd functions && npm install && cd ..
   firebase use speed-simulator-dfac6
   firebase deploy --only functions:alloy
   ```
   `npm install` is **not optional** — the deploy aborts without it.
   If it asks to enable the Cloud Scheduler API (used by the community-event
   tally), say yes.

`functions:alloy` deploys only this codebase. It never touches Speed
Simulator's `getGame` and `saveProgress`, and deploying those from the Speed
Simulator folder never touches these.

**Rules:** `firestore.rules` here is now the single source of truth. It is
equivalent to what is already live, so there is nothing to deploy today. When
it changes: `firebase deploy --only firestore:rules` from `~/alloy-firebase`.
Never deploy rules from the Speed Simulator folder again — it would overwrite
this file's.

## What stops cheating, and what can't

**Stopped:**
- Writing to your own account from DevTools — the rules deny all browser access.
- Impossible saves — each game's validator clamps every field and caps how
  fast anything can grow, measured on the **server's** clock.
- Changing your PC clock to reach an event early or late — windows use server time.
- Claiming rewards you didn't earn — the server checks, then records the claim.
- Scripts hammering the server from outside the site — App Check (reCAPTCHA).
- One bug or attacker running up the bill — every function is capped at 10
  instances, and saves / submissions are rate-limited per player.

**Not stoppable, in any web game:** someone reading the game's code in
DevTools, and someone playing at the very edge of what's humanly possible. The
validators bound the second one; nothing prevents the first. Your repos are
public and the site sends every game's code to every visitor.

**Known gap:** a player's *first* cloud save can't be rate-checked — it is
progress from before the account existed. It is clamped to absolute maxima
only. Events and leaderboards keep their own server-side counters and never
read saves, so this can't be used to win them.

## Adding an event

Add an entry to `data/events.json` in the site repo and push — no redeploy.
The server re-reads the file within 5 minutes. Format and the three event
types are in `GAMES.md`. The event's `metric` must be declared in that game's
validator, or the server refuses progress for it.

## Adding a game's validator

A game session writes `alloy/validator.js` in its own repo (see `GAMES.md`).
Copy it to `functions/validators/<game-id>.js`, add one line to the registry
in `functions/validators/index.js`, then re-pack and redeploy.

## What it costs

Guests cost nothing — the site doesn't load Firebase for them at all. Costs
come only from **signed-in** players. Figures are from Firebase's published
free quotas; confirm current prices at <https://firebase.google.com/pricing>.

Per signed-in player per day, roughly: 30 function calls, 55 database reads,
35 writes.

| Signed-in players / day | Rough cost |
|---|---|
| up to ~500 | **$0** — inside the free daily quota (20,000 writes, 50,000 reads) |
| ~5,000 | on the order of **$10–15 / month** |

The designs that keep it there:
- **Leaderboards** are one document holding the top 50, not a query — one read
  per view instead of fifty.
- **Community totals** are split across 10 counters and summed into one
  document every 10 minutes — one read per view, and no write queueing.
- **Events** are a file on the website, not database documents — free to show.
- **Saves** are coalesced to one call per 20 s per game in the browser.
- **App Check / reCAPTCHA** only runs for signed-in players. reCAPTCHA has its
  own free monthly allowance; check its usage in the Google Cloud console if
  the player count grows a lot.
