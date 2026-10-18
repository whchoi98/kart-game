# Themes Module

## Role
- Per-theme scenery around a built track: terrain, props, sky layers, animated details, movers and the theme's lighting
  (`EnvironmentSettings`). The drivable surface itself is `../track-mesh.ts`, not a theme.
- Every module implements `SceneryBuilder` from `../contracts.ts`; `index.ts` maps each `ThemeId` to its module.
  `src/client/game/race-session.ts` calls `getSceneryBuilder(theme)({ scene, track, quality, renderer })`.

## Key Files
- `index.ts` - `getSceneryBuilder(theme)`; `MODULES: Record<ThemeId, ThemeModule>` built from namespace imports; throws
  `Scenery theme '<id>' has no buildScenery()` when a module lacks the builder.
- Theme modules (track id from `src/sim/tracks/catalog.ts`, helper library):
  - `meadow.ts` - `sunny-meadow`, props-a. `beach.ts` - `palm-beach`, props-a.
  - `canyon.ts` - `canyon-rally`, props-a. `city.ts` - `neon-city` (night), props-a.
  - `snow.ts` - `frost-peak`, props-b. `jungle.ts` - `jungle-ruins`, props-b.
  - `volcano.ts` - `lava-fortress` (night), props-b. `galaxy.ts` - `starlight-road` (night), props-b.
- `props-a.ts` - helpers for meadow/beach/canyon/city: `Bag`, `Materials`, `Batch`, `addInstanced`, `qcount`, `Glows`,
  `createWaterMaterial`, `buildClouds`, `buildRing`, `Flock`, `Butterflies`, `Reserve`, `MoverRig`; re-exports
  `CorridorGuard`/`withCorridorGuard` from props-b.
- `props-b.ts` - helpers for snow/jungle/volcano/galaxy: `Bin`, `GeoBatch`, `instanced`/`instancedChunks`, liquid, lava, fall and
  aurora shaders, shader-driven precip/puffs/twinkles (no per-frame CPU), `SkyLayer`, `MoverAnimator`, `CorridorGuard`.
- Shared outside this folder: `../theme-palette.ts` (`THEME_PALETTES`, also read by the track mesh), `../terrain.ts`
  (`buildTerrain`, `fbm`, `scatter`), `../textures.ts`.

## Rules
- Contract: `export function buildScenery(ctx: SceneryContext): SceneryHandle` returning `environment`,
  `update(dt, time, camera)`, `createMover(look)` and `dispose()`. `createMover` must return an object for unknown looks too.
  Export the `<THEME>_ENV` constant the handle uses as `environment`.
- Wrap the whole build: `return withCorridorGuard(ctx, () => buildXScenery(ctx))`. Static placements made through
  `addInstanced()` (props-a) or `instanced()`/`instancedChunks()` (props-b) that would stand in the drivable corridor are
  dropped (the sim has no scenery colliders); the report lands on `scene.userData.corridorGuard`. `addInstanced(..., { dynamic:
  true })`, movers and objects added after the build are not guarded.
- Determinism: derive placement seeds from `track.def.scenerySeed` (beach, canyon and city add a fixed offset) and use `Rng` /
  `scatter`.
  `Math.random()` appears only in mover animation phases; keep it out of layout.
- Tier budget: `quality.scenery` is 0.4 / 0.75 / 1 (low / medium / high). props-a themes scale counts with
  `qcount(base, q)`, props-b themes with `Math.round(base * q)`. At low and medium the draw-call budget is tighter than the
  triangle budget (`city.ts` merges blocks in coarser chunks below high).
- Instancing: one `InstancedMesh` per prop kind. Race scenes run `optimizeScene()` and per-instance view/shadow culling
  (`../instance-culling.ts`) after the build, so do not split props into chunks for culling (`instancedChunks` makes one mesh
  unless `chunked: true`). Per-frame animated instances must use `DynamicDrawUsage` (props-a: `dynamic: true`).
- Movers: `race-session.ts` wraps the `createMover()` result in an outer group that gets the sim position and yaw; for
  `HARD_LOOKS` (`boulder`, `snowball`, `log`, `meteor`, `rock`, `lava`) it adds roll to the returned object's `rotation.x`.
  Do not pose the returned root yourself.
- Unfogged backdrops (peak rings, clouds) may sit beyond the fog: the camera far plane is `max(2400, fog.far * 1.15)`.
- `dispose()` frees everything the build created (collect it in a `Bag` or `Bin`).

## How to extend (new theme)
1. Add the id to `ThemeId` in `src/sim/types.ts`, then an entry to `THEME_PALETTES`; both `THEME_PALETTES` and `MODULES` are
   `Record<ThemeId, ...>`, so `npm run typecheck` flags gaps.
2. Create `<theme>.ts` exporting `<THEME>_ENV` and `buildScenery`, built on props-a or props-b.
3. Register it in `MODULES` in `index.ts`.
4. Review the theme branches in `../textures.ts` (`createRoadTextures`, `createGroundTexture`, the `createCliffTexture`
   switch) and `../track-mesh.ts` (viaduct themes `city`/`volcano`, `galaxy` specials, pit visuals from the palette's `pit`).
5. A track using it is a `src/sim/tracks/` change: follow the checklist in `src/sim/tracks/CLAUDE.md` (a new track alone does
   not force a `package.json` bump; editing an existing track's geometry does) and give it its own song
   (`src/client/audio/songs/CLAUDE.md`).
6. Check it with `npm run dev` on `/dev/scenery-a.html?theme=<id>&quality=high` or
   `/dev/scenery-b.html?theme=<id>&track=<track-id>&q=high` (scenery-b only: `&split=1` for split screen; without `track`
   an unmapped theme falls back to `frost-peak`), then `npx tsx tools/perf-views.ts --tracks <track-id>` against the QA
   server (see `../CLAUDE.md`).

## Testing
- No unit test builds a real theme: `test/client/game-session.test.ts` and `test/client/game-view.test.ts` mock
  `render/themes/index.js`. Coverage is the type checker, the dev pages above and the perf tools.
