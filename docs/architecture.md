# TURBO PALS GRAND PRIX — Architecture

Arcade 3D kart racer (Mario Kart–style gameplay, fully original characters, items, tracks, art
and music). Runs in the browser with three.js; served by a Fastify container on ECS Fargate
behind ALB + CloudFront.

## Module map (ownership)

| Path | Responsibility |
| --- | --- |
| `src/sim/` | Pure deterministic simulation shared by client and server (no DOM/three/Math.random/Date/Math.sin). |
| `src/sim/types.ts` | **Contract**: every shared data type (tracks, karts, items, events, race config/results). |
| `src/sim/dmath.ts` | Deterministic `dsin/dcos/datan2/dexp` (only IEEE-exact ops). Use these in sim code. |
| `src/sim/constants.ts` | Tick rate (60 Hz), physics tuning, speed classes, CPU levels, GP points. |
| `src/sim/characters.ts` | 8 original drivers (`CHARACTERS`, `getCharacter`). |
| `src/sim/item-defs.ts` | 14 items (`ITEMS`), position-weighted odds. |
| `src/sim/tracks/catalog.ts` | Track/cup metadata for menus (`TRACK_CATALOG`, `CUPS`). |
| `src/sim/tracks/*.ts` | Track geometry definitions (`TrackDef`). `tracks/index.ts` exports `getTrackDef(id)`, `TRACK_DEFS`. |
| `src/sim/track-builder.ts` | `buildTrack(def, { mirror }) → BuiltTrack` (spline → ~1 m samples, frames, features). |
| `src/sim/track-query.ts` | `projectToTrack`, `surfaceAt`, `pointAt` — fast local queries. |
| `src/sim/kart-physics.ts` | Arcade kart dynamics (drift/mini-turbo, hops, jumps, walls, surfaces). |
| `src/sim/items.ts` | Item roulette, usage, projectiles, hazards, hits. |
| `src/sim/ai.ts` | CPU drivers (racing line, drifting, item tactics, rubber-banding). |
| `src/sim/race.ts` | `RaceWorld` — owns karts/items/boxes/coins/movers, steps the race, emits `RaceEvent`s. |
| `src/sim/input-log.ts` | Input quantisation and run-length-encoded base64 logs. |
| `src/sim/replay.ts` | `verifyTimeTrial()` — server-side re-simulation; `createTimeTrialConfig()`. |
| `src/shared/api.ts` | HTTP API contract (leaderboard, submit, ghost). |
| `src/client/contracts.ts` | **Contract** for client subsystems: `AudioSystem`, `InputManager`, `GameView`, `HudSnapshot`, `Settings`. |
| `src/client/audio/` | Procedural WebAudio music + SFX + engines (`createAudioSystem()`). |
| `src/client/input/` | Keyboard / gamepad / touch → `KartInput`; menu navigation (`createInputManager()`). |
| `src/client/ui/` | App shell + flows (GP/VS/TT/Duo), menus, HUD, results, podium text, settings (`startApp()`). |
| `src/client/game/` | `createGameView()` — glue: RaceWorld stepping, interpolation, render, audio, HUD snapshots. |
| `src/client/render/` | three.js: renderer/quality, track meshes, themed scenery, kart models, entities, particles, cameras. |
| `src/server/` | Fastify: static files, `/healthz`, `/api/*`, replay verification, DynamoDB/memory repositories. |
| `infra/` | CDK: CloudFront → ALB (CloudFront prefix-list SG) → private ARM64 Fargate (existing VPC + NAT GW), DynamoDB. |

## Simulation API (implemented in `src/sim`)

```ts
// tracks/index.ts
export const TRACK_DEFS: readonly TrackDef[];
export function getTrackDef(id: string): TrackDef;

// track-builder.ts
export function buildTrack(def: TrackDef, opts?: { mirror?: boolean }): BuiltTrack;
export function getBuiltTrack(id: string, mirror?: boolean): BuiltTrack;   // cached

// track-query.ts
export function projectToTrack(t: BuiltTrack, x: number, z: number, hint: number, y?: number): TrackProjection;
export function surfaceAt(t: BuiltTrack, proj: TrackProjection): SurfaceInfo;
export function pointAt(t: BuiltTrack, s: number, d: number): { x: number; y: number; z: number; i: number; yaw: number };
export function sampleIndex(t: BuiltTrack, s: number): number;
export function wrapS(t: BuiltTrack, s: number): number;

// race.ts
export class RaceWorld {
  constructor(config: RaceConfig, track?: BuiltTrack);
  readonly config: RaceConfig; readonly track: BuiltTrack;
  tick: number;                 // ticks since countdown start
  phase: RacePhase;             // 'countdown' → 'racing' → 'done'
  readonly laps: number;
  karts: KartState[];
  projectiles: Projectile[];
  itemBoxes: Array<{ x: number; y: number; z: number; active: boolean; timer: number }>;
  coins: Array<{ x: number; y: number; z: number; active: boolean; timer: number }>;
  step(humanInputs: KartInput[]): void;      // one 60 Hz tick; index = human player index
  drainEvents(): RaceEvent[];
  moverPosition(index: number): { x: number; y: number; z: number; yaw: number };
  raceTicks(): number;                        // ticks since GO (0 during countdown)
  results(): RaceResult[];                    // valid once phase === 'done' (or for live standings)
}

// input-log.ts
export function quantizeInput(i: KartInput): KartInput;
export function encodeInputWord(i: KartInput): number;       // 16-bit
export function decodeInputWord(w: number): KartInput;
export class InputRecorder { push(i: KartInput): void; encode(): string; readonly length: number }
export function decodeLog(s: string): Uint16Array;           // one word per tick, throws on malformed input

// replay.ts
export function createTimeTrialConfig(trackId: string, cc: SpeedClass, charId: CharacterId): RaceConfig;
export function verifyTimeTrial(input: { trackId: string; cc: SpeedClass; charId: CharacterId; log: string }):
  { ok: true; ticks: number; lapTicks: number[] } | { ok: false; reason: string };
```

A time-trial run records one input word per tick **from tick 0 of the countdown** until the
tick the kart crosses the finish line of the final lap. Time trial: single kart, no item boxes,
no coins, the kart starts with `nitro3`. `ticks` = race ticks since GO (`raceTicks()` at finish).

## Game loop

`GameView` steps `RaceWorld` at a fixed 60 Hz with an accumulator (max 5 steps/frame), feeds
human `KartInput`s from `InputManager.poll()`, drains `RaceEvent`s once per frame to audio,
particles, camera shake and HUD toasts, and renders with interpolation between the previous and
current kart poses.

## Visual/audio identity

Bright, toy-like, saturated palette; chunky rounded shapes; soft shadows; strong silhouettes.
All assets are procedural (geometry, canvas textures, WebAudio synthesis) — no third-party
art, no Nintendo IP. UI copy is Korean first.

## Simulation versioning (operational rule)

The server accepts a time-trial only if re-simulating its input log reproduces the claimed
ticks exactly, and it also compares `SubmitRunRequest.version` with the semver core of its own
`APP_VERSION`. **Any change under `src/sim/` that can alter a trajectory (physics, track
geometry, AI is irrelevant for time trials but track defs are not) requires a `package.json`
version bump**, so stale clients get a clear `VERSION_MISMATCH` instead of `REPLAY_INVALID`.
Verification runs in a worker thread (`dist/server/verify-worker.js`) with an 8 s CPU budget.
