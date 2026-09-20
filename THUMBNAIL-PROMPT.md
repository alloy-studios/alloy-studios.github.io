# Thumbnail prompt

Paste the block below into the chat for a game. Replace `<GAME-ID>` with that
game's repo name (`redwater`, `hardburn`, `grand-line`, …) — it must match the
`id` in `data/games.json` exactly.

Drop the returned PNG into `assets/thumbs/`, then tell Claude Code and it will
wire up the `thumb` field and push.

---

```
Make the store thumbnail for this game.

DELIVERABLE
One PNG file named exactly <GAME-ID>.png, 1200x900 pixels (4:3). Nothing else.

HOW TO MAKE IT
Do not draw it by hand or with an image generator. Render it with this game's
own code, so it actually looks like the game:
1. Copy index.html to a scratch file.
2. Add a thumbnail mode that sets the canvas to 1200x900, seeds a good-looking
   game state (mid-action, not the title screen, not an empty field), renders a
   single frame, hides all HUD/menus/debug overlays, and exports the canvas via
   toBlob() to a download.
3. Run it, grab the PNG, delete the scratch file. Do not commit the scratch file
   and do not change the real game.

WHAT THE IMAGE MUST SHOW
- A real moment of play, staged deliberately: the player, the main threat or
  objective, and the signature thing this game does. Pick the frame you would
  use to convince someone to click.
- This game's own art direction, unchanged. Do not invent a new style, do not
  add effects the game does not have.

HARD RULES
- No text, no title, no logo, no watermark, no border or rounded corners. The
  site prints the game's name underneath the image.
- No HUD, score, menus, buttons, tutorial prompts, debug readouts or cursor.
- It gets displayed as small as 190x143 px. Open your PNG, shrink it to that,
  and look: one clear focal point, large shapes, strong contrast. If it turns to
  mush, restage it — more zoom, fewer objects, bigger subject.
- The site sometimes crops it to a wide banner, keeping the middle ~55% of the
  height and full width. Keep everything essential inside that centre band;
  leave the top and bottom edges expendable.
- It sits on a very dark page (#0b0d14). Avoid a near-black image that
  dissolves into the background — make sure something in it is bright.
- No transparency. Fill every pixel.

CHECK BEFORE YOU HAND IT OVER
- Exactly 1200x900, PNG, named <GAME-ID>.png
- Viewed at 190px wide it still reads as this specific game
- No text anywhere in the image
- Someone who has never seen it could guess the genre from the picture alone
```
