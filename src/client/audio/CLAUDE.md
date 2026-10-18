# Audio Module

## Role
- All game sound, synthesized live with WebAudio (no audio asset files): music sequencer with one original song per track and
  menu cue, spatialized SFX for every sim `RaceEvent`, UI sounds, and continuous engine/drift/boost loops.
- Implements `AudioSystem` from `src/client/contracts.ts`. `createAudioSystem()` (`index.ts`, called from `src/client/main.ts`)
  returns `WebAudioSystem`, or `SilentAudioSystem` when WebAudio is missing or construction throws, so callers never guard.
- Imports nothing from three.js, `render/`, `game/` or `ui/`; reads `src/sim` types, `characters` and `constants` only.

## Key Files
- `system.ts` - `WebAudioSystem`: lazy `AudioContext` built in `unlock()`, event dispatch, spatialization, rate limits, voice
  pools (`EVENT_VOICES` 28, `UI_VOICES` 6), nested suspend/resume, `diagnostics()` for tests.
- `noop.ts` - `SilentAudioSystem` (every method a safe no-op).
- `context.ts` - `getAudioContextCtor()`, param helpers (`glideParam`, `trackParam`, `fin`), `AudioResources` (noise buffers,
  periodic waves, drive curves, impulse response).
- `buses.ts` - `Mixer`: songGate -> musicDuck -> music -> musicHold -> master; star and sting buses feed music; echo/reverb
  returns feed musicDuck; ui/events/loops -> sfx -> master -> compressor -> limiter -> out. `volumeToGain()` is `x^1.6`.
- `synth.ts` - `Voice` (short-lived node group that disconnects itself) and envelopes. `instruments.ts` - lead/bass/pad/arp
  presets, `playNote()`. `drums.ts` - 6 kits, `playDrum()`. `theory.ts` - pure pitch/chord/scale parsing, voice leading.
- `pattern.ts` - song DSL types (`SongDef`, `SectionDef`), `compileSong()` with validation, final-lap intensity layer.
- `sequencer.ts` - `Sequencer`/`SongPlayer`: 25 ms timer, 0.12 s lookahead, 0.6 s crossfades, final-lap sting and tempo x1.12,
  Super Star layer, ducking.
- `event-map.ts` - pure: `SFX_IDS` (63), `EVENT_TYPES` (32 `RaceEvent` kinds), `planEvent()` -> `SoundCall[]`, `RATE_LIMIT`.
- `sounds.ts` - `SOUNDS: Record<SfxId, SoundFn>`: 38 from `sfx-race.ts`, 21 from `sfx-misc.ts`, 4 voice chirps from
  `voices.ts`; re-exports `UI_SOUNDS` (7, defined in `sfx-misc.ts`).
- `sfx-lib.ts` - `Strip`, `VoicePool` (priority-based voice stealing), primitives `tone`/`noise`/`fmHit`/`bell`/`hz`.
- `engine-model.ts` - pure engine tone and loop targets. `engine.ts` - `ContinuousAudio`: engines for every human kart plus the
  3 nearest CPU karts, drift, boost, jet, off-road, ice, propeller, roulette ticks.
- `spatial.ts` - pure 2D spatialization against the nearest listener (full volume within 8 m, silent at 110 m, sounds below
  gain 0.025 are skipped).
- `songs/` - song data and the cue registry (see `songs/CLAUDE.md`).

## Rules
- Only `unlock()` creates the `AudioContext`, and it must run inside a user gesture. Without user activation yet
  (`navigator.userActivation`) it returns without building anything. `playMusic()`/`setFinalLap()` before unlock are kept as
  pending state and applied once the context runs. When the context stops running outside a `suspend()` (OS interruption) or
  `resume()` cannot restart it without a gesture, the system drops back to locked so the next gesture's `unlock()` retries.
- Keep `event-map.ts`, `engine-model.ts`, `spatial.ts`, `theory.ts` and `pattern.ts` free of WebAudio objects: they are
  unit-tested directly.
- Completeness is compiler-enforced: `EVENT_TYPES ... satisfies Record<RaceEvent['t'], true>`, `planEvent()` ends in a `never`
  default, `SOUNDS` and `UI_SOUNDS` are full `Record`s. A new sim event fails `npm run typecheck` until it is mapped here.
- Human-only feedback (lap chime, final lap, item get, wrong way, position change, start boost) never plays for CPU karts, and
  human sounds get higher priority than the same CPU sound.
- A `SoundFn` is `(kit, out, t, param) => endTime`: render into the given `Out` starting at `t` and return when it is silent,
  so the pool can recycle the strip.
- `play()` rate-limits per sound and kart (`RATE_LIMIT`, seconds) and lowers priority by 1 for quiet (gain < 0.35)
  spatialized sounds.
- Spatial convention matches the sim: yaw 0 faces +Z, right = (-cos yaw, 0, sin yaw).
- Final lap is idempotent: `race-session.ts` calls `setFinalLap(true)` on the human's `finalLap` event and the `finalLap` SFX
  dispatch calls `seq.setFinalLap(true)` again; a repeated value is ignored.
- `finishFanfare` ducks music to 0.3 and restores 0.7 after 2.6 s. `stopRace()` stops loops and one-shots and makes the next
  `playMusic()` restart its cue from the intro.

## How to extend (new SFX)
1. Add the id to `SFX_IDS` in `event-map.ts`.
2. Write the `SoundFn` in `sfx-race.ts` (items, hits, boosts, kart physics) or `sfx-misc.ts` (race flow, misc), built from the
   `sfx-lib.ts` primitives and returning the end time.
3. Register it in `SOUNDS` (`sounds.ts`); the compiler flags a missing entry.
4. Map it in `planEvent()`: `where` (`'kart' | 'point' | 'global'`), priority 0..10, param, delay. Add a `RATE_LIMIT` entry if
   it can fire in bursts.
5. UI sound instead: extend `UiSound` in `src/client/contracts.ts` and `UI_SOUNDS` in `sfx-misc.ts`.

## Testing
- `npx vitest run test/client/audio-events.test.ts test/client/audio-songs.test.ts test/client/audio-system.test.ts`
- `audio-events`: every `RaceEvent` maps to a sound, `SOUNDS`/`UI_SOUNDS` complete, human/CPU rules, priorities,
  spatialization, engine model. `audio-system`: silent fallback and a strict WebAudio mock (unlock and autoplay retry,
  crossfades, final lap, voice budget, suspend/resume, engines for humans plus 3 CPUs). `audio-songs`: see `songs/CLAUDE.md`.
- Node has no WebAudio, so other tests get `SilentAudioSystem` or a mock. Judge how anything sounds in the browser
  (`npm run dev`).
