# Simulation Module

## Role
- Deterministic race simulation on a fixed 60 Hz tick, shared verbatim by the browser (`src/client/game/race-session.ts`) and the server verifier worker (`src/server/verify-worker.ts`, bundled to `dist/server/verify-worker.js`). The server re-simulates every submitted time-trial input log and accepts only an exact `ticks`/`lapTicks` match, so any engine-dependent result becomes a rejected run.
- Self-contained: files here import only from `src/sim/`. Client, server and tools read `KartState`, `BuiltTrack` and drained `RaceEvent`s. The only production write into a live `RaceWorld` is restoring `speedScale` on AI-driven human karts (see below); the dev-only QA scene `src/client/dev/karts-race.ts` also hands out items in chaos mode.

## Key Files
- `types.ts` - every shared contract (`TrackDef`, `BuiltTrack`, `KartState`, `KartInput`, `RaceConfig`, `RaceEvent`, `ItemId`, `Projectile`); the header comment defines the coordinate system.
- `constants.ts` - `TICK_HZ`/`DT`, `COUNTDOWN_TICKS` (180), rocket-start windows, `SPEED_CLASSES`, `PHYS` tuning, `CPU_LEVELS`, `GP_POINTS`.
- `dmath.ts` - `dsin`/`dcos`/`datan`/`datan2`/`dexp`, `wrapAngle`, `damp`, `clamp`/`lerp`/`hypot2`/`smoothstep`, built from exactly rounded operations only.
- `rng.ts` - `Rng` (mulberry32, integer ops, `getState`/`setState`); `hashString` (FNV-1a) is used by the client only.
- `input-log.ts` - 16-bit input word (bits 0-6 steer+63, 7 throttle, 8 brake, 9 drift, 10 item, 11 back), `quantizeInput`, `NEUTRAL_INPUT`, `InputRecorder` (header `[1, 0]`, then `(word, count)` u16 LE pairs, base64), `decodeLog`.
- `race.ts` - `RaceWorld`: countdown, input routing, items, physics, kart collisions, pickups, movers, laps, finish, `results()`.
- `kart-physics.ts` - `createKart`, `stepKart` (steering, drift, hop, tricks, walls, falls, respawn), `applyBoost`, `hitKart`, `addCoins`.
- `items.ts`, `item-defs.ts` - roulette, item use, shields, projectiles; `ITEMS`, `ITEM_WEIGHTS`, `rankBucket`.
- `ai.ts` - racing line (WeakMap cache per `BuiltTrack`), `createAiState`, `computeAiInput`, item tactics, rubber-banding.
- `characters.ts` - the 8 `CHARACTERS`, `CHARACTER_IDS`, `isCharacterId`; stats feed the physics.
- `track-builder.ts`, `track-query.ts` - `buildTrack`, `mirrorDef`, `getBuiltTrack` (cache key `id|mirror`); `projectToTrack`, `surfaceAt`, `pointAt`, `deltaS`, `trackYaw`.
- `replay.ts` - `TIME_TRIAL_SEED`, `MAX_TT_TICKS` (43380), `createTimeTrialConfig`, `verifyTimeTrial`, `GhostPlayer`.
- `tracks/` - track definitions and the menu catalog (`tracks/CLAUDE.md`).

## Rules
### Determinism (no lint or test enforces these bans; `test/sim` only checks dmath accuracy and same-seed repeatability on one engine)
- Never use `Math.random`, `Date`, `performance`, timers, DOM or three.js, and never the implementation-approximated `Math.sin/cos/tan/atan/atan2/exp/pow/log/hypot` or `**`; use `dmath.ts`. Safe: `+ - * /`, `Math.sqrt/floor/ceil/round/abs/min/max/imul`, `Math.PI`.
- Before finishing, `grep -rnE --include='*.ts' "Math\.(random|sin|cos|tan|atan|exp|pow|log|hypot)|Date\b|performance" src/sim` must print only the two comment lines in `dmath.ts` and `types.ts` (without `--include` it also matches this file).
- Randomness comes only from `world.rng` (mulberry32 seeded by `RaceConfig.seed`) or a private `Rng`. Today's `world.rng` consumers: `createAiState` per CPU kart in kart-index order (constructor), the AI trick chance and item delay (`ai.ts`), `rollItem` (`items.ts`). A new consumer or a reorder changes every seeded race.
- Time trials must not read `world.rng`: the bot recorder in `tools/sim-report.ts` consumes it through `computeAiInput` while the replay does not, so the sim test's bot verification would fail.
- Iteration order is part of the result: `Object.keys(ITEM_WEIGHTS)` is the roulette order, and sort comparators tie-break on kart index (`updatePositions`).
- One `step()` advances exactly `DT = 1/60` s and every timer counts down in `DT`. Frame pacing (accumulator, at most 5 steps per frame) belongs to `race-session.ts`, never here.
- Human input enters only through `step(humanInputs)`, which applies `quantizeInput` (steer rounded to 1/63, NaN to 0); `InputRecorder.push` uses the same encoding. `humanInputs` is indexed by human player number, not kart index.
- `RaceWorld.step()` order is fixed: countdown events and `resolveStarts()` at tick 180 -> `humanLeadProgress` -> inputs (quantized humans; `computeAiInput` for CPUs and finished humans) -> `updateKartItem` for all karts -> `stepKart` for all karts -> while racing `collideKarts`, `updateProjectiles`, `pickups`, `moverCollisions`, `progressAndLaps` -> store `prevDrift`/`prevItem`, `updatePositions`, `checkDone`, `tick++`.
- Movers are pure functions of the tick (`moverPositionAt`); the AI samples future ticks and the renderer fractional past ones, so never give a mover state.
- `computeAiInput` overwrites `k.speedScale` (rubber-banding): save and restore it when the AI drives a human kart, as `tools/sim-report.ts` and `race-session.ts` do.
- `RaceWorld` input buffers and the `out` argument of `computeAiInput` are reused every tick, and `BuiltTrack` objects are shared through caches: never keep references across ticks or mutate a built track.
- Keep `step()` cheap: the server replays up to `MAX_TT_TICKS` per run in a worker with an 8 s timeout (`src/server/verifier.ts`).

### Conventions
- Coordinates: right-handed, +Y up, track on XZ; yaw 0 faces +Z, forward = (sin yaw, 0, cos yaw), right = (-cos yaw, 0, sin yaw); steer +1 turns right (yaw decreases); three.js `rotation.y = yaw`. Units m, s, rad.
- Track frame: `s` is arc length in [0, length), `d` the lateral offset (> 0 is right of travel), `curvature` > 0 turns right. `rampH` is not part of `py`; `surfaceAt` and `pointAt` add it. Authored positions use `u` (`tracks/CLAUDE.md`).
- Time: tick 0 starts the countdown, GO is tick 180. `raceTicks()`, `finishTick` and `lapTicks` count from GO and lap 1 includes the run from the grid, so `sum(lapTicks) == finishTick`. `progress` is signed, so laps only count forward.

### Time-trial verification path
- `createTimeTrialConfig(trackId, cc, charId)`: mode `tt`, one human kart, `items: false`, `mirror: false`, `seed: TIME_TRIAL_SEED`. `RaceWorld` then spawns no item boxes or coins and starts the kart with `nitro3` (3 uses). There is no mirror time trial.
- The log holds one word per tick from tick 0 through the finish tick: `race-session.ts` pushes player 0's input before each `world.step` while the kart has not finished.
- `verifyTimeTrial` returns `{ ok: true, ticks: finishTick, lapTicks }` or a reason: `unknown track`, `unknown character`, `bad speed class`, `malformed log: ...`, `log continues after the finish`, `run did not finish`. `compareResult` in `src/server/app.ts` turns a failure into `VERSION_MISMATCH`/`REPLAY_INVALID` and a mismatch into `TIME_MISMATCH`/`LAP_MISMATCH`.
- `GhostPlayer` replays a stored log in its own world and feeds `NEUTRAL_INPUT` after the log ends (the AI then cruises the finished kart).
- The log encoding is also hashed for duplicate detection (`logDigest` in `src/server/validation.ts`) and bounded by `API_LIMITS.logMax` (`src/shared/api.ts`): change them together.

### Version bump for trajectory-changing edits
- A change that can alter a time-trial trajectory needs a `package.json` `version` bump and a `CHANGELOG.md` entry (rule in `docs/architecture.md`; `.claude/hooks/check-doc-sync.sh` reminds you on every non-Markdown `src/sim` edit). In scope: `kart-physics.ts`, `PHYS`/`SPEED_CLASSES`/countdown constants, character stats, `dmath.ts`, input quantization or log format, the `race.ts` step order, lap/finish rules and mover/boost-pad handling, the geometry of existing tracks (their `tracks/` files, `track-builder.ts`, `track-query.ts`) and the `nitro3` path in `items.ts`.
- A brand-new track alters no existing replay, so the rule does not force a bump for it (`tracks/CLAUDE.md`). Any bump has a cost: at boot clients discard queued offline runs recorded under the old semver core (`dropStalePendingRuns` in `src/client/storage.ts`).
- Out of scope (a time trial has no CPUs, item boxes, coins or mirror): AI, roulette weights, other items, coins, mirror-only logic. They still change seeded CPU races, which nothing verifies.
- What is compared: the client sends `version` = the `package.json` version baked in by Vite (`__APP_VERSION__`); in ECS the server's `APP_VERSION` is `<package.json version>+<image hash>`. Only the semver core (before `+`) is compared, and only after a replay fails: the stale client then gets `VERSION_MISMATCH` (reload hint) instead of `REPLAY_INVALID`. A stale log that still finishes with other times gets `TIME_MISMATCH`/`LAP_MISMATCH` whatever its version.
- No test notices a changed trajectory, and stored leaderboard runs are never re-verified: their ghosts replay through the new sim as they are.

## How to extend
- New item: (1) `ItemId` in `types.ts`, plus `ProjectileKind` and `HeldItem.kind` if it flies or is held; (2) `ITEMS` and `ITEM_WEIGHTS` in `item-defs.ts` (both `Record<ItemId, ...>`; append the weights entry because key order is roulette order); (3) the effect in the `useItem` switch and any flight/collision in `updateProjectiles` (`items.ts`); (4) AI timing in `decideItem` (`ai.ts`, the default case fires when ready) and any `rollItem` exclusion; (5) client: `npm run typecheck` flags `ITEM_USE_SOUND` (`src/client/audio/event-map.ts`) and `DRAW` (`src/client/ui/art/item-icons.ts`), while `src/client/render/item-models.ts` types only `CAP` (`Record<ProjectileKind, number>`) and its model branches are `if`/`else` chains to add by hand.
- New `RaceEvent` variant: `EVENT_TYPES` in `src/client/audio/event-map.ts` fails the type check until it is listed.
- New track or cup: follow `tracks/CLAUDE.md`.

## Testing
- `npx vitest run test/sim` runs `test/sim/sim.test.ts`: dmath within 1e-10 of `Math`, input-word and RLE round trips, malformed logs, every track (normal and mirror) passes `analyzeTrack` with 8 grid slots, projection round trip, 8 hard CPUs finish every track (16 `lap` and 8 `finish` events, i.e. 3 laps), same-seed determinism, forward-only laps and wrong-way, and a bot time trial that verifies while another character, a truncated log and 30 extra ticks are rejected.
- That test imports `runCpuRace`/`runBotTimeTrial` from `tools/sim-report.ts` and `analyzeTrack` from `tools/track-report.ts`: those exports are test surface, keep their signatures.
- `npx tsx tools/sim-report.ts [trackId ...] [--cc 150] [--level hard]`: CPU race (seed 12345), bot time trial and verification per track. `npx tsx tools/track-report.ts [trackId ...] [--png] [--out dir]`: geometry validation, exit code 1 on a problem.
- Other suites on the sim: `test/server/replay.integration.test.ts` (real worker replay; its AI uses a private `Rng(0x5eed)` view), `test/client/game-verify.test.ts`, `test/client/game-session.test.ts`. Finish with `npm test` and `npm run typecheck`.
