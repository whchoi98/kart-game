# Game Module

## Role
Glue between the deterministic sim (`src/sim/`), the three.js renderer (`src/client/render/`) and audio. Implements the
`GameView` contract (`src/client/contracts.ts`) that the UI drives: menu showroom, race lifecycle, HUD data.

## Key Files
- `index.ts`: `createGameView(deps)` returns `GameViewImpl` typed as `DebugGameView` (adds `debugSetBots`, `debugState`).
  Owns the canvas, the rAF loop, the showroom, `startRace`/`restartRace`/`endRace`, shader warm-up, `pipeline.setRaceActive`.
- `race-session.ts`: `RaceSession`, one race. Builds the scene (scenery, track mesh, karts, pickups, projectiles, particles,
  movers, one `CameraRig` per human), steps `RaceWorld` at a fixed 60 Hz, interpolates, records TT input, runs the ghost.
- `hud-model.ts`: `HudModel`, pure (no three/DOM) mapping of `RaceEvent`s + world state to `HudSnapshot`, incl. ghost splits.

## Rules
- **Loop and time steps.** `GameViewImpl` clamps each rAF `dt` to [0, 0.1] s and resets its clock on `visibilitychange`
  and `resume()`. `RaceSession.frame` maps NaN or negative `dt` to 0 and caps it at 0.25 s. `stepSimulation` adds `dt` to an
  accumulator and runs at most 5 fixed-`DT` ticks (`world.step(inputs)`) per frame; if a backlog remains after 5 steps it is dropped (`acc = 0`), so a
  slow device runs the race slower instead of spiralling. Render alpha is `acc / DT` (1 during the intro).
- **Frame order** (`frame`): intro advance or `stepSimulation`, then `hud.onEvents(events, ghostLaps)`, `hud.advance`,
  `handleEvents`, `updateVisuals`, `updateCameras`, `render`, `checkFinish`. While paused nothing steps and visuals get `dt = 0`.
- **Event flow.** Events are drained from `world.drainEvents()` after every tick and collected per frame. `handleEvents` passes
  the whole batch to `audio.handleEvents` exactly once, then maps events to particles, camera shake (only if `settings.shake`)
  and rumble. `HudModel` receives the same batch. Never forward events to audio per tick or twice.
- **Rumble** goes through `RaceSession.rumble`, which checks `settings.rumble === false`; `main.ts` wraps `input.rumble` with the
  same check. Strengths/durations: wall `min(1, impact/14)` 120 ms, kartBump 0.35 90 ms, hit 0.6 (tumble 1) 300 ms,
  boost 0.35 (mini3/start 0.7) 140 ms.
- **Settings are shared by reference.** `GameView.applySettings` mutates its object with `Object.assign`; the running session holds
  the same object (`deps.settings`), so pause-menu changes apply live. Do not replace that object.
- **Ghost lockstep.** `GhostPlayer` steps exactly once per world tick (inside the step loop, so never while paused).
  `precomputeGhostLaps` replays it to the finish up front (guard 60*60*15 steps) so splits show when the player crosses.
  The ghost visual is switched to its translucent look in the constructor so warm-up compiles those shaders.
- **TT recording.** In `tt` mode an `InputRecorder` stores one input word per tick for P1 until P1 finishes.
  `summary().timeTrial` is non-null only for an unassisted finished run; debug bots driving a racing human kart set `assisted`.
  `KartInput` fields map onto the sim input-log bits (`src/sim/input-log.ts`): adding one changes the server verification protocol.
- **Start sequencing.** `startRace` bumps `startSeq`, yields one rAF, builds the session as `pending`, awaits `warmUp`
  (capped at `WARMUP_CAP_MS = 8000`, never rejects), and only then promotes it. A newer `startRace` or `endRace` wins; dispose
  is idempotent. `restartRace` keeps the seed for `tt` (verifiable) and draws a new one otherwise.
- **Quality governor flag.** `setRaceActive(!isPaused && !session.raceOver)` every frame; it goes false on pause, results,
  `endRace` and before the next build, which is when deferred quality-tier changes may apply (see `src/client/render/CLAUDE.md`).
- **Finish.** After `world.phase === 'done'`, `onFinish(summary())` fires once after `CELEBRATION_SECONDS = 3.2`; then
  `raceOver` is true while the scene stays up as the results backdrop.
- Interpolation: a kart or projectile that moved more than `TELEPORT_DIST = 12` m in one tick is not lerped, and a `respawn`
  event resets its previous pose. Movers are drawn at `tick - 2 + alpha` to line up with kart render time.
- HUD toast strings in `hud-model.ts` are player-visible: write them in Korean.

## Testing
- `npx vitest run test/client/game- test/client/hud-model` (`game-view`, `game-session`, `game-verify`, `game-release`).
- `test/client/game-harness.ts` holds the fakes (pipeline, audio, input, scenery, track mesh); render modules are `vi.mock`ed
  and the sim is the real `RaceWorld`. Adding a dependency call on the pipeline, audio or input means extending these fakes.
- Real GPU output is not unit tested; use `npm run qa:screens` or the `?debug` hook (`window.__turbo.startRace`).

## How to extend
- New sim event with a visual/haptic reaction: add a `case` in `RaceSession.handleEvents`; add a toast in `HudModel.onEvents`
  if the player should read it; audio mapping lives in `src/client/audio/event-map.ts`.
- New per-frame visual: update it in `updateVisuals` with the interpolated pose and dispose it in `RaceSession.dispose`.
