/**
 * GameView: owns the WebGL canvas, the menu showroom and the running race.
 */
import type * as THREE from 'three';
import type { CharacterId } from '../../sim/types.js';
import { CHARACTER_IDS } from '../../sim/characters.js';
import type { AudioSystem, GameView, HudSnapshot, InputManager, RaceStartOptions, Settings } from '../contracts.js';
import { DEFAULT_SETTINGS } from '../contracts.js';
import type { RenderPipeline, Showroom } from '../render/contracts.js';
import { createRenderPipeline, type RenderPipelineExt } from '../render/renderer.js';
import { createShowroom } from '../render/showroom.js';
import { RaceSession } from './race-session.js';

export interface GameViewDeps {
  audio: AudioSystem;
  input: InputManager;
}

/** Longest a race start waits for its shaders to compile before showing the race anyway. */
const WARMUP_CAP_MS = 8000;

type PipelineHooks = RenderPipeline & Partial<Pick<RenderPipelineExt, 'setRaceActive' | 'warmUp'>>;

class GameViewImpl implements GameView {
  private pipeline: PipelineHooks | null = null;
  private showroom: Showroom | null = null;
  private session: RaceSession | null = null;
  /** Built but still compiling its shaders (not on screen yet). */
  private pending: RaceSession | null = null;
  /** Last value passed to pipeline.setRaceActive (race on screen, not paused, results not up). */
  private raceActive = false;
  /** Duration of the last shader warm-up (debug/QA). */
  private lastWarmUpMs = 0;
  private lastOpts: RaceStartOptions | null = null;
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private isPaused = false;
  private raf = 0;
  private last = 0;
  private time = 0;
  private backdrop: { kind: 'title' | 'garage' | 'podium'; chars: CharacterId[] } = { kind: 'title', chars: [...CHARACTER_IDS] };
  private container: HTMLElement | null = null;
  private visibilityHandler = () => { this.last = performance.now(); };
  /** Bumped by every startRace()/endRace(): a scene build that finishes after a newer call is dropped. */
  private startSeq = 0;
  /** A startRace() is waiting for its build frame. */
  private starting = false;
  /** Restarting: keep the last race frame on screen instead of flashing the menu showroom. */
  private holdFrame = false;

  constructor(private readonly deps: GameViewDeps) {}

  mount(container: HTMLElement): void {
    if (this.pipeline) return;
    this.container = container;
    const pipeline = createRenderPipeline(container, this.settings.quality === 'auto' ? 'auto' : this.settings.quality);
    const room = createShowroom(pipeline);
    room.show(this.backdrop.kind, this.backdrop.chars);
    this.pipeline = pipeline;
    this.showroom = room;
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  applySettings(s: Settings): void {
    const qualityChanged = s.quality !== this.settings.quality;
    // Mutate in place: the running RaceSession holds this object (deps.settings), so camera
    // distance / shake changed from the pause menu apply live instead of on the next race.
    Object.assign(this.settings, s);
    if (qualityChanged && this.pipeline) this.pipeline.setQuality(s.quality === 'auto' ? 'auto' : s.quality);
    this.deps.input.applySettings(s);
  }

  showBackdrop(kind: 'title' | 'garage', charId?: CharacterId): void {
    const chars = kind === 'garage' && charId ? [charId] : [...CHARACTER_IDS];
    this.backdrop = { kind, chars };
    if (!this.session) this.showroom?.show(kind, chars);
  }

  showPodium(top3: CharacterId[]): void {
    this.endRace();
    this.backdrop = { kind: 'podium', chars: top3.slice(0, 3) };
    this.showroom?.show('podium', this.backdrop.chars);
  }

  async startRace(opts: RaceStartOptions): Promise<void> {
    if (!this.pipeline) throw new Error('GameView not mounted');
    const seq = ++this.startSeq;
    const restarting = !!this.session || this.holdFrame;
    this.disposeSession();
    this.holdFrame = restarting;
    this.starting = true;
    this.lastOpts = opts;
    this.isPaused = false;
    // a quality tier the governor deferred during the last race is applied now, before the new scene is built
    this.setRaceActive(false);
    // Building a race scene takes a few frames' worth of work; yield first so the UI can show a loader.
    await new Promise(r => requestAnimationFrame(() => r(null)));
    // A newer startRace() or an endRace() arrived meanwhile: this build is obsolete.
    if (seq !== this.startSeq || !this.pipeline) return;
    let session: RaceSession;
    try {
      session = new RaceSession(opts, {
        pipeline: this.pipeline, audio: this.deps.audio, input: this.deps.input, settings: this.settings,
      });
    } catch (err) {
      this.starting = false;
      this.holdFrame = false;
      throw err;
    }
    this.pending = session;
    if (this.debugBots) session.setDebugBots(true);
    // Compile the new scene's shaders before it is shown (the first race frame used to do it, blocking for
    // up to seconds). The loader / held last frame stays up meanwhile; a newer start or endRace() wins.
    const warm = this.warmUp(session);
    if (warm) await warm;
    if (seq !== this.startSeq || this.pending !== session) {
      if (this.pending === session) this.pending = null;
      session.dispose(); // (already disposed by whoever superseded it; dispose is idempotent)
      return;
    }
    this.pending = null;
    this.starting = false;
    this.holdFrame = false;
    this.session = session;
    this.last = performance.now();
  }

  /** Shader warm-up for a freshly built session; null when the renderer can't precompile. Never rejects. */
  private warmUp(session: RaceSession): Promise<void> | null {
    const pipe = this.pipeline;
    if (!pipe) return null;
    const cam = session.warmUpCamera;
    const t0 = performance.now();
    let p: Promise<unknown>;
    try {
      const r = pipe.renderer as Partial<Pick<THREE.WebGLRenderer, 'compileAsync'>> | undefined;
      if (pipe.warmUp) p = pipe.warmUp(session.scene, cam);
      else if (r && typeof r.compileAsync === 'function') p = r.compileAsync(session.scene, cam);
      else return null;
    } catch {
      return null; // compile threw synchronously: the first frame compiles instead, as before
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>(res => { timer = setTimeout(res, WARMUP_CAP_MS); });
    return Promise.race([p.then(() => undefined, () => undefined), cap]).then(() => {
      clearTimeout(timer);
      this.lastWarmUpMs = performance.now() - t0;
    });
  }

  private setRaceActive(on: boolean): void {
    if (on === this.raceActive) return;
    this.raceActive = on;
    this.pipeline?.setRaceActive?.(on);
  }

  skipIntro(): void { this.session?.skipIntro(); }

  pause(): void {
    // also honoured while a race is still being built (tab hidden / Esc during a restart)
    if ((!this.session && !this.starting) || this.isPaused) return;
    this.isPaused = true;
    this.setRaceActive(false); // paused: a deferred quality tier may apply now
  }

  resume(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    this.last = performance.now();
  }

  get paused(): boolean { return this.isPaused; }
  get inRace(): boolean { return !!this.session; }

  restartRace(): void {
    const opts = this.lastOpts;
    if (!opts) return;
    // Time trials keep the fixed seed (verifiable); other modes get a fresh seed so CPUs and items vary.
    const seed = opts.config.mode === 'tt' ? opts.config.seed : (crypto.getRandomValues(new Uint32Array(1))[0]! >>> 0);
    this.startRace({ ...opts, config: { ...opts.config, seed } }).catch(err => {
      console.error('[game] restart failed', err);
      this.endRace();
    });
  }

  endRace(): void {
    this.startSeq++; // cancels a start that is still waiting for its build frame
    this.starting = false;
    this.holdFrame = false;
    this.disposeSession();
    this.isPaused = false;
    this.setRaceActive(false);
    this.showroom?.show(this.backdrop.kind, this.backdrop.chars);
  }

  private disposeSession(): void {
    if (this.pending) {
      this.pending.dispose();
      this.pending = null;
    }
    if (!this.session) return;
    this.session.dispose();
    this.session = null;
  }

  hud(player: number): HudSnapshot | null {
    return this.session ? this.session.hudSnapshot(player) : null;
  }

  get track() { return this.session ? this.session.track : null; }

  /** QA/debug helpers (exposed by main.ts only with ?debug). */
  /** Persistent across races (QA journeys set it once). A time trial the bots drove is not a record. */
  debugSetBots(on: boolean): void { this.session?.setDebugBots(on); this.pending?.setDebugBots(on); this.debugBots = on; }
  debugState(): Record<string, unknown> {
    const r = this.pipeline?.renderer;
    return {
      inRace: !!this.session,
      intro: this.session?.inIntro ?? false,
      raceSeconds: this.session?.raceSeconds ?? 0,
      phase: this.session?.world.phase ?? null,
      fps: this.fps,
      quality: this.pipeline?.quality.level,
      calls: r?.info.render.calls ?? 0,
      triangles: r?.info.render.triangles ?? 0,
      geometries: r?.info.memory.geometries ?? 0,
      textures: r?.info.memory.textures ?? 0,
      warmUpMs: Math.round(this.lastWarmUpMs),
      assisted: this.session?.assistedRun ?? false,
    };
  }
  private debugBots = false;
  get fps(): number { return this.pipeline ? this.pipeline.fps : 0; }

  private frame(dt: number): void {
    if (!this.pipeline) return;
    this.time += dt;
    if (this.session) {
      this.setRaceActive(!this.isPaused && !this.session.raceOver);
      this.session.frame(dt, this.isPaused);
      return;
    }
    // restart in progress: the canvas keeps showing the last race frame; and while a new race's shaders
    // compile the (opaque) race loader covers the canvas, so the backdrop is not redrawn behind it — it
    // would only compete with the compile for the GPU
    if (this.holdFrame || this.pending) return;
    const room = this.showroom;
    if (!room) return;
    const size = this.pipeline.resize();
    room.setAspect(size.width / Math.max(1, size.height));
    room.update(dt, this.time);
    this.pipeline.render(room.scene, [{ camera: room.camera, viewport: { x: 0, y: 0, w: size.width, h: size.height }, speedLines: 0, inkAmount: 0 }], dt);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.endRace();
    this.showroom?.dispose();
    this.pipeline?.dispose();
    this.pipeline = null;
    this.container = null;
  }
}

export type DebugGameView = GameView & { debugSetBots(on: boolean): void; debugState(): Record<string, unknown> };

export function createGameView(deps: GameViewDeps): DebugGameView {
  return new GameViewImpl(deps);
}
