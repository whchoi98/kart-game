# Render Module

## Role
- three.js r186 (`three` 0.186.0) rendering for races and menus: pipeline, shared environment, shadows, bloom, split screen,
  chase camera, karts, items, particles, track mesh, terrain, sky and the menu showroom. Everything is procedural (no image or
  model assets).
- Each file implements one interface from `contracts.ts`; `src/client/game/` wires them together (`race-session.ts` builds the
  race scene). Render imports nothing from `game/`, `ui/` or `audio/`; from `src/sim/` it reads types and pure helpers only
  (`characters`, `constants`, `track-query`, `rng`).

## Key Files
- `contracts.ts` - the boundary: `QUALITY_PRESETS` (low/medium/high), `EnvironmentSettings`, `SceneryContext`/`SceneryHandle`,
  `KartVisual`, `ParticleKind`, `CameraRig`, `RenderPipeline`, `Showroom`. Change an interface here first.
- `renderer.ts` - `createRenderPipeline()` returns `RenderPipelineExt` (adds `stats`, `setRaceActive`, `warmUp`): WebGLRenderer
  (ACES, `PCFShadowMap`), shared environment group, texel-snapped sun shadow box, single/split render, auto quality governor.
- `post.ts` - `ViewOverlay` (speed lines, ink), `OverlayPass` (no-bloom path), `BloomChain` (HDR MSAA target, `UnrealBloomPass`,
  ACES + sRGB + overlay composite; one chain per view).
- `camera.ts` - `createCameraRig()` (chase, intro flyover, finish orbit, shake), `effectiveFov()`, `lensFade()`.
- `kart-model.ts` - `createKartVisual()`, `KART_LAYOUT`, LOD, all state-driven kart animation. `drivers.ts` - 8 species drivers,
  `DriverRig`. `kart-materials.ts` - paint shader patch, shared materials and textures, decal atlas, `RefCache`.
- `rigid-merge.ts` - `mergeRigidParts()`: parts sharing one material become one rigid-skinned draw, optional shadow proxy.
- `instance-culling.ts` - per-instance view and shadow culling of scattered static `InstancedMesh`es. `scene-optimize.ts` -
  `optimizeScene()`: five look-preserving cost rules (single-pass additive, shared depth material, white instance colours,
  400 m tiling of huge meshes, instancing material twins).
- `track-mesh.ts` - `buildTrackMesh()` (road, curbs, barriers, pits, ramps, boost pads, gantry, landmarks, banners).
  `terrain.ts` - height field, `fbm()`, deterministic `scatter()`. `sky.ts` - sky dome. `textures.ts` - seeded canvas textures.
  `theme-palette.ts` - `THEME_PALETTES` shared by track mesh and scenery.
- `item-models.ts` - pickups (4 draws), projectiles (up to 7 draws), held items. `particles.ts` - `createParticleSystem()`,
  17 kinds, `emitMoving()`. `showroom.ts` - menu scenes `'title' | 'garage' | 'podium'`.
- `themes/` - per-theme scenery builders (see `themes/CLAUDE.md`).

## Rules
- Quality tiers (shadows, bloom: shader programs) change only between races. While `setRaceActive(true)` the auto governor
  moves only the pixel ratio (`raceLockedPixelRatio()`); the deferred tier applies on `setRaceActive(false)`, which
  `game/index.ts` calls on pause, results, menus and the next race build. A user-chosen fixed tier applies at once.
- Governor: 11-rung ladder (`BASE_RUNGS`) clamped by device pixel ratio; 1 s windows; one rung down below 55 fps (two below
  38); one up after `upBackoff` (4 s, doubled up to 64 s when an up-step fails within 6 s) at 58.5 fps or more.
- `warmUp(scene, camera)` compiles the state that will be drawn: it binds the scene, compiles against a 1x1 `HalfFloatType`
  target when the tier has bloom, uses `compileAsync` when `KHR_parallel_shader_compile` exists, otherwise
  `renderer.compile()` plus a polled GPU fence (`waitFence`). It rejects without `compileAsync`; `game/index.ts` caps the wait
  at 8 s. Put variants (ghost kart) in their final material state before warm-up.
- The sky dome, `sun` and `hemi` live in one group named `ENV_GROUP_NAME` (`'pipeline-environment'`) that is re-parented into
  whichever scene renders, so there is one shadow map. `particles.ts` and the dev scenery pages look it up by name: do not
  rename it. `showroom.ts` has its own lights and does not call `applyEnvironment()`.
- Camera far plane is `max(2400, fog.far * 1.15)`; theme backdrops may sit beyond the fog.
- Split screen: when both views' shadow boxes fit one (`shadowBoxesFit`, keep 50 m, 4 m hysteresis) the sun is placed once and
  the second view skips its shadow pass. Divider: 3 px of `0x12101c`.
- Kart pose: `root.rotation.set(-k.pitch, pose.yaw + k.driftAngle, k.roll, 'YXZ')` (`kart-model.ts`), overridden while
  respawning (drone carry) and blended by the settle glide after it. Model space: +Z forward, +X is the kart's left; sim yaw 0
  faces +Z (`src/sim/types.ts`).
- Call `mergeRigidParts()` after the part hierarchy is assembled. Call `optimizeScene(scene)` once after the race scene is
  complete, then `attachInstanceCulling(scene)` (order used by `race-session.ts`).
- Instance culling takes only static meshes (`StaticDrawUsage`, `count >= 6`, bounding radius >= 60 m, no morphs or instanced
  attributes). Instances animated per frame must use `DynamicDrawUsage`. Animate a twinned material through the original.
- Changing a shader patch requires bumping its `customProgramCacheKey` (`tp-rm-v4`, `tp-nf-basic-v1`, `tp-psize-v2` in
  `kart-materials.ts`). Paint geometry needs the `rm` attribute (`rm.x < 0` = unlit); the near-fade discard compiles only after
  `setNearFadeEnabled` adds the `TP_NEAR_FADE` define.
- Ownership: every `textures.ts` generator returns a new texture the caller disposes. Kart geometry is ref-counted per
  `charId:lod`; always call `dispose()`. `pipeline.dispose()` calls `forceContextLoss()` (browsers cap live contexts).
- Kart springs integrate in sub-steps of `SPRING_H = 1/120` s; single steps diverged below about 12 fps.

## Testing
- `npx vitest run test/client/render-pipeline.test.ts test/client/render-perf.test.ts test/client/render-lens.test.ts test/client/kart-visual-stability.test.ts test/client/particles-moving-emitter.test.ts`
- `render-pipeline` (fake renderer via `vi.mock('three')`): race-locked ladder, governor with a race on screen, split-screen
  shadow passes, `warmUp()` (parallel-compile and fence paths, HDR target on high, rejection without `compileAsync`).
  `render-perf`: rigid-merge, instance-culling, scene-optimize. `render-lens`: lens fades. `kart-visual-stability`: springs at
  dt up to 0.1 s.
- Theme builders, `track-mesh.ts`, `showroom.ts` and `textures.ts` have no unit tests. Check them with `npm run dev` on
  `/dev/fx.html`, `/dev/karts.html`, `/dev/track.html`, `/dev/scenery-a.html`, `/dev/scenery-b.html`.
- `test/client/game-{session,view,verify,release}.test.ts` replace `kart-model`, `item-models`, `particles`, `themes/index` and
  `track-mesh` (all but `game-session` also `renderer` and `showroom`) with `vi.mock` factories built on the fakes in
  `test/client/game-harness.ts`. When `game/` starts using a new export or method of these modules, add it to every factory
  and fake.
- GPU cost: start `npx vite --config tools/vite-qa.config.mjs --port 8244 --strictPort` (the default `--url` of the perf
  tools), then `npx tsx tools/perf-views.ts` (calls/triangles at fixed views), `tools/perf-race.ts` (frame cost; `--governor 1`,
  `--shadow 1`, `--build 1`), `tools/perf-leaks.ts`, `tools/perf-shadow.ts`, `tools/perf-build.ts`.
