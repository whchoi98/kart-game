# Client Module

## Role
Browser app built by Vite with `root: 'src/client'` and `publicDir: '../../public'` (`vite.config.ts`). `main.ts` wires the 3D
`GameView`, procedural WebAudio, input, the DOM app shell and the PWA manager. Every visual and sound is generated in code
(no remote assets). Subsystems meet only through `contracts.ts`; the deterministic simulation lives in `src/sim/`.

## Key Files
- `index.html`: production shell (`lang="ko"`, `#view` canvas host, `#ui` splash, manifest and icons, critical inline `<style>`).
- `main.ts`: boot order. 1) `new PwaManager(__APP_VERSION__)` first, so an early `beforeinstallprompt` is kept. 2) `webglAvailable()`
  probe (Korean fatal screen on failure). 3) `createInputManager()`, with `input.rumble` wrapped to honour `settings.rumble`.
  4) `createAudioSystem()`. 5) `createGameView({audio, input}).mount(#view)`. 6) `startApp(...)`. 7) `pwa.getInRace` and
  `pwa.beforeReload` wired to the app. 8) `pwa.start()` after `app.whenReady`. 9) `installDebugHook` only when `__DEBUG_HOOK__`.
- `contracts.ts`: `Settings`/`DEFAULT_SETTINGS`, `InputManager`, `AudioSystem`, `HudSnapshot`, `GameView`, `GhostData`,
  `TimeTrialRecord`, `RaceSummary`, `*Setup` types.
- `api.ts`: `/api/*` fetch client (8 s timeout), `ApiRequestError` kinds, `CODE_MESSAGES` (server code to Korean text).
- `storage.ts`: `GameStorage` (localStorage, in-memory fallback), `sanitizeSettings` and per-record sanitizers, pending runs.
- `pwa.ts`: `PwaManager` (SW registration, install prompt, update apply, answers `QUERY_RACE_STATUS`).
- `sw.ts`: service worker; `tools/build.mjs` bundles it with esbuild into `dist/client/sw.js` (iife), not through Vite.
- `sw-policy.ts`: pure SW policy (`cacheRoute`, `shellMatchesBuild`, `lastGoodCandidates`, `obsoleteCaches`, `CACHE_PREFIX`, `BUILD_META`).
- `env.d.ts`: declares `__APP_VERSION__` and `__DEBUG_HOOK__` (Vite `define`).
- `styles.css`: global tokens (`--ink`, `--p1`, `--p2`, `--font-display` Black Han Sans, `--font-body` Jua); imported by `ui/app.ts`.
- `ui-preview.html` / `ui-preview.ts`: real app shell on `ui/mock-view.ts` + `ui/mock-audio.ts`, no `PwaManager`.
  Open `http://localhost:8200/ui-preview.html?mockapi&speed=4` under `npm run dev`; not part of the release build.
- Subdirectories (each has its own CLAUDE.md):
  - `audio/`: WebAudio synthesis, SFX, song sequencer (`audio/CLAUDE.md`, `audio/songs/CLAUDE.md`).
  - `dev/`: render QA pages for the Vite dev server only (`dev/CLAUDE.md`).
  - `game/`: sim + render + audio glue: `GameView`, `RaceSession`, `HudModel` (`game/CLAUDE.md`).
  - `input/`: keyboard, gamepad, touch to `KartInput` and menu actions (`input/CLAUDE.md`).
  - `render/`: three.js pipeline, karts, track mesh, particles (`render/CLAUDE.md`, `render/themes/CLAUDE.md`).
  - `ui/`: framework-free DOM shell, screens, HUD, flows (`ui/CLAUDE.md`, `ui/screens/CLAUDE.md`, `ui/art/CLAUDE.md`).

## Rules
- **Korean first.** Every player-visible string is Korean (`index.html` and `public/manifest.webmanifest` use `lang` `ko`); English
  appears only as decorative labels (`GO!`, `FINISH!`, `FINAL LAP`, `km/h` ...). A new server error code needs a Korean entry
  in `api.ts` `CODE_MESSAGES`. Player text (nicknames) goes in via `textContent`; `innerHTML` only takes trusted static markup.
- **`contracts.ts` is the boundary.** `ui/` never imports `game/` or `render/`; it gets `GameView`, `AudioSystem` and `InputManager`
  through `startApp(deps)`. Sole exception: `ui/screens/race.ts` imports the `TurboInputManager` type for `holdAutoAccelerate`.
  Changing an interface means updating every implementer: `game/index.ts`, `ui/mock-view.ts`, `audio/system.ts`, `audio/noop.ts`,
  `ui/mock-audio.ts`, `input/index.ts`, and the fakes in `test/client/game-harness.ts`.
- **New `Settings` field:** `contracts.ts` (`Settings` + `DEFAULT_SETTINGS`), `storage.ts` `sanitizeSettings` (without it the value
  resets on every load), a row in `ui/screens/settings.ts`, the consumer, and tests in `test/client/storage*.test.ts`.
- **QA hook.** `__DEBUG_HOOK__` is true only under `vite serve` (`npm run dev`), `TURBO_DEBUG_HOOK=1 node tools/build.mjs` and
  `tools/vite-qa.config.mjs`; release builds compile `installDebugHook` out. With `?debug` it sets `window.__turbo = { view, app,
  ready, startRace(config, { autopilotHuman?, ghost? }), state() }`; `?debug&quality=` goes through `app.setViewOverride` and is
  never saved. Keep QA-only code behind `if (__DEBUG_HOOK__)` and never deploy a `TURBO_DEBUG_HOOK=1` build. The header comment
  in `tools/qa-screens.ts` shows an outdated `startRace(config, ghost?)`; `main.ts` is the truth.
- **CSP** (`src/shared/csp.ts`, served by `src/server/security.ts` and `infra/lib/edge.ts`): `script-src 'self' blob:` means no
  inline `<script>`, no `eval`/`new Function`, no remote scripts. `connect-src`, `img-src`, `font-src` are self (+ `data:`/`blob:`):
  no CDNs, analytics or remote fonts (fonts come from `@fontsource`). `style-src 'unsafe-inline'` exists only for the inline
  `<style>` in `index.html`. `form-action 'none'`: handle input in script, never submit a form. Permissions-Policy allows only
  gamepad, fullscreen, screen wake lock and autoplay; accelerometer and gyroscope are blocked.
- **Never swap versions mid-race.** `PwaManager.applyUpdate()` refuses while `getInRace()`, and background update checks skip
  races. On `ACTIVATE_UPDATE` the SW sends `QUERY_RACE_STATUS` to every window (2 s timeout counts as busy) and calls
  `skipWaiting()` only if all answer idle and no new window appeared; `CLIENT_STATUS` can veto, never authorise. Keep
  `pwa.getInRace` a live read (`view.inRace || app.raceActive`); a race lasts until the player leaves the results screen.
- **Build meta and `build.json` must match.** `tools/build.mjs` stamps `<meta name="turbo-pals-build">` into
  `dist/client/index.html` and writes `dist/client/build.json` `{id, version}` with the same 16-hex id; `shellMatchesBuild`
  demands exactly one such meta equal to `build.json.id`, else install fails. Never hand-write that meta in `index.html`.
  The id also hashes `sw.ts` and `sw-policy.ts`, so a worker-only change still ships as a new build.
- **Precache list is generated** by `tools/build.mjs`: every `dist/client` file plus `/build.json`, minus `sw.js`, `/dev/*` and
  `*.woff`. Never maintain it by hand. Cache-first routing covers only `/assets/`, `/icons/` and `STATIC_FILES` in
  `sw-policy.ts`; add a new top-level `public/` file there or it fails offline. `/api`, `/healthz`, `/sw.js` always hit the network.
- The SW registers only in production builds (`import.meta.env.PROD`). `sw.ts` runs in a worker: import only `sw-policy.ts`.
- **Storage keys** are `tpgp.v1.*` (prefix built from `STORAGE_VERSION = 1`): `meta`, `settings`, `playerId`,
  `best.<track>.<cc>`, `trophies`, `stats`, `pending`, plus sessionStorage `tpgp.v1.reload` (a literal in `ui/app.ts`, valid
  5 minutes) across an update reload. Bumping `STORAGE_VERSION` orphans all saved data (`migrate()` only stamps `meta`;
  nothing copies old keys); prefer additive fields with sanitizer defaults. Treat stored JSON as hostile: every read goes
  through a sanitizer. At start-up `dropStalePendingRuns` deletes queued runs from another version core (the server would
  answer `VERSION_MISMATCH`).

## Testing
- `npm test`; client-root scope: `npx vitest run test/client/sw-policy test/client/pwa-ui test/client/storage`.
- `npm run typecheck` also covers `dev/` and `ui-preview.ts` (`tsconfig.json` includes `src`).
- Vite's dev server sends no CSP and registers no SW: check CSP- or PWA-sensitive changes with `npm run build && npm start`
  (`http://127.0.0.1:8080`). `npm run verify:live` asserts the live CSP keeps `script-src` self-only (needs AWS
  credentials; `npm run verify:live -- --no-e2e` skips its real leaderboard submission).
- `npm run qa:screens` drives `?debug` races on a running dev server (default `http://127.0.0.1:8200`).
