/**
 * WebAudio implementation of the AudioSystem contract. The AudioContext is created lazily
 * inside `unlock()` (a user gesture), so nothing is audible — and no autoplay warning is
 * logged — before the player interacts with the page.
 */
import type { AudioSystem, Listener, MusicCue, UiSound } from '../contracts.js';
import type { KartState, RaceEvent } from '../../sim/types.js';
import { getCharacter } from '../../sim/characters.js';
import { AudioResources, type AudioContextCtor } from './context.js';
import { Mixer } from './buses.js';
import { Sequencer } from './sequencer.js';
import { VoicePool, type Kit } from './sfx-lib.js';
import { SOUNDS, UI_SOUNDS } from './sounds.js';
import { SFX_IDS, RATE_LIMIT, planEvent, type PlanEnv, type SoundCall } from './event-map.js';
import { AUDIBLE_FLOOR, newSpatial, spatialize } from './spatial.js';
import { ContinuousAudio } from './engine.js';
import { speciesIndex } from './voices.js';

const EVENT_VOICES = 28;
const UI_VOICES = 6;
/** Longest wait for `AudioContext.resume()`: browsers keep it pending when the call had no user activation. */
const RESUME_WAIT_MS = 800;
const SFX_INDEX = new Map<string, number>(SFX_IDS.map((id, i) => [id, i]));

interface Graph {
  ctx: AudioContext;
  res: AudioResources;
  mixer: Mixer;
  seq: Sequencer;
  events: VoicePool;
  uiPool: VoicePool;
  cont: ContinuousAudio;
  kit: Kit;
}

function pageHidden(): boolean {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  } catch {
    return false;
  }
}

/**
 * True when the page has never received a user activation (e.g. the first touch `pointerdown`,
 * which is not activation-triggering; activation arrives with `pointerup`/`click`). Starting an
 * AudioContext then only logs an autoplay warning, so unlock() waits for a real gesture instead.
 */
function activationMissing(): boolean {
  try {
    const nav = (globalThis as { navigator?: { userActivation?: { isActive: boolean; hasBeenActive: boolean } } }).navigator;
    const ua = nav?.userActivation;
    return !!ua && !ua.isActive && !ua.hasBeenActive;
  } catch {
    return false;
  }
}

/** Resolve once `p` settles or after `ms`, whichever comes first (never rejects). */
function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    const done = () => { clearTimeout(timer); resolve(); };
    p.then(done, done);
  });
}

/** Call `ctx.resume()` without ever throwing synchronously. */
function tryResume(ctx: AudioContext): Promise<void> {
  try {
    return ctx.resume();
  } catch (err) {
    return Promise.reject(err);
  }
}

/** iOS only routes output once a source has been started inside a gesture handler. */
function primeOutput(ctx: AudioContext): void {
  try {
    const b = ctx.createBufferSource();
    b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    b.connect(ctx.destination);
    b.onended = () => { try { b.disconnect(); } catch { /* ignore */ } };
    b.start(0);
  } catch { /* ignore */ }
}

export class WebAudioSystem implements AudioSystem {
  private g: Graph | null = null;
  private failed = false;
  private isUnlocked = false;
  /** The context has run at least once: the sequencer is live and keeps its own state from then on. */
  private everUnlocked = false;
  /** Set by stopRace(): the next playMusic() starts its cue from the top even if it is already playing. */
  private restartCue = false;
  private volumes = { master: 0.8, music: 0.6, sfx: 0.8 };
  private pendingCue: string | null = null;
  private pendingFinalLap = false;
  private suspendDepth = 0;
  private countdown = false;
  private duckRestoreAt = 0;
  private readonly listeners: Listener[] = [];
  private readonly fallback: Listener[] = [];
  private readonly lastPlay = new Map<number, number>();
  private readonly finalLapKarts = new Set<number>();
  private humanRef: readonly number[] = [];
  private readonly env: PlanEnv = {
    isHuman: (k: number) => this.humanRef.includes(k),
    finalLapKarts: this.finalLapKarts,
  };
  private readonly sp = newSpatial();
  private readonly tickRoulette = (kart: number, n: number) => this.play('rouletteTick', 'global', kart, 0, 0, n, 6, 0, null);

  constructor(private readonly Ctor: AudioContextCtor) {}

  get unlocked(): boolean { return this.isUnlocked; }

  /** Read-only runtime state for diagnostics and tests. */
  diagnostics(): { cue: string | null; finalLap: boolean; tempo: number; star: boolean; players: number; eventVoices: number; suspended: boolean; engines: number[] } {
    const g = this.g;
    const now = g ? g.ctx.currentTime : 0;
    const music = this.musicGraph();
    return {
      cue: music ? music.seq.cue : this.pendingCue,
      finalLap: music ? music.seq.isFinalLap : this.pendingFinalLap,
      tempo: g ? g.seq.tempoFactor : 1,
      star: g ? g.seq.starActive : false,
      players: g ? g.seq.playerCount : 0,
      eventVoices: g ? g.events.busyCount(now) : 0,
      suspended: this.suspendDepth > 0,
      engines: g ? g.cont.activeKarts : [],
    };
  }

  // ───────────── lifecycle ─────────────

  /**
   * Every call from a gesture retries `resume()` (a call made without user activation stays
   * pending in Chrome/Firefox and must be repeated once activation exists). The returned promise
   * always settles — at the latest after RESUME_WAIT_MS — so callers chaining on it never hang;
   * if the context starts later, `onstatechange` completes the unlock.
   */
  unlock(): Promise<void> {
    if (this.failed) { this.isUnlocked = true; return Promise.resolve(); }
    if (this.isUnlocked && this.g?.ctx.state === 'running') return Promise.resolve();
    if (activationMissing()) return Promise.resolve();
    if (!this.g) {
      try {
        this.g = this.build();
      } catch {
        this.failed = true;
        this.isUnlocked = true;
        return Promise.resolve();
      }
    }
    const { ctx } = this.g;
    primeOutput(ctx);
    if (ctx.state === 'running') {
      this.onUnlocked();
      return Promise.resolve();
    }
    return settleWithin(tryResume(ctx), RESUME_WAIT_MS).then(() => {
      if (ctx.state === 'running') this.onUnlocked();
    });
  }

  private build(): Graph {
    const ctx = new this.Ctor({ latencyHint: 'interactive' });
    const res = new AudioResources(ctx);
    const mixer = new Mixer(ctx, res, ctx.destination);
    const seq = new Sequencer(ctx, res, mixer);
    const events = new VoicePool(ctx, mixer.events, EVENT_VOICES);
    const uiPool = new VoicePool(ctx, mixer.ui, UI_VOICES);
    const cont = new ContinuousAudio(ctx, res, mixer.loops);
    ctx.onstatechange = () => {
      if (ctx.state === 'running') {
        // a resume() that was pending (or an OS interruption that ended) finished the unlock
        this.onUnlocked();
        return;
      }
      // An OS interruption (iOS call, audio focus loss) suspends the context behind our back:
      // drop the unlocked flag so the next user gesture calls unlock() again.
      if (this.suspendDepth === 0) this.isUnlocked = false;
    };
    return { ctx, res, mixer, seq, events, uiPool, cont, kit: { ctx, res } };
  }

  private onUnlocked(): void {
    const g = this.g;
    if (!g || this.failed) return;
    const first = !this.isUnlocked;
    this.isUnlocked = true;
    this.everUnlocked = true;
    if (!first) return;
    g.mixer.setVolumes(this.volumes);
    if (this.suspendDepth > 0) { g.mixer.hold(true); g.seq.pause(); }
    if (this.pendingCue) {
      g.seq.play(this.pendingCue, this.restartCue);
      this.restartCue = false;
      this.pendingCue = null;
      if (this.pendingFinalLap) g.seq.setFinalLap(true);
    }
    this.pendingFinalLap = false;
  }

  /** Graph usable for scheduling sounds right now. */
  private live(): Graph | null {
    return this.isUnlocked && this.g && !this.failed ? this.g : null;
  }

  /**
   * Graph whose sequencer may be driven. Once the context has run, music state goes straight to
   * the sequencer even during an OS interruption, so stopMusic()/setFinalLap() are never lost.
   */
  private musicGraph(): Graph | null {
    return this.everUnlocked && this.g && !this.failed ? this.g : null;
  }

  setVolumes(v: { master: number; music: number; sfx: number }): void {
    this.volumes = { master: v.master, music: v.music, sfx: v.sfx };
    const g = this.live();
    if (g) g.mixer.setVolumes(this.volumes);
  }

  suspend(): void {
    this.suspendDepth++;
    const g = this.live();
    if (!g) return;
    if (this.suspendDepth === 1) {
      g.seq.pause();
      g.mixer.hold(true);
    }
    if (pageHidden()) {
      // hidden tab: stop the audio thread entirely once the fade has finished
      setTimeout(() => {
        if (this.suspendDepth > 0 && pageHidden() && g.ctx.state === 'running') g.ctx.suspend().catch(() => undefined);
      }, 80);
    }
  }

  resume(): void {
    if (this.suspendDepth === 0) return;
    this.suspendDepth--;
    const g = this.live();
    if (!g) return;
    if (g.ctx.state !== 'running' && !pageHidden()) {
      const ctx = g.ctx;
      // Resuming outside a gesture can be refused (iOS after a background stay): then fall back to
      // "locked" so the app's next gesture calls unlock() again instead of staying silent forever.
      void settleWithin(tryResume(ctx), RESUME_WAIT_MS).then(() => {
        if (ctx.state !== 'running' && this.suspendDepth === 0 && !pageHidden()) this.isUnlocked = false;
      });
    }
    if (this.suspendDepth === 0) {
      g.mixer.hold(false);
      g.seq.resume();
    }
  }

  // ───────────── music ─────────────

  playMusic(cue: MusicCue): void {
    const g = this.musicGraph();
    if (!g) { this.pendingCue = cue; this.pendingFinalLap = false; return; }
    g.seq.play(cue, this.restartCue);
    this.restartCue = false;
    this.duckRestoreAt = 0;
  }

  setFinalLap(on: boolean): void {
    const g = this.musicGraph();
    if (!g) { this.pendingFinalLap = on && this.pendingCue !== null; return; }
    g.seq.setFinalLap(on);
  }

  stopMusic(fadeSeconds = 0.8): void {
    this.pendingCue = null;
    this.pendingFinalLap = false;
    this.restartCue = false;
    this.musicGraph()?.seq.stop(fadeSeconds);
  }

  // ───────────── sfx ─────────────

  ui(sound: UiSound): void {
    const g = this.live();
    if (!g || g.ctx.state !== 'running') return;
    const fn = UI_SOUNDS[sound];
    if (!fn) return;
    const now = g.ctx.currentTime;
    const slot = g.uiPool.acquire(now, 10, 1, 0, now);
    if (!slot) return;
    g.uiPool.commit(slot.strip, fn(g.kit, slot.strip, slot.start));
  }

  handleEvents(events: readonly RaceEvent[], karts: readonly KartState[], humanKarts: readonly number[]): void {
    if (events.length === 0) return;
    this.humanRef = humanKarts;
    this.finalLapKarts.clear();
    for (const e of events) {
      if (e.t === 'finalLap') this.finalLapKarts.add(e.kart);
      else if (e.t === 'countdown') this.countdown = e.n > 0;
    }
    const g = this.live();
    if (!g || this.suspendDepth > 0) return;
    const listeners = this.effectiveListeners(karts, humanKarts);
    for (const e of events) {
      const calls = planEvent(e, this.env);
      for (const c of calls) this.dispatch(g, c, karts, listeners);
    }
  }

  private dispatch(g: Graph, c: SoundCall, karts: readonly KartState[], listeners: readonly Listener[]): void {
    if (c.id === 'finalLap') g.seq.setFinalLap(true);
    if (c.id === 'finishFanfare') {
      g.seq.setDuck(0.3);
      this.duckRestoreAt = g.ctx.currentTime + 2.6;
    }
    let param = c.param;
    if (c.id === 'voiceHurt' || c.id === 'voiceJoy' || c.id === 'voiceWin' || c.id === 'voiceSad') {
      const k = karts[c.kart];
      if (!k) return;
      try { param = speciesIndex(getCharacter(k.charId).species); } catch { param = 0; }
    }
    let x = c.x, z = c.z;
    if (c.where === 'kart') {
      const k = karts[c.kart];
      if (!k) return;
      x = k.x; z = k.z;
    }
    this.play(c.id, c.where, c.kart, x, z, param, c.priority, c.delay, listeners);
  }

  /** Spatialise, rate-limit and render one sound through the event voice pool. */
  private play(id: SoundCall['id'], where: SoundCall['where'], kart: number, x: number, z: number, param: number, priority: number, delay: number, listeners: readonly Listener[] | null): void {
    const g = this.live();
    if (!g || g.ctx.state !== 'running') return;
    const now = g.ctx.currentTime;
    const key = (SFX_INDEX.get(id) ?? 0) * 256 + (kart + 1);
    const limit = RATE_LIMIT[id];
    if (limit !== undefined) {
      const last = this.lastPlay.get(key);
      if (last !== undefined && now - last < limit) return;
    }
    let gain = 1, pan = 0, prio = priority;
    if (where !== 'global') {
      spatialize(x, z, listeners ?? this.listeners, this.sp);
      gain = this.sp.gain;
      pan = this.sp.pan;
      if (gain < AUDIBLE_FLOOR) return;
      if (gain < 0.35) prio = Math.max(0, prio - 1);
    }
    const slot = g.events.acquire(now, prio, gain, pan, now + delay);
    if (!slot) return;
    this.lastPlay.set(key, now);
    const end = SOUNDS[id](g.kit, slot.strip, slot.start, param);
    g.events.commit(slot.strip, end);
  }

  private effectiveListeners(karts: readonly KartState[], humanKarts: readonly number[]): readonly Listener[] {
    if (this.listeners.length > 0) return this.listeners;
    // Before the first update(): listen from the human karts themselves.
    this.fallback.length = 0;
    for (const i of humanKarts) {
      const k = karts[i];
      if (k) this.fallback.push({ x: k.x, y: k.y, z: k.z, yaw: k.yaw });
    }
    return this.fallback;
  }

  // ───────────── continuous ─────────────

  update(karts: readonly KartState[], listeners: readonly Listener[], humanKarts: readonly number[], dtSeconds: number): void {
    // keep a private copy of the listeners (reusing objects) for event spatialisation
    const L = this.listeners;
    while (L.length > listeners.length) L.pop();
    for (let i = 0; i < listeners.length; i++) {
      const s = listeners[i]!;
      const d = L[i] ?? (L[i] = { x: 0, y: 0, z: 0, yaw: 0 });
      d.x = s.x; d.y = s.y; d.z = s.z; d.yaw = s.yaw;
    }
    const g = this.live();
    if (!g || this.suspendDepth > 0 || g.ctx.state !== 'running') return;
    let star = false;
    for (const i of humanKarts) if ((karts[i]?.starTime ?? 0) > 0) star = true;
    g.seq.setStar(star);
    if (this.duckRestoreAt > 0 && g.ctx.currentTime >= this.duckRestoreAt) {
      this.duckRestoreAt = 0;
      g.seq.setDuck(0.7);
    }
    g.cont.update(karts, L.length > 0 ? L : this.effectiveListeners(karts, humanKarts), humanKarts, dtSeconds, this.countdown, this.tickRoulette);
  }

  stopRace(): void {
    this.countdown = false;
    this.duckRestoreAt = 0;
    this.listeners.length = 0;
    this.lastPlay.clear();
    // a restarted (or next) race on the same track begins its theme from the intro again
    this.restartCue = true;
    const g = this.g;
    if (!g || this.failed) return;
    g.cont.stop();
    g.events.stopAll(g.ctx.currentTime);
    g.seq.setStar(false);
    g.seq.setDuck(1);
  }
}
