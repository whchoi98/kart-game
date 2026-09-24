/**
 * One running race: owns the RaceWorld, its three.js scene and every visual,
 * steps the simulation at a fixed 60 Hz and renders with interpolation.
 */
import * as THREE from 'three';
import { COUNTDOWN_TICKS, DT } from '../../sim/constants.js';
import { InputRecorder, NEUTRAL_INPUT } from '../../sim/input-log.js';
import { RaceWorld } from '../../sim/race.js';
import { GhostPlayer } from '../../sim/replay.js';
import { computeAiInput, createAiState, type AiState } from '../../sim/ai.js';
import { Rng } from '../../sim/rng.js';
import type { BoostKind, BuiltTrack, KartInput, KartState, Projectile, RaceEvent } from '../../sim/types.js';
import type { AudioSystem, GhostData, HudSnapshot, InputManager, RaceStartOptions, RaceSummary, Settings } from '../contracts.js';
import type {
  CameraRig, KartPose, KartVisual, KartVisualOptions, ParticleSystem, PickupVisuals, ProjectileVisuals, RenderPipeline,
  SceneryHandle, TrackMeshHandle, Viewport,
} from '../render/contracts.js';
import { createCameraRig, lensFade } from '../render/camera.js';
import { createKartVisual, type KartVisualExtras } from '../render/kart-model.js';
import { setKartEnvIntensity } from '../render/kart-materials.js';
import { createPickupVisuals, createProjectileVisuals, type PickupCulling } from '../render/item-models.js';
import { createParticleSystem, type ParticleSystemExt } from '../render/particles.js';
import { getSceneryBuilder } from '../render/themes/index.js';
import { buildTrackMesh } from '../render/track-mesh.js';
import { THEME_PALETTES } from '../render/theme-palette.js';
import { optimizeScene, type SceneOptimization } from '../render/scene-optimize.js';
import { attachInstanceCulling, type InstanceCulling } from '../render/instance-culling.js';
import { HudModel } from './hud-model.js';

const INTRO_SECONDS = 4.6;
/** Another kart this close to a view's camera (m, hull centre) is dissolved for that view: fully gone at
 *  KART_LENS_GONE, untouched beyond KART_LENS_START (a kart hanging mid-view ~3 m out, between the lens and
 *  the player, filled a third of the screen). A player's own kart is ≥ 5.2 m from its own chase camera. */
export const KART_LENS_GONE = 1.9;
export const KART_LENS_START = 4.0;
const CELEBRATION_SECONDS = 3.2;
const HARD_LOOKS = new Set(['boulder', 'snowball', 'log', 'meteor', 'rock', 'lava']);

/** A kart / projectile that moved further than this in one tick teleported (respawn): don't interpolate. */
const TELEPORT_DIST = 12;
/** Continuous wheel dust / drift sparks / star trail emission period (s). */
const EMIT_INTERVAL = 1 / 30;
/** Exhaust-lick tint per boost kind (matches the kart model's flame colours: mini-turbo blue/orange/purple). */
const BOOST_TINT: Partial<Record<BoostKind, string>> = {
  mini1: '#7cc8ff', mini2: '#ffb050', mini3: '#dc8cff', nitro: '#ffc060', pad: '#ffc060', start: '#ffc060',
  trick: '#ffc868', ramp: '#ffc868', coin: '#ffd060',
};

interface MoverVisual { outer: THREE.Object3D; inner: THREE.Object3D; rolls: boolean; radius: number; lastX: number; lastZ: number }
type ProjectileDraw = { id: number; kind: Projectile['kind']; x: number; y: number; z: number; vx: number; vz: number; state: string };

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2); // O(1) for any yaw magnitude (a while-loop wrap can spin for ages)
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Interpolate prev → cur into out; keeps out unchanged if the result is not finite (sim NaN guard). */
function lerpPose(p: KartPose, k: KartPose, alpha: number, out: KartPose): KartPose {
  const t = Math.abs(k.x - p.x) + Math.abs(k.z - p.z) > TELEPORT_DIST ? 1 : alpha;
  const x = p.x + (k.x - p.x) * t, y = p.y + (k.y - p.y) * t, z = p.z + (k.z - p.z) * t;
  const yaw = lerpAngle(p.yaw, k.yaw, t);
  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(yaw)) {
    out.x = x; out.y = y; out.z = z; out.yaw = yaw;
  }
  return out;
}

export interface SessionDeps {
  pipeline: RenderPipeline;
  audio: AudioSystem;
  input: InputManager;
  settings: Settings;
}

export class RaceSession {
  readonly world: RaceWorld;
  readonly track: BuiltTrack;
  readonly scene = new THREE.Scene();
  readonly humanKarts: number[];
  private readonly deps: SessionDeps;
  private readonly opts: RaceStartOptions;
  private readonly trackMesh: TrackMeshHandle & { setStartLights?: (n: 3 | 2 | 1 | 0 | null) => void };
  private readonly scenery: SceneryHandle;
  private readonly kartVisuals: KartVisual[];
  private readonly pickups: PickupVisuals & Partial<PickupCulling>;
  private readonly projectiles: ProjectileVisuals;
  private readonly particles: ParticleSystem & Partial<ParticleSystemExt>;
  private readonly cameras: CameraRig[];
  private readonly movers: MoverVisual[] = [];
  private readonly hud: HudModel;
  private readonly recorder: InputRecorder | null;
  private readonly ghost: GhostPlayer | null;
  private readonly ghostLaps: number[] | null;
  private readonly ghostVisual: KartVisual | null;
  private prev: KartPose[];
  private ghostPrev: KartPose | null = null;
  private acc = 0;
  private time = 0;
  private introT = 0;
  private introActive = true;
  private doneTimer = -1;
  private finishedNotified = false;
  private lastInputs: KartInput[];
  private finalLapMusic = false;
  private startLightsOffAt = -1;
  private readonly focusTmp = new THREE.Vector3();
  private readonly tmpV = new THREE.Vector3();
  private finishTime: number[];
  private disposed = false;
  private readonly instanceCulling: InstanceCulling;
  private readonly sceneOpt: SceneOptimization;
  /** Debug/QA: CPU logic drives the human karts. */
  private debugBots: AiState[] | null = null;
  /** The debug bots drove a human kart that was still racing: a time trial is then no record. */
  private assisted = false;

  constructor(opts: RaceStartOptions, deps: SessionDeps) {
    this.opts = opts;
    this.deps = deps;
    this.world = new RaceWorld(opts.config);
    this.track = this.world.track;
    const q = deps.pipeline.quality;
    const theme = this.track.def.theme;
    this.humanKarts = this.world.karts.filter(k => k.human >= 0).sort((a, b) => a.human - b.human).map(k => k.index);
    this.lastInputs = this.humanKarts.map(() => ({ ...NEUTRAL_INPUT }));
    this.finishTime = this.humanKarts.map(() => -1);

    // world
    this.scenery = getSceneryBuilder(theme)({ scene: this.scene, track: this.track, quality: q, renderer: deps.pipeline.renderer });
    deps.pipeline.applyEnvironment(this.scene, this.scenery.environment);
    // karts carry a daylight studio env map; tone it down under night skies
    setKartEnvIntensity(this.scenery.environment.night ? 0.45 : 1);
    this.trackMesh = buildTrackMesh(this.track, theme, q);
    this.scene.add(this.trackMesh.group);

    // karts
    this.kartVisuals = this.world.karts.map(k => {
      const v = createKartVisual(k.charId, q);
      // dither karts out right at the lens (a CPU kart cutting past the chase camera filled the screen)
      (v as KartVisual & Partial<KartVisualExtras>).setNearFade?.(true);
      this.scene.add(v.root);
      return v;
    });
    this.prev = this.world.karts.map(k => ({ x: k.x, y: k.y, z: k.z, yaw: k.yaw }));

    // pickups, projectiles, particles
    this.pickups = createPickupVisuals(this.world.itemBoxes.length, this.world.coins.length, q);
    this.scene.add(this.pickups.group);
    this.projectiles = createProjectileVisuals(q);
    this.scene.add(this.projectiles.group);
    this.particles = createParticleSystem(q);
    this.scene.add(this.particles.object);

    // movers
    this.track.movers.forEach((m, i) => {
      const inner = this.scenery.createMover(m.look);
      const outer = new THREE.Group();
      outer.add(inner);
      this.scene.add(outer);
      const p = this.world.moverPosition(i);
      outer.position.set(p.x, p.y, p.z);
      this.movers.push({ outer, inner, rolls: HARD_LOOKS.has(m.look), radius: m.radius, lastX: p.x, lastZ: p.z });
    });

    // cameras (one per human; an all-CPU config (debug/QA only) spectates the leader with one camera)
    this.cameras = (this.humanKarts.length ? this.humanKarts : [0]).map(() => createCameraRig());

    // time trial recording & ghost
    this.recorder = opts.config.mode === 'tt' ? new InputRecorder() : null;
    const g = opts.ghost;
    this.ghost = g ? this.makeGhost(g) : null;
    // simulate the ghost once to the finish so every lap split can be shown the moment the player crosses
    this.ghostLaps = this.ghost && g ? this.precomputeGhostLaps(g) : null;
    this.ghostVisual = this.ghost ? createKartVisual(this.ghost.kart.charId, q) : null;
    if (this.ghostVisual) {
      // the ghost dissolves at the lens too (racing right behind it puts the chase camera inside it)
      (this.ghostVisual as KartVisual & Partial<KartVisualExtras>).setNearFade?.(true);
      this.scene.add(this.ghostVisual.root);
      const gk = this.ghost!.kart;
      this.ghostPrev = { x: gk.x, y: gk.y, z: gk.z, yaw: gk.yaw };
      Object.assign(this.ghostPose, this.ghostPrev);
      // switch it to its translucent look now, so the shader warm-up compiles the programs it will draw with
      this.ghostVisual.update(gk, this.ghostPose, 0, { lookBack: false, throttle: false, time: 0, ghost: true });
    }

    this.hud = new HudModel(this.world, this.humanKarts, this.ghost && g ? g.ticks : null, this.ghost ? this.ghost.kart : null);
    this.deps.input.setMode(this.humanKarts.length > 1 ? 'duo' : 'single');
    this.deps.audio.playMusic(this.track.def.id);
    this.trackMesh.setStartLights?.(null);
    // look-preserving: drop per-frame program re-resolution (double-sided additive passes, depth-material churn)
    this.sceneOpt = optimizeScene(this.scene);
    // scattered static instanced props: per-instance culling against the view and the sun's shadow box
    this.instanceCulling = attachInstanceCulling(this.scene);
    // three.js calls this once per view (split screen included) before it builds that view's render list
    this.scene.onBeforeRender = (_r, _s, camera) => this.applyLensFade(camera);
  }

  /** Dissolve every kart (CPU, the other player, the ghost) that is right at this view's camera. */
  private applyLensFade(camera: THREE.Camera): void {
    const c = camera.position;
    const fade = (v: KartVisual | null) => {
      const ext = v as (KartVisual & Partial<KartVisualExtras>) | null;
      if (!ext?.setLensFade) return;
      const r = v!.root.position;
      ext.setLensFade(lensFade(Math.hypot(r.x - c.x, r.y + 0.55 - c.y, r.z - c.z), KART_LENS_GONE, KART_LENS_START));
    };
    for (let i = 0; i < this.kartVisuals.length; i++) fade(this.kartVisuals[i]!);
    fade(this.ghostVisual);
  }

  /** A camera of this race (shader warm-up before the first frame). */
  get warmUpCamera(): THREE.PerspectiveCamera { return this.cameras[0]!.camera; }

  /** onFinish has fired: the results are up (the race scene only serves as their backdrop). */
  get raceOver(): boolean { return this.finishedNotified; }

  /** The debug bots drove a racing human kart at some point (time-trial summary carries no record). */
  get assistedRun(): boolean { return this.assisted; }

  private precomputeGhostLaps(g: GhostData): number[] | null {
    try {
      const c = this.opts.config;
      const gp = new GhostPlayer(c.trackId, c.cc, g.charId, g.log);
      let guard = 60 * 60 * 15;
      while (!gp.done && guard-- > 0) gp.step();
      gp.step();
      return [...gp.kart.lapTicks];
    } catch {
      return null;
    }
  }

  private makeGhost(g: GhostData): GhostPlayer | null {
    try {
      const c = this.opts.config;
      return new GhostPlayer(c.trackId, c.cc, g.charId, g.log);
    } catch {
      return null;
    }
  }

  get inIntro(): boolean { return this.introActive; }

  setDebugBots(on: boolean): void {
    this.debugBots = on ? this.humanKarts.map((_, p) => createAiState(new Rng(1234 + p), 'hard')) : null;
  }

  skipIntro(): void {
    if (this.introActive) this.introT = 1;
  }

  hudSnapshot(player: number): HudSnapshot | null {
    return this.hud.snapshot(player, this.introActive);
  }

  /** Advance one rendered frame. */
  frame(dt: number, paused: boolean): void {
    if (this.disposed) return;
    if (!(dt > 0)) dt = 0; // NaN / negative (clock skew) must not poison time, intro or the accumulator
    else if (dt > 0.25) dt = 0.25;
    if (!paused) this.time += dt;
    let events: RaceEvent[] = [];
    if (!paused) {
      if (this.introActive) {
        this.introT = Math.min(1, this.introT + dt / INTRO_SECONDS);
        if (this.introT >= 1) this.introActive = false;
      } else {
        events = this.stepSimulation(dt);
      }
      this.hud.onEvents(events, this.ghost ? (this.ghostLaps ?? this.ghost.kart.lapTicks) : null);
      this.hud.advance(dt);
      this.handleEvents(events);
    }
    const alpha = this.introActive ? 1 : Math.min(1, this.acc / DT);
    this.updateVisuals(paused ? 0 : dt, alpha);
    this.updateCameras(paused ? 0 : dt);
    this.render(paused ? 0 : dt);
    if (!paused) this.checkFinish(dt);
  }

  private stepSimulation(dt: number): RaceEvent[] {
    const events: RaceEvent[] = [];
    this.acc += Math.min(dt, 0.25);
    let steps = 0;
    while (this.acc >= DT && steps < 5) {
      const inputs = this.humanKarts.map((kartIdx, p) => {
        const k = this.world.karts[kartIdx]!;
        let inp = this.deps.input.poll(p, DT);
        if (this.debugBots) {
          const scale = k.speedScale;
          inp = computeAiInput(this.world, k, this.debugBots[p]!);
          k.speedScale = scale;
          if (!k.finished) this.assisted = true;
        }
        this.lastInputs[p] = inp;
        if (this.recorder && p === 0 && !k.finished) this.recorder.push(inp);
        return inp;
      });
      for (let i = 0; i < this.world.karts.length; i++) {
        const k = this.world.karts[i]!;
        const pr = this.prev[i]!;
        pr.x = k.x; pr.y = k.y; pr.z = k.z; pr.yaw = k.yaw;
      }
      if (this.ghost && this.ghostPrev) {
        const gk = this.ghost.kart;
        this.ghostPrev.x = gk.x; this.ghostPrev.y = gk.y; this.ghostPrev.z = gk.z; this.ghostPrev.yaw = gk.yaw;
      }
      this.snapshotProjectiles();
      this.world.step(inputs);
      if (this.ghost) {
        // the ghost's own events are drained inside GhostPlayer: detect its respawn teleport from state
        const gk = this.ghost.kart;
        const respawning = gk.respawnTime > 0;
        this.ghost.step();
        if (respawning && gk.respawnTime <= 0 && this.ghostPrev) {
          this.ghostPrev.x = gk.x; this.ghostPrev.y = gk.y; this.ghostPrev.z = gk.z; this.ghostPrev.yaw = gk.yaw;
        }
      }
      const stepEvents = this.world.drainEvents();
      for (const e of stepEvents) {
        // a respawn teleports the kart: interpolate from the new spot, not across the map
        if (e.t === 'respawn') {
          const k = this.world.karts[e.kart], pr = this.prev[e.kart];
          if (k && pr) { pr.x = k.x; pr.y = k.y; pr.z = k.z; pr.yaw = k.yaw; }
        }
        events.push(e);
      }
      this.acc -= DT;
      steps++;
    }
    if (steps === 5 && this.acc > DT) this.acc = 0;
    return events;
  }

  private isHuman(kart: number): number {
    return this.humanKarts.indexOf(kart);
  }

  /** Gamepad vibration, honouring the rumble setting (defaults to on for settings saved before it existed). */
  private rumble(player: number, strength: number, ms: number): void {
    if (this.deps.settings.rumble === false) return;
    this.deps.input.rumble(player, strength, ms);
  }

  private handleEvents(events: readonly RaceEvent[]): void {
    const { audio, settings } = this.deps;
    const karts = this.world.karts;
    audio.handleEvents(events, karts, this.humanKarts);
    const pal = THEME_PALETTES[this.track.def.theme];
    for (const e of events) {
      switch (e.t) {
        case 'countdown':
          this.trackMesh.setStartLights?.(e.n);
          if (e.n === 0) this.startLightsOffAt = this.time + 2.5;
          break;
        case 'itemBox':
          this.particles.emit('itemBoxBurst', e.x, e.y, e.z);
          break;
        case 'coin':
          this.particles.emit('coinSparkle', e.x, e.y, e.z);
          break;
        case 'explosion': {
          this.particles.emit('explosion', e.x, e.y, e.z, { scale: Math.max(0.6, e.radius / 4) });
          this.shakeNear(e.x, e.z, e.radius * 0.18, 40);
          break;
        }
        case 'wall': {
          this.particles.emit('wallSpark', e.x, e.y, e.z, { count: Math.min(24, 6 + Math.round(e.impact * 1.5)) });
          const p = this.isHuman(e.kart);
          if (p >= 0) {
            if (settings.shake) this.cameras[p]!.shake(Math.min(0.5, e.impact * 0.03));
            this.rumble(p, Math.min(1, e.impact / 14), 120);
          }
          break;
        }
        case 'kartBump':
          this.particles.emit('wallSpark', e.x, e.y, e.z, { count: 8 });
          for (const kk of [e.a, e.b]) {
            const p = this.isHuman(kk);
            if (p >= 0) this.rumble(p, 0.35, 90);
          }
          break;
        case 'hit': {
          const k = karts[e.kart]!;
          if (e.kind === 'bump') break;
          this.particles.emit('smoke', k.x, k.y + 0.6, k.z, { count: 14 });
          if (e.kind === 'tumble') this.particles.emit('explosion', k.x, k.y + 0.5, k.z, { scale: 0.5 });
          const p = this.isHuman(e.kart);
          if (p >= 0) {
            if (settings.shake) this.cameras[p]!.shake(e.kind === 'tumble' ? 0.55 : 0.3);
            this.rumble(p, e.kind === 'tumble' ? 1 : 0.6, 300);
          }
          break;
        }
        case 'thunder':
          for (const k of karts) if (k.shrinkTime > 0) this.particles.emit('shrinkPoof', k.x, k.y + 0.6, k.z);
          for (let p = 0; p < this.cameras.length; p++) if (settings.shake) this.cameras[p]!.shake(0.35);
          break;
        case 'ink':
          for (const t of e.targets) {
            const k = karts[t]!;
            this.particles.emit('inkSplat', k.x, k.y + 1, k.z);
          }
          break;
        case 'land': {
          const k = karts[e.kart]!;
          this.particles.emit(pal.ground === THEME_PALETTES.snow.ground ? 'snowPuff' : 'landingDust', k.x, k.y + 0.1, k.z, { count: e.hard ? 18 : 8 });
          const p = this.isHuman(e.kart);
          if (p >= 0 && e.hard && settings.shake) this.cameras[p]!.shake(0.25);
          break;
        }
        case 'fall': {
          const k = karts[e.kart]!;
          if (pal.pit === 'water') this.particles.emit('splash', k.x, k.y - 2, k.z, { count: 30 });
          else if (pal.pit === 'lava') this.particles.emit('lavaEmber', k.x, k.y - 2, k.z, { count: 30 });
          break;
        }
        case 'respawn': {
          const k = karts[e.kart]!;
          this.particles.emit('shrinkPoof', k.x, k.y + 0.8, k.z);
          // (prev pose was already reset at the step that teleported the kart)
          const p = this.isHuman(e.kart);
          if (p >= 0) this.cameras[p]!.reset();
          break;
        }
        case 'stall': {
          const k = karts[e.kart]!;
          this.particles.emit('smoke', k.x, k.y + 0.8, k.z, { count: 20, color: '#555555' });
          break;
        }
        case 'boost': {
          const p = this.isHuman(e.kart);
          if (p >= 0) this.rumble(p, e.kind === 'mini3' || e.kind === 'start' ? 0.7 : 0.35, 140);
          break;
        }
        case 'finalLap':
          if (this.isHuman(e.kart) >= 0 && !this.finalLapMusic) {
            this.finalLapMusic = true;
            audio.setFinalLap(true);
          }
          break;
        case 'finish': {
          const p = this.isHuman(e.kart);
          if (p >= 0) {
            const k = karts[e.kart]!;
            this.finishTime[p] = this.time;
            for (let n = 0; n < 4; n++) this.particles.emit('confetti', k.x, k.y + 3, k.z, { count: 40 });
          }
          break;
        }
        case 'projectileGone':
          this.particles.emit('smoke', e.x, e.y, e.z, { count: 5, scale: 0.6 });
          break;
        case 'projectileBounce':
          // orb ricochet off a barrier: small spark burst so the bounce reads (it was sound-only)
          this.particles.emit('wallSpark', e.x, e.y, e.z, { count: 6, color: '#b8ffd0' });
          break;
        case 'coinLoss': {
          // coins knocked loose by a hit: a gold sparkle burst per lost coin (HUD counter alone was easy to miss)
          const k = karts[e.kart];
          if (k && e.count > 0) this.particles.emit('coinSparkle', k.x, k.y + 0.9, k.z, { count: Math.min(20, 5 * e.count) });
          break;
        }
        default:
          break;
      }
    }
    if (this.startLightsOffAt > 0 && this.time > this.startLightsOffAt) {
      this.startLightsOffAt = -1;
      this.trackMesh.setStartLights?.(null);
    }
  }

  private shakeNear(x: number, z: number, strength: number, radius: number): void {
    if (!this.deps.settings.shake) return;
    this.humanKarts.forEach((ki, p) => {
      const k = this.world.karts[ki]!;
      const d = Math.hypot(k.x - x, k.z - z);
      if (d < radius) this.cameras[p]!.shake(Math.min(0.6, strength * (1 - d / radius) * 2));
    });
  }

  private poseOf(i: number, alpha: number, out: KartPose): KartPose {
    return lerpPose(this.prev[i]!, this.world.karts[i]!, alpha, out);
  }

  /** Projectile positions before the latest tick (by id), for interpolation. */
  private readonly projPrev = new Map<number, { x: number; y: number; z: number }>();
  private readonly projSpare: Array<{ x: number; y: number; z: number }> = [];
  private readonly projPool: ProjectileDraw[] = [];
  private readonly projDraw: ProjectileDraw[] = [];

  private snapshotProjectiles(): void {
    for (const v of this.projPrev.values()) this.projSpare.push(v);
    this.projPrev.clear();
    for (const p of this.world.projectiles) {
      const o = this.projSpare.pop() ?? { x: 0, y: 0, z: 0 };
      o.x = p.x; o.y = p.y; o.z = p.z;
      this.projPrev.set(p.id, o);
    }
  }

  /** world.projectiles at the kart render time (ProjectileVisuals leaves interpolation to the caller). */
  private interpolatedProjectiles(alpha: number): readonly ProjectileDraw[] {
    const list = this.world.projectiles;
    const out = this.projDraw;
    out.length = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!;
      const o = this.projPool[i] ?? (this.projPool[i] = { id: 0, kind: 'banana', x: 0, y: 0, z: 0, vx: 0, vz: 0, state: 'fly' });
      const q = this.projPrev.get(p.id);
      const t = !q || Math.abs(p.x - q.x) + Math.abs(p.z - q.z) > TELEPORT_DIST ? 1 : alpha;
      o.id = p.id; o.kind = p.kind; o.vx = p.vx; o.vz = p.vz; o.state = p.state;
      o.x = q ? q.x + (p.x - q.x) * t : p.x;
      o.y = q ? q.y + (p.y - q.y) * t : p.y;
      o.z = q ? q.z + (p.z - q.z) * t : p.z;
      out.push(o);
    }
    return out;
  }

  private readonly poses: KartPose[] = [];
  private readonly ghostPose: KartPose = { x: 0, y: 0, z: 0, yaw: 0 };
  private emitAccum = 0;

  private updateVisuals(dt: number, alpha: number): void {
    const karts = this.world.karts;
    const theme = this.track.def.theme;
    while (this.poses.length < karts.length) this.poses.push({ x: 0, y: 0, z: 0, yaw: 0 });
    // 30 emissions/s whatever the refresh rate: carry the remainder (resetting to 0 gave 20/s at 60 Hz,
    // 15/s at 30 Hz and a jitter-dependent 2-or-3-frame cadence)
    this.emitAccum += dt;
    const emitNow = this.emitAccum >= EMIT_INTERVAL;
    if (emitNow) this.emitAccum = Math.min(this.emitAccum - EMIT_INTERVAL, EMIT_INTERVAL);
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i]!;
      const pose = this.poseOf(i, alpha, this.poses[i]!);
      const p = this.isHuman(i);
      const inp = p >= 0 ? this.lastInputs[p]! : null;
      // k.throttle is what the sim applied last tick (CPU, stalled, finished-on-autopilot karts too),
      // the same signal the engine audio uses
      const vo = this.visOpts; // reused: no per-kart garbage every frame
      vo.lookBack = !!inp?.back; vo.throttle = k.throttle; vo.time = this.time;
      this.kartVisuals[i]!.update(k, pose, dt, vo);
      if (emitNow && dt > 0) this.emitContinuous(k, pose, theme);
    }
    if (this.ghost && this.ghostVisual && this.ghostPrev) {
      const gk = this.ghost.kart;
      const pose = lerpPose(this.ghostPrev, gk, alpha, this.ghostPose);
      this.ghostVisual.update(gk, pose, dt, { lookBack: false, throttle: gk.throttle, time: this.time, ghost: true });
      this.ghostVisual.root.visible = !gk.finished || this.time % 1 < 0.7;
    }
    this.projectiles.update(this.interpolatedProjectiles(alpha), dt, this.time);
    // Movers are a pure function of time: draw them at the kart render time. The kart state after
    // tick N was resolved against the mover at N-1, and karts are drawn at prev→cur = (N-1)→N.
    const moverTick = this.introActive ? this.world.tick : Math.max(0, this.world.tick - 2 + alpha);
    for (let i = 0; i < this.movers.length; i++) {
      const m = this.movers[i]!;
      const pos = this.world.moverPositionAt(i, moverTick);
      m.outer.position.set(pos.x, pos.y, pos.z);
      m.outer.rotation.y = pos.yaw;
      if (m.rolls) {
        const dist = Math.hypot(pos.x - m.lastX, pos.z - m.lastZ);
        m.inner.rotation.x += dist / Math.max(0.5, m.radius);
      }
      m.lastX = pos.x; m.lastZ = pos.z;
    }
    this.trackMesh.update(dt, this.time);
  }

  /** Wheel dust, star trails and drift embers driven by kart state. */
  private emitContinuous(k: KartState, pose: KartPose, theme: string): void {
    if (k.respawnTime > 0) return;
    if (k.boostTime > 0 && k.autopilotTime <= 0) {
      // Exhaust licks + embers trailing behind the two nozzles (the kart model's attached flame cones
      // point back at the chase camera, which sees them end-on as two small dots).
      const col = k.starTime > 0 ? '#ffffff' : BOOST_TINT[k.boostKind ?? 'nitro'] ?? BOOST_TINT.nitro!;
      const yv = pose.yaw + k.driftAngle;
      const sv = Math.sin(yv), cv = Math.cos(yv);
      for (const side of [-1, 1]) {
        // kart-local exhaust (±0.2, 0.7, −1.15); local +X is the kart's left. The licks inherit the kart's
        // velocity so they stay on the nozzles (world-space ones were left behind as a dotted trail).
        const sc = k.shrinkTime > 0 ? 0.55 : 1;
        const ex = pose.x + (side * 0.2 * cv - 1.15 * sv) * sc, ez = pose.z + (-side * 0.2 * sv - 1.15 * cv) * sc;
        const o = { count: 2, color: col, dirX: -sv, dirY: 0.3, dirZ: -cv, scale: sc };
        if (this.particles.emitMoving) this.particles.emitMoving('boostFlame', ex, pose.y + 0.72 * sc, ez, k.vx, k.vy, k.vz, o);
        else this.particles.emit('boostFlame', ex, pose.y + 0.72 * sc, ez, o);
      }
    }
    if (!k.grounded) return;
    const speed = Math.abs(k.speed);
    const s = Math.sin(pose.yaw), c = Math.cos(pose.yaw);
    const rearX = pose.x - s * 0.8, rearZ = pose.z - c * 0.8;
    if ((k.surface === 'dirt' || k.surface === 'mud') && speed > 6) {
      const kind = theme === 'snow' ? 'snowPuff' : theme === 'meadow' || theme === 'jungle' ? 'grassBits' : 'dust';
      this.particles.emit(kind, rearX, pose.y + 0.2, rearZ, { count: 2, dirX: -s, dirZ: -c });
    }
    if (k.starTime > 0 && speed > 4) this.particles.emit('starTrail', rearX, pose.y + 0.5, rearZ, { count: 2 });
    if (k.driftDir !== 0 && k.driftLevel > 0 && speed > 8) {
      const col = k.driftLevel === 1 ? '#4db8ff' : k.driftLevel === 2 ? '#ff9a1f' : '#d04dff';
      const rx = -c, rz = s; // right vector
      for (const side of [-1, 1]) {
        this.particles.emit('driftSpark', rearX + rx * 0.7 * side, pose.y + 0.15, rearZ + rz * 0.7 * side, { count: 1, color: col, dirX: -s, dirZ: -c });
      }
    }
  }

  /** Kart shown in view p: that player's kart, or the race leader when nobody is human. */
  private viewKart(p: number): number {
    const ki = this.humanKarts[p];
    if (ki !== undefined) return ki;
    const lead = this.world.karts.find(k => k.position === 1)?.index ?? 0;
    if (lead !== this.spectating) { this.spectating = lead; this.cameras[p]?.reset(); } // cut, don't swoop
    return lead;
  }
  private spectating = 0;

  private updateCameras(dt: number): void {
    const { settings } = this.deps;
    this.cameras.forEach((cam, p) => {
      const ki = this.viewKart(p);
      const k = this.world.karts[ki]!;
      const pose = this.poses[ki] ?? { x: k.x, y: k.y, z: k.z, yaw: k.yaw };
      if (this.introActive) {
        const g = this.track.grid[ki] ?? this.track.grid[0]!;
        cam.intro(this.track, { x: g.x, y: g.y, z: g.z, yaw: g.yaw }, this.easeIntro(this.introT), this.deps.settings.cameraDistance);
        return;
      }
      this.kartVisuals[ki]!.focus(this.focusTmp);
      if (k.finished && this.finishTime[p]! >= 0 && this.time - this.finishTime[p]! > 1.2) {
        cam.orbit(this.focusTmp, dt);
        return;
      }
      cam.follow({
        pose, focus: this.focusTmp, speed: k.speed, maxSpeed: k.maxSpeed,
        boosting: k.boostTime > 0 || k.autopilotTime > 0, driftAngle: k.driftAngle,
        airborne: !k.grounded, lookBack: !!this.lastInputs[p]?.back, distance: settings.cameraDistance,
      }, dt, this.track);
    });
  }

  private easeIntro(t: number): number {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  private render(dt: number): void {
    const { pipeline, audio } = this.deps;
    const size = pipeline.resize();
    const n = this.cameras.length;
    // per-frame view list, listeners and camera list are reused (no garbage in the frame loop)
    const views = this.frameViews, viewCams = this.frameCams;
    views.length = n; viewCams.length = n;
    for (let p = 0; p < n; p++) {
      const cam = this.cameras[p]!;
      const v = views[p] ??= { camera: cam.camera, viewport: { x: 0, y: 0, w: 1, h: 1 }, speedLines: 0, inkAmount: 0 };
      const vp = v.viewport;
      if (n === 1) { vp.x = 0; vp.y = 0; vp.w = size.width; vp.h = size.height; }
      else { vp.x = 0; vp.y = p * Math.floor(size.height / 2); vp.w = size.width; vp.h = Math.floor(size.height / 2); }
      cam.setAspect(vp.w / Math.max(1, vp.h));
      const k = this.world.karts[this.viewKart(p)]!;
      const fast = Math.abs(k.speed) / Math.max(1, k.maxSpeed);
      const lines = this.introActive ? 0 : k.boostTime > 0 || k.autopilotTime > 0 ? 1 : fast > 0.97 ? 0.25 : 0;
      v.camera = cam.camera;
      v.speedLines = this.deps.settings.shake ? lines : lines * 0.4;
      v.inkAmount = this.hud.inkAmount(p);
      viewCams[p] = cam.camera;
    }
    // pickups are view-culled per instance, so they update once this frame's cameras are placed
    this.pickups.setViewers?.(viewCams);
    this.pickups.update(this.world.itemBoxes, this.world.coins, dt, this.time);
    const lead = this.world.karts[this.viewKart(0)]!;
    pipeline.setShadowFocus(lead.x, lead.y, lead.z);
    const cam0 = this.cameras[0]!.camera;
    this.scenery.update(dt, this.time, cam0);
    this.particles.update(dt, cam0);
    const listeners = this.frameListeners;
    listeners.length = n;
    for (let p = 0; p < n; p++) {
      const c = this.cameras[p]!.camera;
      const l = listeners[p] ??= { x: 0, y: 0, z: 0, yaw: 0 };
      l.x = c.position.x; l.y = c.position.y; l.z = c.position.z; l.yaw = this.tmpYaw(c);
    }
    audio.update(this.world.karts, listeners, this.humanKarts, dt);
    pipeline.render(this.scene, views, dt);
  }

  private readonly visOpts: KartVisualOptions = { lookBack: false, throttle: true, time: 0 };
  private readonly frameViews: Array<{ camera: THREE.PerspectiveCamera; viewport: Viewport; speedLines: number; inkAmount: number }> = [];
  private readonly frameCams: THREE.Camera[] = [];
  private readonly frameListeners: Array<{ x: number; y: number; z: number; yaw: number }> = [];

  private tmpYaw(cam: THREE.Camera): number {
    cam.getWorldDirection(this.tmpV);
    return Math.atan2(this.tmpV.x, this.tmpV.z);
  }

  private checkFinish(dt: number): void {
    if (this.finishedNotified) return;
    if (this.world.phase !== 'done') return;
    if (this.doneTimer < 0) this.doneTimer = 0;
    this.doneTimer += dt;
    if (this.doneTimer < CELEBRATION_SECONDS) return;
    this.finishedNotified = true;
    this.opts.onFinish(this.summary());
  }

  summary(): RaceSummary {
    const c = this.opts.config;
    const human = this.world.karts[this.humanKarts[0] ?? 0]!;
    return {
      config: c,
      results: this.world.results(),
      // a run the debug bots drove is no record: no personal best, no leaderboard submission
      timeTrial: c.mode === 'tt' && this.recorder && human.finished && !this.assisted ? {
        trackId: c.trackId, cc: c.cc, charId: human.charId,
        ticks: human.finishTick, lapTicks: [...human.lapTicks], log: this.recorder.encode(),
      } : null,
    };
  }

  /** Race time elapsed since GO in seconds (for debugging / HUD). */
  get raceSeconds(): number { return Math.max(0, this.world.tick - COUNTDOWN_TICKS) * DT; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deps.audio.stopRace();
    setKartEnvIntensity(1);
    if (this.finalLapMusic) this.deps.audio.setFinalLap(false);
    for (const v of this.kartVisuals) v.dispose();
    this.ghostVisual?.dispose();
    this.pickups.dispose();
    this.projectiles.dispose();
    this.particles.dispose();
    this.trackMesh.dispose();
    this.scenery.dispose();
    // movers are built per session by the scenery module; everything else disposes itself
    for (const m of this.movers) m.outer.traverse(o => { const mesh = o as THREE.Mesh; if (mesh.isMesh) mesh.geometry?.dispose(); });
    this.instanceCulling.dispose();
    this.sceneOpt.dispose();
    this.scene.onBeforeRender = THREE.Object3D.prototype.onBeforeRender;
    this.scene.clear();
  }
}
