/**
 * Shared fakes for the game-integration tests (test/client/game-*.test.ts).
 *
 * The render modules that need WebGL / canvas textures are replaced by `vi.mock` factories in each
 * test file (they must be hoisted there); this module provides the fake objects those factories and
 * the tests use, plus fake pipeline / audio / input dependencies. The simulation is always the real
 * RaceWorld, so fixed-step, recording and ghost behaviour is exercised end to end.
 */
import * as THREE from 'three';
import { vi } from 'vitest';
import { computeAiInput, createAiState, type AiState } from '../../src/sim/ai.js';
import { NEUTRAL_INPUT } from '../../src/sim/input-log.js';
import type { RaceWorld } from '../../src/sim/race.js';
import { Rng } from '../../src/sim/rng.js';
import type { CharacterId, KartInput, KartState, RaceEvent } from '../../src/sim/types.js';
import type { AudioSystem, InputManager, Listener, Settings } from '../../src/client/contracts.js';
import { DEFAULT_SETTINGS } from '../../src/client/contracts.js';
import {
  QUALITY_PRESETS,
  type EnvironmentSettings, type KartPose, type KartVisual, type KartVisualOptions, type ParticleSystem,
  type PickupVisuals, type ProjectileVisuals, type RenderPipeline, type SceneryHandle, type TrackMeshHandle,
} from '../../src/client/render/contracts.js';

// ───────────────────────────── render fakes ─────────────────────────────

export interface FakeKartVisual extends KartVisual {
  poses: KartPose[];
  opts: KartVisualOptions[];
  disposed: number;
  nearFade: boolean;
  /** Every setLensFade() value (one per rendered view). */
  lens: number[];
  setNearFade(on: boolean): void;
  setLensFade(amount: number): void;
}

export const created = {
  karts: [] as FakeKartVisual[],
  pickups: [] as Array<PickupVisuals & { disposed: number }>,
  projectiles: [] as Array<ProjectileVisuals & { disposed: number; calls: Array<Array<{ id: number; x: number; y: number; z: number }>> }>,
  particles: [] as Array<ParticleSystem & { disposed: number; emitted: string[] }>,
  trackMeshes: [] as Array<TrackMeshHandle & { disposed: number; lights: Array<3 | 2 | 1 | 0 | null> }>,
  sceneries: [] as Array<SceneryHandle & { disposed: number; movers: THREE.Object3D[] }>,
};

export function resetCreated(): void {
  for (const k of Object.keys(created) as Array<keyof typeof created>) created[k].length = 0;
}

export function fakeKartVisual(charId: CharacterId): FakeKartVisual {
  const root = new THREE.Group();
  const v: FakeKartVisual = {
    root, charId, poses: [], opts: [], disposed: 0, nearFade: false, lens: [],
    setNearFade(on: boolean) { v.nearFade = on; },
    setLensFade(amount: number) { v.lens.push(amount); },
    update(_k: KartState, pose: KartPose, _dt: number, opts: KartVisualOptions) {
      v.poses.push({ ...pose });
      v.opts.push({ ...opts });
      root.position.set(pose.x, pose.y, pose.z);
      root.rotation.y = pose.yaw;
    },
    focus(out: THREE.Vector3) { return out.set(root.position.x, root.position.y + 1.1, root.position.z); },
    dispose() { v.disposed++; root.removeFromParent(); },
  };
  created.karts.push(v);
  return v;
}

export function fakePickups(): PickupVisuals {
  const p = { group: new THREE.Group(), disposed: 0, update() { /* static */ }, dispose() { p.disposed++; } };
  created.pickups.push(p);
  return p;
}

export function fakeProjectiles(): ProjectileVisuals {
  const p = {
    group: new THREE.Group(), disposed: 0, calls: [] as Array<Array<{ id: number; x: number; y: number; z: number }>>,
    update(list: ReadonlyArray<{ id: number; x: number; y: number; z: number }>) {
      p.calls.push(list.map(q => ({ id: q.id, x: q.x, y: q.y, z: q.z })));
    },
    dispose() { p.disposed++; },
  };
  created.projectiles.push(p);
  return p;
}

export function fakeParticles(): ParticleSystem {
  const p = {
    object: new THREE.Group(), disposed: 0, emitted: [] as string[],
    emit(kind: string) { p.emitted.push(kind); },
    update() { /* no-op */ }, clear() { /* no-op */ }, dispose() { p.disposed++; },
  };
  created.particles.push(p as ParticleSystem & { disposed: number; emitted: string[] });
  return p as ParticleSystem;
}

export function fakeTrackMesh(): TrackMeshHandle & { setStartLights(n: 3 | 2 | 1 | 0 | null): void } {
  const t = {
    group: new THREE.Group(), disposed: 0, lights: [] as Array<3 | 2 | 1 | 0 | null>,
    update() { /* no-op */ }, dispose() { t.disposed++; },
    setStartLights(n: 3 | 2 | 1 | 0 | null) { t.lights.push(n); },
  };
  created.trackMeshes.push(t);
  return t;
}

export const FAKE_ENV: EnvironmentSettings = {
  skyTop: '#3a8dff', skyHorizon: '#cfe8ff', skyBottom: '#ffffff', fogColor: '#cfe8ff', fogNear: 100, fogFar: 600,
  sunColor: '#ffffff', sunIntensity: 2, sunDir: [0.4, 0.8, 0.3], hemiSky: '#cfe8ff', hemiGround: '#5fbf4a',
  hemiIntensity: 1, exposure: 1, night: false, bloomStrength: 0.3,
};

export function fakeScenery(ctx: { scene: THREE.Scene }): SceneryHandle {
  const s = {
    environment: FAKE_ENV, disposed: 0, movers: [] as THREE.Object3D[],
    update() { /* no-op */ },
    createMover() {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      s.movers.push(m);
      return m;
    },
    dispose() { s.disposed++; },
  };
  const prop = new THREE.Group();
  prop.name = 'fake-scenery-prop';
  ctx.scene.add(prop);
  created.sceneries.push(s);
  return s;
}

// ───────────────────────────── dependency fakes ─────────────────────────────

export function fakePipeline(): RenderPipeline & { renders: number } {
  const p = {
    renderer: {} as THREE.WebGLRenderer,
    canvas: {} as HTMLCanvasElement,
    quality: QUALITY_PRESETS.low,
    fps: 60,
    renders: 0,
    setQuality: vi.fn(),
    applyEnvironment: vi.fn(),
    setShadowFocus: vi.fn(),
    resize: () => ({ width: 960, height: 540 }),
    render: vi.fn(() => { p.renders++; }),
    dispose: vi.fn(),
  };
  return p;
}

export interface FakeAudio extends AudioSystem {
  batches: RaceEvent[][];
  log: string[];
  finalLap: boolean;
}

export function fakeAudio(): FakeAudio {
  const a: FakeAudio = {
    batches: [], log: [], finalLap: false,
    unlocked: true,
    unlock: () => Promise.resolve(),
    setVolumes() { /* no-op */ },
    playMusic(cue: string) { a.log.push(`play:${cue}`); a.finalLap = false; },
    setFinalLap(on: boolean) { a.log.push(`finalLap:${on}`); a.finalLap = on; },
    stopMusic() { a.log.push('stopMusic'); },
    ui() { /* no-op */ },
    handleEvents(events: readonly RaceEvent[]) { a.batches.push([...events]); },
    update(_k: readonly KartState[], _l: readonly Listener[]) { /* no-op */ },
    suspend() { a.log.push('suspend'); },
    resume() { a.log.push('resume'); },
    stopRace() { a.log.push('stopRace'); },
  };
  return a;
}

export interface FakeInput extends InputManager {
  rumbles: Array<{ player: number; strength: number }>;
  polls: number[];
  modes: string[];
  next: (player: number) => KartInput;
}

export function fakeInput(next: (player: number) => KartInput = () => ({ throttle: true, brake: false, steer: 0, drift: false, item: false, back: false })): FakeInput {
  const i: FakeInput = {
    rumbles: [], polls: [], modes: [], next,
    poll(player: number) { i.polls.push(player); return i.next(player); },
    onMenu: () => () => undefined,
    setMode(m: 'single' | 'duo') { i.modes.push(m); },
    setTouchVisible() { /* no-op */ },
    touchDetected: false,
    rumble(player: number, strength: number) { i.rumbles.push({ player, strength }); },
    applySettings() { /* no-op */ },
    dispose() { /* no-op */ },
  };
  return i;
}

/**
 * Human input produced by the hard CPU logic — the same driver (seed 1234 + player) as the debug bots, but
 * arriving through InputManager.poll() like a player's pad, so the run is an unassisted, recordable one.
 * `race()` returns the running session (or null before it exists).
 */
export function aiHands(race: () => { world: RaceWorld; humanKarts: readonly number[] } | null): (player: number) => KartInput {
  const ais: AiState[] = [];
  let world: RaceWorld | null = null;
  return (player: number) => {
    const r = race();
    if (!r) return { ...NEUTRAL_INPUT };
    if (r.world !== world) { world = r.world; ais.length = 0; } // a restart starts a fresh driver
    const k = r.world.karts[r.humanKarts[player]!]!;
    const scale = k.speedScale;
    const inp = computeAiInput(r.world, k, ais[player] ??= createAiState(new Rng(1234 + player), 'hard'));
    k.speedScale = scale;
    return inp;
  };
}

export function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}
