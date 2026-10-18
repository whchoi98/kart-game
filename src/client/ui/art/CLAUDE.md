# UI Art Module

## Role
- Original, code-generated artwork for the menus and HUD: inline SVG strings (UI glyphs, trophies, item icons, driver portraits), a text-built wordmark, and Canvas 2D track outlines. There are no image files; everything is drawn from code plus the static data in `src/sim/`.
- Consumers: `svg()` / `icon()` / `portrait()` in `../dom.ts` and `../widgets.ts` wrap the SVG strings; `../hud.ts` shows item icons and the coin; `../hud-minimap.ts` turns portraits into `data:image/svg+xml` images and draws the outline; `../thumb.ts` paints track thumbnails; `logo()` heads the boot, title, main-menu and credits screens; `THEME_COLORS` also tints track cards, the race loading card and the mock view. Nothing outside `src/client/ui/` imports this directory.

## Key Files
- `icons.ts` — `ICON` map of 40 glyphs (viewBox 0 0 24 24, `currentColor`, so CSS sets the colour), `IconName`, and `trophySvg(tier)` (gold / silver / bronze / null, tier colour baked in).
- `item-icons.ts` — `itemSvg(id)` for all 14 items (viewBox 0 0 64 64, colours from `ITEMS` in `src/sim/item-defs.ts`; the triple items reuse the single drawing through `triple()`), and `COIN_SVG`. Markup is cached per id.
- `portraits.ts` — `portraitSvg(id)`: one head per `Species` (penguin, bear, rabbit, dino, fox, raccoon, cat, robot) on a shared round badge, painted with the character's `body` / `accent` / `fur` / `detail` colours from `src/sim/characters.ts`; cached per character. Exports `INK` (`#1b1036`, the outline colour also used by item icons and the minimap) and `mix()`.
- `logo.ts` — `logo('hero' | 'small')`: the `TURBO PALS / GRAND PRIX` wordmark made of styled text (`role="img"`, bilingual `aria-label`); styles in `../screens-menu.css`.
- `track-draw.ts` — `THEME_COLORS` (a / b / road / edge per `ThemeId`), `outlineFromBuilt`, `fitOutline`, `project`, `drawOutline`, `prepareCanvas` (devicePixelRatio capped at 2). Projection seen from above: screenX = −x, screenY = −z.

## Rules
- Original designs only. Draw new shapes; never copy, trace or imitate third-party characters, logos, item designs or trademarks. `docs/design.md` and the credits screen (`../screens/credits.ts`) promise that every character, item, track, graphic and piece of music is original; the credits also call the portraits and item icons hand-drawn SVG.
- No external assets: do not add image files, remote URLs, CDNs or icon fonts here. Typography comes from the two OFL `@fontsource` packages imported in `../app.ts`.
- The strings are inserted with `innerHTML` (through `svg()`): keep them static and interpolate only colours and names from sim data, never user input.
- No `<defs>`, ids or `url(#...)` references, so any number of copies can share one document. Keep `xmlns` on the root `<svg>`: the minimap loads portraits as data-URI images.
- Thick `INK` outlines with flat fills are the shared look; reuse the `S` stroke constant instead of new outline colours.
- `HEADS` (`Record<Species, ...>`), `DRAW` (`Record<ItemId, ...>`) and `THEME_COLORS` (`Record<ThemeId, ...>`) are exhaustive: a new species, item or theme in `src/sim/types.ts` fails `npm run typecheck` until its art exists here.
- The map projection (screenX = −x, screenY = −z) is written out in three places that must agree: `outlineFromBuilt`, `project`, and the marker maths in `../hud-minimap.ts` (`ox - x * scale`, `oy - z * scale`; it does not call `project`). Change one without the others and karts drift off the minimap outline.
- `svg()` marks its wrapper `aria-hidden`, so the art is decorative: give the surrounding control a text label.
- One-off SVG that lives with its only user follows the same rules: ink blobs and speedometer gauge in `../hud.ts`, gamepad diagram in `../screens/controls.ts`.

## How to extend
- Icon: add a key to `ICON` (24 x 24, `currentColor`, stroke via `ST`), then use `icon('name')` from `../widgets.ts`.
- Character species: add a head to `HEADS` drawn on the 100 x 100 badge with the character colours `c`.
- Item: add a drawing to `DRAW`, coloured with `ITEMS[id].color` / `color2` (the arguments `c`, `c2`).
- Theme: add a `THEME_COLORS` entry (`a` / `b` gradient, `road` and `edge` for outlines).

## Testing
- No unit tests cover this directory; `npm run typecheck` enforces the exhaustive records.
- Check visually in `ui-preview.html?mockapi` (character select, course select, HUD items and minimap in the mock race, podium trophies) and with `npm run qa:screens` for the real HUD.
