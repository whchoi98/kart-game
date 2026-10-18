# UI Module

## Role
- Framework-free DOM app shell: screen stack with animated transitions, menu input routing, modals / toasts / busy overlay, hint bar, music and backdrop cues, settings, the `pwa` / `net` / `pending` / `race` event bus, and the race HUD.
- Entry point `startApp(deps)` in `app.ts`. `src/client/main.ts` starts it on the real GameView; `src/client/ui-preview.ts` starts it on `mock-view.ts` + `mock-audio.ts`. Screens live in `screens/`, code-generated artwork in `art/`.

## Key Files
- `app.ts` — `App`: stack (`push`, `replace`, `back`, `popTo`, `resetTo`, `toMainMenu`, `toTitle`), `applyScreenEnv`, menu routing (open modal, then `screen.onMenu`, then Nav defaults), `modal` / `confirm` / `busy` / `notify` (at most 3 toasts), `on(event)`, `setRaceActive`, `updateSettings`, `setViewOverride`, `persistForReload`. Imports every UI stylesheet and the two `@fontsource` fonts.
- `screen.ts` — `Screen` contract, `BaseScreen` (`own()` registers disposers), `frame()` header (back button, kicker, title ribbon, step trail), `DEFAULT_HINTS`.
- `dom.ts` — `h`, `append`, `svg` (trusted static markup only), `clear`, `setText`, `prefersReducedMotion`, `animate`, `countUp`, `wait`.
- `nav.ts` — `Nav`: spatial focus over `[data-nav]` stops, `.is-focus`, mouse-hover focus; `setAdjust` lets a focused row consume left / right.
- `widgets.ts` — `button`, `choice`, `toggle`, `slider`, `stepper`, `textRow`, `tabs`, `statBars`, `portrait`, `icon`, `shake`.
- `flows.ts` — setup chains per mode and `GrandPrixSession` / `VersusSession` / `TimeTrialSession`, `challengeGhost`, `runDebugRace` (used by the `?debug` hook in `src/client/main.ts`).
- `hud.ts`, `hud-minimap.ts` — one `Hud` per human player (duo = two halves): DOM writes only on change, animation through WAAPI; the minimap caches the track outline offscreen.
- Pure, DOM-free logic (tested in node): `format.ts` (times, deltas, positions, `validatePlayerName`), `gp.ts` (points, standings, reverse grid, trophies), `grid.ts` (`randomSeed`, `seededRandom`, `buildGrid`, `make*Config`), `input-hold.ts`, `memory.ts` (`restoreMemory`), `pwa-state.ts`.
- `pwa-ui.ts` — offline chip / detail, install button and iOS guide, update banner and `applyUpdate`, pending-run notice and `submitPendingRuns`, `clientBuild()`.
- `thumb.ts` — track thumbnails (`paintTrackThumb`, cached outlines, seeded placeholder when the track cannot be built).
- Preview only: `mock-view.ts` (2D backdrop and a scripted fake race), `mock-audio.ts` (square-wave UI blips, silent music), `mock-api.ts` (`window.fetch` shim for `/api/*`).
- CSS: `ui.css` (layers, buttons, rows, modals, toasts, hints), `screens-menu.css` (boot, title, logo, menu, setup), `screens-extra.css` (race overlays, results, leaderboard, settings, guide, credits, responsive), `hud.css` (em-based so duo halves scale together), `pwa.css`.

## Rules
- Korean first: every player-facing string is Korean (`lang="ko"`). English is decoration only: `GO!`, `FINISH!`, `FINAL LAP`, `NEW RECORD`, `LAP`, `BEST`, `TIP`, `km/h`. A new server error code needs a Korean message in `CODE_MESSAGES` (`src/client/api.ts`).
- Text goes through `h()` text nodes or `textContent`. `svg()` and `innerHTML` take only static markup from this module; never interpolate user input (nicknames, leaderboard names).
- Keep the pure files listed above free of DOM and three.js: `src/client/storage.ts` imports `format.ts` and `gp.ts`, and vitest runs in the node environment.
- Nickname rules in `format.ts` mirror `normalizeName` in `src/server/validation.ts` and `API_LIMITS` in `src/shared/api.ts`; change all three together.
- Every control reachable by keyboard or gamepad is a `[data-nav]` stop (widgets add it on the row; inner pills, tabs, stepper buttons and the `frame()` back button are pointer-only with `tabIndex = -1`; `data-autofocus` picks the first focus). Locked options are not hidden: a locked `button` (`locked`, sets `aria-disabled`), `toggle` or `choice` pill still reacts with the `error` sound, a shake and a toast with the unlock reason.
- Accessibility: modals are `role="dialog"` with `aria-modal`; toasts live in an `aria-live` layer; a leaving screen gets `inert` (Nav skips it); `svg()` spans and the HUD are `aria-hidden`. Animate only through `animate()` / `countUp()` so `prefers-reduced-motion` is honoured.
- Input holds: a screen reached by a press must not fire on the same mash (Space is both drift and confirm). Use `InputHold` (results 500 ms, podium 1500 ms; movement is never held) and guard deferred callbacks with `app.top === this`.
- `App.updateSettings` saves and applies; `setViewOverride` reaches the 3D view only and is never saved. `GameView.applySettings` mutates the settings object in place because `RaceSession` reads it live.
- `RaceScreen` holds `setRaceActive` from `run()` until `leaveRace()` / `dispose()`; the update banner and `applyUpdate` refuse while `app.raceActive`.
- `SetupMemory` (`App.memory` in `app.ts`) is never written to localStorage; it lives for the session and crosses an update reload only through `persistForReload`. A new field needs its default in `App.memory`, a validator in `restoreMemory` (`memory.ts`) and the defaults in `test/client/pwa-ui.test.ts`, or it resets after every update reload.
- `mock-view.ts` and `mock-audio.ts` implement `GameView` / `AudioSystem` from `src/client/contracts.ts`: a contract change must update them too (`npm run typecheck` fails otherwise).

## How to extend
- New screen: follow `screens/CLAUDE.md`.
- New setting, touch every place:
  1. `Settings` and `DEFAULT_SETTINGS` in `src/client/contracts.ts`.
  2. `sanitizeSettings` in `src/client/storage.ts` (without a check the value falls back to the default on every load).
  3. A `toggle` / `choice` / `slider` row in `screens/settings.ts` with `onChange: v => set({ field: v })`.
  4. The consumer: `App.applySettings` (audio volumes, view, input), `InputManager.applySettings` in `src/client/input/index.ts`, `GameView.applySettings` in `src/client/game/index.ts`, or a live read of `deps.settings` in `src/client/game/race-session.ts`. A HUD toggle also needs `HudOptions`, the initial value in `RaceScreen.buildHuds` and the refresh in `RaceScreen.show` (settings can change from the pause menu).
  5. Round-trip and invalid-value tests in `test/client/storage.test.ts`.

## Testing
- `npx vitest run test/client/ui- test/client/pwa-ui`: `ui-format`, `ui-gp`, `ui-journey-fixes` (`formatLapTicks`, `leaderboardVersion`), `ui-verify-fixes` (`InputHold`, profile stats), `pwa-ui` (`pwa-state`, `restoreMemory`).
- There is no DOM test environment. Check screens in the preview: run `npm run dev`, open `http://localhost:8200/ui-preview.html?mockapi&speed=4`. Check the real race HUD with `npm run qa:screens` against the running dev server.
