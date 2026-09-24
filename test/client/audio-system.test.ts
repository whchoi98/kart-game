/**
 * AudioSystem behaviour in Node: silent fallback without WebAudio, and the full WebAudio
 * implementation driven against a strict mock AudioContext that throws where browsers
 * throw (non-finite params, exponential ramps to 0, double start, stop before start).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudioSystem, SilentAudioSystem } from '../../src/client/audio/index.js';
import type { WebAudioSystem } from '../../src/client/audio/system.js';
import type { KartState, RaceEvent } from '../../src/sim/types.js';
import { CHARACTER_IDS } from '../../src/sim/characters.js';
import { ITEM_IDS } from '../../src/sim/item-defs.js';

// ───────────────────────────── strict WebAudio mock ─────────────────────────────

function checkTime(t: number): void {
  if (!Number.isFinite(t)) throw new TypeError(`non-finite time ${t}`);
  if (t < 0) throw new RangeError(`negative time ${t}`);
}

class MockParam {
  private v: number;
  constructor(v: number) { this.v = v; }
  get value(): number { return this.v; }
  set value(x: number) { if (!Number.isFinite(x)) throw new TypeError(`non-finite value ${x}`); this.v = x; }
  private set(v: number, t: number): this { if (!Number.isFinite(v)) throw new TypeError(`non-finite value ${v}`); checkTime(t); this.v = v; return this; }
  setValueAtTime(v: number, t: number) { return this.set(v, t); }
  linearRampToValueAtTime(v: number, t: number) { return this.set(v, t); }
  exponentialRampToValueAtTime(v: number, t: number) { if (!(v > 0)) throw new RangeError(`exponential ramp to ${v}`); return this.set(v, t); }
  setTargetAtTime(v: number, t: number, tc: number) { if (!Number.isFinite(tc) || tc < 0) throw new RangeError(`bad time constant ${tc}`); return this.set(v, t); }
  cancelScheduledValues(t: number) { checkTime(t); return this; }
  cancelAndHoldAtTime(t: number) { checkTime(t); return this; }
}

class MockNode {
  readonly outputs = new Set<MockNode | MockParam>();
  constructor(readonly context: MockAudioContext) { context.created++; context.nodes.add(this); }
  connect<T extends MockNode | MockParam>(dest: T): T {
    if (!(dest instanceof MockNode) && !(dest instanceof MockParam)) throw new TypeError('connect to a non-node');
    if (dest instanceof MockNode && dest.context !== this.context) throw new Error('InvalidAccessError: cross-context');
    this.outputs.add(dest);
    return dest;
  }
  disconnect(): void { this.outputs.clear(); }
}

class MockSource extends MockNode {
  onended: (() => void) | null = null;
  started = false;
  ended = false;
  stopAt = Infinity;
  start(when = 0, offset = 0): void {
    if (this.started) throw new Error('InvalidStateError: start called twice');
    checkTime(when); checkTime(offset);
    this.started = true;
    this.context.live.add(this);
    const b = (this as unknown as { buffer?: MockBuffer | null; loop?: boolean });
    if (b.buffer && !b.loop) this.stopAt = Math.min(this.stopAt, when + b.buffer.duration);
  }
  stop(when = 0): void {
    if (!this.started) throw new Error('InvalidStateError: stop before start');
    checkTime(when);
    if (!this.ended) this.stopAt = when;
  }
}

class MockOsc extends MockSource {
  type = 'sine';
  frequency = new MockParam(440);
  detune = new MockParam(0);
  setPeriodicWave(_w: unknown): void { /* ok */ }
}
class MockBufferSource extends MockSource {
  buffer: MockBuffer | null = null;
  loop = false;
  playbackRate = new MockParam(1);
}
class MockGain extends MockNode { gain = new MockParam(1); }
class MockBiquad extends MockNode {
  type = 'lowpass';
  frequency = new MockParam(350); Q = new MockParam(1); gain = new MockParam(0); detune = new MockParam(0);
}
class MockPanner extends MockNode { pan = new MockParam(0); }
class MockShaper extends MockNode { curve: Float32Array | null = null; oversample = 'none'; }
class MockCompressor extends MockNode {
  threshold = new MockParam(-24); knee = new MockParam(30); ratio = new MockParam(12);
  attack = new MockParam(0.003); release = new MockParam(0.25);
}
class MockDelay extends MockNode { delayTime = new MockParam(0); }
class MockConvolver extends MockNode { buffer: MockBuffer | null = null; normalize = true; }

class MockBuffer {
  private readonly data: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    if (length <= 0) throw new Error('NotSupportedError: zero-length buffer');
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(i: number): Float32Array { return this.data[i]!; }
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  /**
   * Autoplay policy: while false, resume() behaves like Chrome without user activation — the
   * promise stays pending until a later resume() is allowed, which then settles every waiter.
   */
  static allowStart = true;
  currentTime = 0;
  readonly sampleRate = 8000;
  state: 'suspended' | 'running' | 'interrupted' | 'closed' = 'suspended';
  onstatechange: (() => void) | null = null;
  created = 0;
  resumeCalls = 0;
  private readonly waiting: Array<() => void> = [];
  readonly nodes = new Set<MockNode>();
  readonly live = new Set<MockSource>();
  readonly destination: MockNode;

  constructor() {
    MockAudioContext.instances.push(this);
    this.destination = new MockNode(this);
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    if (!MockAudioContext.allowStart) return new Promise<void>(res => { this.waiting.push(res); });
    if (this.state !== 'running') { this.state = 'running'; this.onstatechange?.(); }
    for (const res of this.waiting.splice(0)) res();
    return Promise.resolve();
  }
  suspend(): Promise<void> { this.state = 'suspended'; this.onstatechange?.(); return Promise.resolve(); }
  /** The OS takes the audio device away (iOS phone call, audio focus loss). */
  interrupt(): void { this.state = 'interrupted'; this.onstatechange?.(); }
  createGain() { return new MockGain(this); }
  createOscillator() { return new MockOsc(this); }
  createBufferSource() { return new MockBufferSource(this); }
  createBiquadFilter() { return new MockBiquad(this); }
  createStereoPanner() { return new MockPanner(this); }
  createWaveShaper() { return new MockShaper(this); }
  createDynamicsCompressor() { return new MockCompressor(this); }
  createDelay(_max?: number) { return new MockDelay(this); }
  createConvolver() { return new MockConvolver(this); }
  createBuffer(ch: number, len: number, sr: number) { return new MockBuffer(ch, len, sr); }
  createPeriodicWave(real: Float32Array, imag: Float32Array) {
    if (real.length !== imag.length || real.length < 2) throw new Error('IndexSizeError');
    return {};
  }

  /** Advance the clock and fire `ended` on sources whose stop time passed. */
  advance(dt: number): void {
    this.currentTime += dt;
    for (const s of this.live) {
      if (s.stopAt <= this.currentTime && !s.ended) {
        s.ended = true;
        this.live.delete(s);
        s.onended?.();
      }
    }
  }

  connectedNodes(): number {
    let n = 0;
    for (const node of this.nodes) if (node.outputs.size > 0) n++;
    return n;
  }
}

// ───────────────────────────── fixtures ─────────────────────────────

function kart(i: number, human: number): KartState {
  return {
    index: i, charId: CHARACTER_IDS[i % CHARACTER_IDS.length]!, human,
    x: i * 4, y: 0, z: i * 3, yaw: 0, vx: 0, vz: 0, vy: 0, speed: 0, grounded: true, airTime: 0,
    pitch: 0, roll: 0, driftAngle: 0, steerVisual: 0, ti: 0, s: 0, d: 0, progress: 0, lap: 1,
    lapStartTick: 0, lapTicks: [], finished: false, finishTick: -1, position: i + 1, wrongWay: false,
    lastSafe: { x: 0, y: 0, z: 0, yaw: 0, i: 0, progress: 0 }, surface: 'road',
    driftDir: 0, driftCharge: 0, driftLevel: 0, hopTime: 0, boostTime: 0, boostKind: null,
    trickReady: false, trickPending: false, trickTime: 0, spinTime: 0, tumbleTime: 0, shrinkTime: 0,
    starTime: 0, inkTime: 0, autopilotTime: 0, invulnTime: 0, respawnTime: 0, stallTime: 0,
    item: null, itemUses: 0, rouletteTime: 0, held: [], holding: false, coins: 0,
    prevDrift: false, prevItem: false, throttle: false, throttleStartTick: -1, maxSpeed: 29, accel: 14,
    turnRate: 2.2, mass: 1, speedScale: 1, hitTimer: 0,
  };
}

function everyEvent(): RaceEvent[] {
  const ev: RaceEvent[] = [
    { t: 'countdown', n: 3 }, { t: 'countdown', n: 2 }, { t: 'countdown', n: 1 }, { t: 'countdown', n: 0 },
    { t: 'lap', kart: 0, lap: 2, lapTicks: 3000 }, { t: 'finalLap', kart: 0 },
    { t: 'finish', kart: 0, position: 1, ticks: 9000 }, { t: 'finish', kart: 3, position: 2, ticks: 9100 },
    { t: 'itemBox', kart: 0, x: 0, y: 0, z: 0, box: 1 }, { t: 'itemGet', kart: 0, item: 'star' },
    { t: 'blocked', kart: 0, source: 'orb' }, { t: 'driftLevel', kart: 0, level: 1 }, { t: 'driftLevel', kart: 0, level: 3 },
    { t: 'driftStart', kart: 0, dir: -1 }, { t: 'driftEnd', kart: 0 }, { t: 'hop', kart: 0 }, { t: 'trick', kart: 0 },
    { t: 'land', kart: 0, hard: false }, { t: 'land', kart: 0, hard: true },
    { t: 'wall', kart: 0, impact: 14, x: 0, y: 0, z: 0 }, { t: 'kartBump', a: 0, b: 1, impact: 5, x: 0, y: 0, z: 0 },
    { t: 'coin', kart: 0, x: 0, y: 0, z: 0, coins: 9 }, { t: 'coinLoss', kart: 0, count: 3 },
    { t: 'explosion', x: 4, y: 0, z: 4, radius: 6, source: 'skybomb' },
    { t: 'projectileBounce', id: 1, x: 2, y: 0, z: 2 }, { t: 'projectileGone', id: 1, x: 2, y: 0, z: 2, kind: 'banana' },
    { t: 'thunder', by: 2 }, { t: 'ink', by: 2, targets: [0] }, { t: 'fall', kart: 0 }, { t: 'respawn', kart: 0 },
    { t: 'wrongWay', kart: 0, on: true }, { t: 'wrongWay', kart: 0, on: false },
    { t: 'position', kart: 0, from: 3, to: 2 }, { t: 'position', kart: 0, from: 2, to: 3 },
    { t: 'startBoost', kart: 0, good: true }, { t: 'startBoost', kart: 0, good: false }, { t: 'stall', kart: 1 },
    { t: 'raceDone' },
  ];
  for (const item of ITEM_IDS) ev.push({ t: 'itemUse', kart: 0, item });
  for (const kind of ['spin', 'tumble', 'squash', 'bump'] as const) ev.push({ t: 'hit', kart: 0, kind, by: 1, source: 'orb' });
  for (const kind of ['mini1', 'mini2', 'mini3', 'pad', 'nitro', 'trick', 'start', 'coin', 'ramp'] as const) ev.push({ t: 'boost', kart: 0, kind });
  return ev;
}

// ───────────────────────────── tests ─────────────────────────────

describe('createAudioSystem without WebAudio', () => {
  it('returns a silent implementation that never throws', async () => {
    expect((globalThis as { AudioContext?: unknown }).AudioContext).toBeUndefined();
    const a = createAudioSystem();
    expect(a).toBeInstanceOf(SilentAudioSystem);
    expect(a.unlocked).toBe(false);
    await expect(a.unlock()).resolves.toBeUndefined();
    expect(a.unlocked).toBe(true);
    const karts = [kart(0, 0), kart(1, -1)];
    expect(() => {
      a.setVolumes({ master: 1, music: 0.5, sfx: 0.2 });
      a.playMusic('sunny-meadow');
      a.setFinalLap(true);
      a.ui('select');
      a.handleEvents(everyEvent(), karts, [0]);
      a.update(karts, [{ x: 0, y: 0, z: 0, yaw: 0 }], [0], 1 / 60);
      a.suspend(); a.resume();
      a.stopRace();
      a.stopMusic();
    }).not.toThrow();
  });
});

describe('WebAudio implementation (strict mock)', () => {
  let ctx: () => MockAudioContext;

  beforeEach(() => {
    vi.useFakeTimers();
    MockAudioContext.instances = [];
    MockAudioContext.allowStart = true;
    (globalThis as { AudioContext?: unknown }).AudioContext = MockAudioContext;
    ctx = () => MockAudioContext.instances[0]!;
  });

  afterEach(() => {
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Advance audio clock and timers together in 25 ms slices. */
  function advance(seconds: number): void {
    const steps = Math.round(seconds / 0.025);
    for (let i = 0; i < steps; i++) {
      ctx().advance(0.025);
      vi.advanceTimersByTime(25);
    }
  }

  async function unlocked(): Promise<WebAudioSystem> {
    const a = createAudioSystem() as WebAudioSystem;
    await a.unlock();
    return a;
  }

  it('creates nothing before unlock and starts the pending cue afterwards', async () => {
    const a = createAudioSystem() as WebAudioSystem;
    expect(a).not.toBeInstanceOf(SilentAudioSystem);
    a.playMusic('frost-peak');
    a.ui('move');
    a.handleEvents([{ t: 'countdown', n: 3 }], [kart(0, 0)], [0]);
    expect(MockAudioContext.instances).toHaveLength(0);
    await a.unlock();
    expect(MockAudioContext.instances).toHaveLength(1);
    expect(ctx().state).toBe('running');
    expect(a.unlocked).toBe(true);
    expect(a.diagnostics().cue).toBe('frost-peak');
    advance(0.5);
    expect(ctx().live.size).toBeGreaterThan(0);
    // re-requesting the playing cue (as the app does after unlock) is a no-op
    a.playMusic('frost-peak');
    expect(a.diagnostics().players).toBe(1);
  });

  it('plays every cue, crossfades and falls back to the menu theme', async () => {
    const a = await unlocked();
    const cues = ['sunny-meadow', 'palm-beach', 'canyon-rally', 'neon-city', 'frost-peak', 'jungle-ruins',
      'lava-fortress', 'starlight-road', 'title', 'menu', 'results', 'podium', 'gameover'];
    for (const cue of cues) {
      a.playMusic(cue);
      expect(a.diagnostics().cue).toBe(cue);
      advance(0.3);
    }
    a.playMusic('title');
    advance(1.5);
    a.playMusic('menu');
    expect(a.diagnostics().players).toBe(2); // old cue still fading out
    advance(1);
    expect(a.diagnostics().players).toBe(1);
    a.playMusic('no-such-cue');
    expect(a.diagnostics().cue).toBe('menu');
  });

  it('lets the game-over sting end on its own', async () => {
    const a = await unlocked();
    a.playMusic('gameover');
    advance(10);
    expect(a.diagnostics().cue).toBeNull();
    expect(a.diagnostics().players).toBe(0);
  });

  it('speeds the song up on the final lap and restores it', async () => {
    const a = await unlocked();
    a.playMusic('lava-fortress');
    advance(1);
    a.setFinalLap(true);
    a.setFinalLap(true); // idempotent
    expect(a.diagnostics()).toMatchObject({ finalLap: true, tempo: 1.12 });
    advance(3);
    a.setFinalLap(false);
    expect(a.diagnostics()).toMatchObject({ finalLap: false, tempo: 1 });
    a.setFinalLap(true);
    a.playMusic('results');
    expect(a.diagnostics()).toMatchObject({ finalLap: false, tempo: 1, cue: 'results' });
  });

  it('handles every race event within the voice budget', async () => {
    const a = await unlocked();
    const karts = Array.from({ length: 8 }, (_, i) => kart(i, i === 0 ? 0 : -1));
    const events = everyEvent();
    expect(() => {
      for (let i = 0; i < 20; i++) {
        a.handleEvents(events, karts, [0]);
        advance(0.025);
      }
    }).not.toThrow();
    expect(a.diagnostics().eventVoices).toBeLessThanOrEqual(28);
    expect(a.diagnostics().finalLap).toBe(true); // finalLap event triggers the sting
  });

  it('skips distant CPU events', async () => {
    const a = await unlocked();
    const karts = [kart(0, 0), { ...kart(1, -1), x: 5000, z: 5000 }];
    a.update(karts, [{ x: 0, y: 1, z: -6, yaw: 0 }], [0], 1 / 60);
    advance(0.2);
    const before = ctx().created;
    a.handleEvents([{ t: 'itemUse', kart: 1, item: 'rocket' }, { t: 'hit', kart: 1, kind: 'tumble', by: 0, source: 'orb' }], karts, [0]);
    expect(ctx().created).toBe(before);
    a.handleEvents([{ t: 'itemUse', kart: 0, item: 'rocket' }], karts, [0]);
    expect(ctx().created).toBeGreaterThan(before);
  });

  it('runs engines for humans plus the three nearest CPUs, the star layer and cleans up', async () => {
    const a = await unlocked();
    advance(0.1);
    const baseline = ctx().connectedNodes();
    a.playMusic('sunny-meadow');
    const karts = Array.from({ length: 8 }, (_, i) => kart(i, i === 0 ? 0 : -1));
    const humans = [0];
    for (let f = 0; f < 240; f++) {
      const k0 = karts[0]!;
      k0.speed = Math.min(29, f * 0.25);
      k0.z += k0.speed / 60;
      k0.driftDir = f > 40 && f < 120 ? 1 : 0;
      k0.driftLevel = f > 80 ? 3 : f > 60 ? 1 : 0;
      k0.boostTime = f > 100 && f < 140 ? 0.6 : 0;
      k0.autopilotTime = f > 140 && f < 160 ? 1 : 0;
      k0.surface = f > 160 && f < 180 ? 'mud' : f > 180 && f < 200 ? 'ice' : 'road';
      k0.respawnTime = f > 200 && f < 220 ? 1 : 0;
      k0.rouletteTime = f < 100 ? 1.9 * (1 - f / 100) : 0;
      k0.starTime = f > 120 && f < 200 ? 2 : 0;
      k0.stallTime = f < 20 ? 0.5 : 0;
      for (let i = 1; i < 8; i++) { karts[i]!.speed = 20 + i; karts[i]!.z += karts[i]!.speed / 60; }
      a.update(karts, [{ x: k0.x, y: 2, z: k0.z - 6, yaw: 0 }], humans, 1 / 60);
      if (f === 130) expect(a.diagnostics().star).toBe(true);
      advance(0.025);
    }
    const d = a.diagnostics();
    expect(d.star).toBe(false);
    expect(d.engines).toContain(0);
    expect(d.engines.filter(k => k !== 0)).toHaveLength(3);
    // the three CPU voices follow the three nearest CPU karts
    expect(d.engines.filter(k => k !== 0).sort()).toEqual([1, 2, 3]);

    a.stopRace();
    a.stopMusic(0.2);
    expect(a.diagnostics().engines).toEqual([]);
    advance(5);
    expect(ctx().live.size).toBe(0);
    expect(ctx().connectedNodes()).toBe(baseline);
  });

  it('nests suspend/resume and stays quiet while suspended', async () => {
    const a = await unlocked();
    a.playMusic('menu');
    advance(0.5);
    a.suspend();
    a.suspend();
    expect(a.diagnostics().suspended).toBe(true);
    advance(0.5);
    const created = ctx().created;
    a.handleEvents([{ t: 'itemUse', kart: 0, item: 'banana' }], [kart(0, 0)], [0]);
    advance(1);
    expect(ctx().created).toBe(created); // no music scheduling or race sfx while paused
    a.ui('select'); // UI sounds still work in the pause menu
    expect(ctx().created).toBeGreaterThan(created);
    a.resume();
    expect(a.diagnostics().suspended).toBe(true);
    a.resume();
    expect(a.diagnostics().suspended).toBe(false);
    const c2 = ctx().created;
    advance(0.5);
    expect(ctx().created).toBeGreaterThan(c2); // music resumed
    a.resume(); // extra resume is harmless
    expect(a.diagnostics().suspended).toBe(false);
  });

  it('survives garbage kart data without throwing', async () => {
    const a = await unlocked();
    const bad = { ...kart(0, 0), x: Number.NaN, z: Number.POSITIVE_INFINITY, speed: Number.NaN, maxSpeed: 0 };
    expect(() => {
      a.update([bad], [{ x: Number.NaN, y: 0, z: 0, yaw: Number.NaN }], [0], Number.NaN);
      a.handleEvents(everyEvent(), [bad], [0]);
      a.update([bad], [], [0], 1 / 60);
      advance(1);
    }).not.toThrow();
  });

  it('applies volume changes smoothly at any time', async () => {
    const a = createAudioSystem() as WebAudioSystem;
    a.setVolumes({ master: 0.5, music: 0, sfx: 1 });
    await a.unlock();
    expect(() => {
      a.setVolumes({ master: 1, music: 1, sfx: 1 });
      a.setVolumes({ master: Number.NaN, music: -3, sfx: 7 });
    }).not.toThrow();
  });

  it('retries a resume() that the autoplay policy left pending and never hangs the caller', async () => {
    const a = createAudioSystem() as WebAudioSystem;
    a.playMusic('title');
    // e.g. the first touch pointerdown: not activation-triggering, resume() stays pending
    MockAudioContext.allowStart = false;
    let settled = false;
    const first = a.unlock().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    expect(settled).toBe(true);
    expect(a.unlocked).toBe(false);
    expect(ctx().state).toBe('suspended');
    // the following click has activation: unlock() must call resume() again
    MockAudioContext.allowStart = true;
    await a.unlock();
    expect(ctx().resumeCalls).toBe(2);
    expect(a.unlocked).toBe(true);
    expect(a.diagnostics().cue).toBe('title');
    expect(MockAudioContext.instances).toHaveLength(1);
  });

  it('waits for a real gesture when the page has no user activation yet', async () => {
    vi.stubGlobal('navigator', { userActivation: { isActive: false, hasBeenActive: false } });
    const a = createAudioSystem() as WebAudioSystem;
    a.playMusic('menu');
    await a.unlock();
    expect(MockAudioContext.instances).toHaveLength(0); // no context → no autoplay warning
    expect(a.unlocked).toBe(false);
    vi.stubGlobal('navigator', { userActivation: { isActive: true, hasBeenActive: true } });
    await a.unlock();
    expect(a.unlocked).toBe(true);
    expect(a.diagnostics().cue).toBe('menu');
  });

  it('recovers from an OS interruption and still obeys stopMusic meanwhile', async () => {
    const a = await unlocked();
    a.playMusic('neon-city');
    advance(0.5);
    ctx().interrupt();
    expect(a.unlocked).toBe(false); // the app's next gesture will call unlock() again
    a.stopMusic(0.2);
    expect(a.diagnostics().cue).toBeNull();
    await a.unlock();
    expect(a.unlocked).toBe(true);
    advance(1);
    expect(a.diagnostics().players).toBe(0); // the stopped song did not come back
  });

  it('drops the unlocked flag when resuming after a background stay is refused', async () => {
    const a = await unlocked();
    a.playMusic('menu');
    a.suspend();
    ctx().interrupt(); // backgrounded: the OS suspended the context while we were holding
    expect(a.unlocked).toBe(true);
    MockAudioContext.allowStart = false; // resume() without a gesture is refused
    a.resume();
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.unlocked).toBe(false);
    MockAudioContext.allowStart = true;
    await a.unlock();
    expect(a.unlocked).toBe(true);
    expect(ctx().state).toBe('running');
  });

  it('lets a crossfade ring out under a pause and frees it after resume without leaks', async () => {
    const a = await unlocked();
    advance(0.1);
    const baseline = ctx().connectedNodes();
    a.playMusic('title');
    advance(1);
    a.playMusic('menu'); // crossfade in progress…
    a.suspend(); // …when the pause menu opens
    expect(a.diagnostics().players).toBe(2); // the fading song is not cut mid-waveform
    advance(2);
    a.resume();
    advance(0.1);
    expect(a.diagnostics().players).toBe(1);
    a.stopMusic(0.1);
    advance(4);
    expect(a.diagnostics().players).toBe(0);
    expect(ctx().live.size).toBe(0);
    expect(ctx().connectedNodes()).toBe(baseline);
  });

  it('starts the track theme from the top when a race on the same track restarts', async () => {
    const a = await unlocked();
    a.playMusic('sunny-meadow');
    advance(3);
    a.setFinalLap(true);
    a.playMusic('sunny-meadow'); // mid-race repeat request: ignored
    expect(a.diagnostics()).toMatchObject({ players: 1, finalLap: true });
    a.stopRace();
    a.setFinalLap(false);
    a.playMusic('sunny-meadow'); // new race session on the same track
    expect(a.diagnostics()).toMatchObject({ cue: 'sunny-meadow', players: 2, finalLap: false, tempo: 1 });
    advance(1);
    expect(a.diagnostics().players).toBe(1);
    a.playMusic('sunny-meadow'); // the flag is consumed by one request
    expect(a.diagnostics().players).toBe(1);
  });
});
