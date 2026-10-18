# Dev Pages Module

## Role
Development-only render QA pages. Each `.html` here is a standalone Vite page that exercises render modules
(`src/client/render/`) in isolation or through the real pipeline, and exposes `window.__*` hooks for ad-hoc Playwright
probes and screenshots. Nothing here ships to players.

## Key Files
Open with `npm run dev`, then `http://localhost:8200/dev/<page>.html?...` (the Vite root is `src/client`). The QA server
`npx vite --config tools/vite-qa.config.mjs --port <PORT> --strictPort` serves the same paths without HMR.
- `fx.html` / `fx.ts`: render pipeline, camera rig and particles. `?quality=` (default `high`), `?track=` (default
  `sunny-meadow`), `?scenery`; `?live` free-runs with keys B boost, L look back, I ink, S split, N night, D drift, P burst.
  Hooks: `__fx` (scripted API), `__ready`.
- `karts.html` / `karts.ts`: kart, driver and item assets and the showroom. `?view=lineup|states|items|close|back|all`,
  `?char=`, `?mode=title|garage|podium`, `?q=low|medium|high`, `?t=` (pre-simulate seconds), `?freeze`, `?pipe=real`
  (real `RenderPipeline` with bloom; default is the stand-in). Hooks: `__ready`, `__stats`, `__advance`, `__room`,
  `__roomCycle`, `__entries`, `__bench`, `__parts`, `__disposeTest`.
- `karts-race.ts`: loaded by `karts.html?race=<trackId>[&follow=i&chaos=1&seed=&dist=&t=]`: a real `RaceWorld` with 8 CPU karts
  rendered through the real pipeline, scenery and track mesh. Hooks: `__advance(s)`, `__seek(state, maxS)`,
  `__nanCheck(frames)`, `__coverage`.
- `karts-stage.ts`: `createStandInPipeline` (minimal `RenderPipeline` stand-in) and `buildTestStage` (sky, sun, pad).
- `scenery-a.html` / `.ts`: meadow, beach, canyon, city scenery. `?theme=&quality=&pit=1&mirror=1&animate=1&pipe=0&mesh=1&track=
  &movers=direct` (`pipe=1` real pipeline is the default). Hooks: `__saSetView`, `__saViews`, `__saLook`, `__saStats`,
  `__saReady`, `__saError`, `__saDispose`.
- `scenery-b.html` / `.ts`: snow, jungle, volcano, galaxy scenery. `?theme=&track=&q=&pipe=0&mesh=0&looks=a,b&auto=1&split=1`.
  Hooks: `__ready`, `__shot`, `__info`, `__sceneryStats`, `__tris`, `__hide`, `__movers`, `__dispose`.
- `track.html` / `.ts`: `render/track-mesh.ts` preview with its own composer. `?track=<id>|test-figure8&theme=&quality=&mirror=1
  &view=&hud=0&hide=&noterrain=1&animate=1`. Hooks: `__ready`, `__error`, `__views`, `__show`, `__stats`, `__breakdown`,
  `__disposeTest`, `__validate`.

## Rules
- **Never part of the release bundle.** `vite.config.ts` sets no `build.rollupOptions.input`, so `vite build` emits only
  `index.html` and its assets (a local `dist/client` has no `dev/`). `tools/build.mjs` also filters `/dev/` out of the SW
  precache list, and the server serves only `dist/client`. Do not add these pages to a build input or link them from the app.
- They are still type-checked (`tsconfig.json` includes `src`): when a render or sim API changes, fix the dev pages in the
  same change so `npm run typecheck` stays green.
- Dev pages may import anything from `src/sim/` and `src/client/render/`; production code must never import from `dev/`.
- Keep hooks off the shared `Window` type: cast (`window as unknown as {...}`) as `karts.ts` and `track.ts` do.
  `scenery-a.ts` (`__sa*`) and `scenery-b.ts` use `declare global`, which merges across every page; a second global
  declaration of the same name with another type breaks typecheck (that is why scenery-b uses `__sceneryStats`).
- Mover posing mirrors `src/client/game/race-session.ts` (outer group with sim yaw, roll for `HARD_LOOKS`).
  `scenery-a.ts` and `scenery-b.ts` keep their own `HARD_LOOKS` copy: update them with the game's set.
- Stand-ins (`karts-stage.ts`, `scenery-*?pipe=0`, `track.ts` composer) only approximate the real pipeline; judge final
  looks with the real pipeline (`?pipe=real` on karts, default on fx, scenery and `?race=`).
- Labels and HUD text here are developer-facing; the Korean-first rule applies only to player-visible UI.

## Gotchas
- No versioned script drives these pages. The `fx.ts` header mentions `test-results/fx/shoot.mjs`, but `test-results/` is
  git-ignored, so that script is local-only.
- `scenery-a` and `scenery-b` render into a fixed 1280x720 `#app`; screenshot at that size.

## Testing
- `npm run typecheck` is the only automated guard. For a visual check, open the page and read its `#hud` or hooks
  (`__stats`, `__sceneryStats`, `__breakdown`) for draw calls and triangle counts.
