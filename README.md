# Alloy Studios — one site, every game

This folder is the whole website. Push it to the repo **`alloy-studios/alloy-studios.github.io`**
and you get:

| URL | What it is |
| --- | --- |
| `alloy-studios.github.io/` | Front page: featured game, a few short rows, news at the bottom |
| `alloy-studios.github.io/all/` | The whole library with tag filters (`/all/?tag=anime` deep-links a filter) |
| `alloy-studios.github.io/snake/` | Snake, inside the shared shell (logo, search, fullscreen) |
| `alloy-studios.github.io/tetris/` | Tetris, inside the **same** shell |
| anything else | `404.html`, which suggests the closest game |

Every game page is the same shell around a different `<iframe>`. Change the shell
once and all games change together.

---

## How it works

```
alloy-studios.github.io/
├── index.html            front page
├── all/index.html        the full library
├── 404.html              not-found + suggestions
├── .nojekyll             stops GitHub eating folders that start with "_"
├── assets/
│   ├── shell.css         ALL the site styling — the one file to restyle
│   ├── shell.js          header, logo, search, nav (shared by every page)
│   ├── home.js           front page: hero, rows, news
│   ├── all.js            the full library grid + tag filters
│   └── player.js         game page: frame, fullscreen, restart, about
├── data/games.json       the single source of truth: every game's metadata
├── data/news.json        the posts listed at the bottom of the front page
├── games/
│   └── orbit-dash/       the raw game, exactly as it was in its old repo
│       └── index.html
└── orbit-dash/
    └── index.html        the wrapper page served at /orbit-dash/
```

Two folders per game is the point:

- `games/<id>/` is your game, **untouched**. It keeps its own CSS, its own
  `body { margin: 0 }`, its own everything. Nothing in the shell can collide
  with it and nothing in it can break the shell.
- `/<id>/` is a wrapper page that draws the site chrome and loads
  `games/<id>/` in an iframe. It is *byte-identical for every game* — the game
  it loads is read from the URL. That is how 30 games share one design.

This is the same structure CrazyGames and Itch use, for the same reason.

---

## Migrating your existing games

### The one thing that will bite you

GitHub Pages serves a repo named `snake` at `alloy-studios.github.io/snake` — and a
**project page wins over a folder of the same name in your user site**. So while
the old `alloy-studios/snake` repo still has Pages enabled, your new `/snake/` folder
is invisible.

The fix is also the good news: **turn Pages off on the old repo** (Settings →
Pages → Source → None). The URL `alloy-studios.github.io/snake` then falls through to
the new unified site — *the exact same address*, now with the shell around it.
Every link you have ever shared keeps working. You do not have to delete or
rename any repo; just switch Pages off.

Do this one game at a time, so you can check each one.

### Per game

1. Import it:

   ```bash
   powershell -ExecutionPolicy Bypass -File tools\import.ps1 -Repo snake -Title "Snake" -Tags "arcade,classic" -Controls "Arrow keys to move"
   ```

   That clones `alloy-studios/snake` from GitHub, copies it into `games/snake/`,
   adds it to `data/games.json`, creates `/snake/index.html`, and warns you about
   anything likely to break. For a game that is not on GitHub, swap `-Repo snake`
   for `-Path "C:\path\to\snake-folder"`.

2. Preview it locally (see below) and play it for real.
3. Push, then turn Pages off on the old `snake` repo.

Doing it by hand instead of the script is three steps: copy the folder to
`games/snake/`, add an entry to `data/games.json`, copy `tools/wrapper.html` to
`snake/index.html`.

### What usually breaks, and the fix

- **Root-absolute paths.** A game that used `src="/sprites/hero.png"` worked when
  it owned the whole site; now it lives under `/games/snake/`, so it must be
  `src="sprites/hero.png"`. `import.ps1` lists every file that has one.
- **Case.** GitHub Pages is case-sensitive; Windows is not. `Hero.PNG` referenced
  as `hero.png` works locally and 404s live.
- **`localStorage` keys.** All your games now share one origin, so two games both
  using the key `highscore` will clobber each other. Prefix them: `snake.highscore`.
- **Godot 4 with threads.** Needs COOP/COEP headers that GitHub Pages cannot send.
  Export the single-threaded/compatibility build.
- **Folders starting with `_`.** Handled — `.nojekyll` is already in this repo.

---

## Updating a game that is already on the site

**This site keeps its own copy of every game.** Pushing a new version to the
`rivalforge` repo does nothing to the site until you pull that version in here.
Three commands, every time:

```bash
powershell -ExecutionPolicy Bypass -File tools\import.ps1 -Repo rivalforge
```

```bash
git add -A && git commit -m "Update Rivalforge" && git push
```

The import clones the current state of the repo from GitHub, replaces
`games/rivalforge/` with it, and **leaves your title, tagline, description and
tags exactly as they are** — it only overwrites the game files. Anything you
deleted upstream disappears here too, so no orphans build up.

Same command for a brand-new game; the only difference is that a new one also
gets an entry added to `data/games.json` for you to fill in.

---

## Adding or editing a game later

`data/games.json` is the whole content model:

```json
{
  "id":          "snake",              // the URL: /snake/ — lowercase, hyphens
  "title":       "Snake",
  "tagline":     "One line for the card",
  "description": "A paragraph for the game page.",
  "tags":        ["arcade", "classic"],
  "controls":    "Arrow keys to move",
  "accent":      "#22c55e",            // optional; colours the placeholder art
  "thumb":       "/assets/thumbs/snake.png",  // optional; overrides the art
  "aspect":      "4/3",                // optional; letterbox instead of fill
  "featured":    true,                 // optional; one game gets the hero slot
  "added":       "2026-09-08"
}
```

Then re-run the build so the wrapper pages match the manifest:

```bash
powershell -ExecutionPolicy Bypass -File tools\build.ps1
```

Add `-Prune` to also delete wrapper folders for games you removed from the JSON.

Games without a `thumb` get a generated gradient tile with their initials, which
is deterministic per game — so you can ship first and screenshot later.

---

## Editing the front page

The front page is about the studio, not the catalogue: masthead, what Alloy
Studios is, one spotlight game, contact, then news. Every word of it comes from
the `site` block at the top of `data/games.json` — no code to touch:

```json
"site": {
  "name":    "Alloy Studios",
  "tagline": "the one line under the logo",
  "intro":   "the paragraph under that",
  "about":   ["first paragraph of About the studio", "second paragraph"],
  "contact": "fatihturel12@gmail.com"
}
```

`about` takes as many paragraphs as you put in the array. The **spotlight game**
is whichever game has `"featured": true`, falling back to the most recently
added one — so moving the spotlight means moving that one flag.

---

## Posting news

The front page ends with a news list, read from `data/news.json`. Add a post to
the **top** of the array — they render in file order, so newest goes first:

```json
{
  "date":  "2026-09-14",          // YYYY-MM-DD, shown as "Sep 14, 2026"
  "title": "Cosmic Climb update",
  "body":  "One paragraph. Plain text, no HTML.",
  "game":  "cosmic-climb"          // optional; adds a "Play ..." link. null for none
}
```

No rebuild needed — the page fetches this file at load. Just commit and push.
If `news.json` is missing or broken the front page still renders, minus the
news section.

---

## Previewing locally

```bash
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

Then open <http://localhost:8080/>. You need the server rather than
double-clicking `index.html`, because the pages `fetch()` `data/games.json` and
browsers block that over `file://`.

---

## Publishing

First time, from this folder:

```bash
git init -b main
git add -A
git commit -m "One site for every game"
git remote add origin https://github.com/alloy-studios/alloy-studios.github.io.git
git push -u origin main
```

If that repo already exists with a different history, `git pull --rebase origin main`
first, or push to a branch and merge on GitHub. After that it is the usual
`git add -A && git commit -m "Add Tetris" && git push`. GitHub Pages redeploys in
about a minute.

---

## The Weebly site

Once a few games are live, `alloy-studios.weebly.com` has nothing left to do —
`alloy-studios.github.io` *is* the index now. Point the Weebly homepage at it (a single
link, or a redirect) rather than maintaining two lists that drift apart.

---

## Restyling everything at once

- Colours, spacing, fonts, card and header design → `assets/shell.css`
  (the `:root` variables at the top cover most of it).
- Logo → the `LOGO` constant in `assets/shell.js`, and `assets/favicon.svg`.
- What the header contains → `renderHeader()` in `assets/shell.js`.
- What a game page contains (toolbar buttons, about section, more-games strip)
  → `assets/player.js`.
- The wrapper page skeleton → `tools/wrapper.html`, then re-run `build.ps1` to
  copy it over every game.

Never edit a `<game>/index.html` directly — the build overwrites it.
