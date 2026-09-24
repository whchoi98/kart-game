/**
 * SFX infrastructure: a fixed pool of reusable output strips (gain → stereo panner) with
 * priority-based voice stealing, plus small synthesis primitives used by the sound library.
 */
import type { AudioResources } from './context.js';
import { EPS, fin } from './context.js';
import { Voice, clampFreq, perc } from './synth.js';

/** Where a sound renders into; tracks its voices so it can be cut short. */
export interface Out {
  readonly node: AudioNode;
  add(v: Voice): void;
}

export interface Kit {
  ctx: BaseAudioContext;
  res: AudioResources;
}

export class Strip implements Out {
  readonly input: GainNode;
  readonly panner: StereoPannerNode | null;
  readonly voices: Voice[] = [];
  busyUntil = 0;
  priority = 0;
  startedAt = 0;

  constructor(ctx: BaseAudioContext, dest: AudioNode) {
    this.input = ctx.createGain();
    this.input.gain.value = 0;
    const anyCtx = ctx as BaseAudioContext & { createStereoPanner?: () => StereoPannerNode };
    this.panner = typeof anyCtx.createStereoPanner === 'function' ? anyCtx.createStereoPanner() : null;
    if (this.panner) {
      this.input.connect(this.panner);
      this.panner.connect(dest);
    } else {
      this.input.connect(dest);
    }
  }

  get node(): AudioNode { return this.input; }

  add(v: Voice): void { this.voices.push(v); }

  /** Cut every voice at `t` (used when stealing or stopping the race). */
  cut(now: number, t: number): void {
    const g = this.input.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(fin(g.value), now);
    g.linearRampToValueAtTime(0, t);
    for (const v of this.voices) v.stopEarly(t);
    this.voices.length = 0;
  }

  dispose(): void {
    for (const v of this.voices) v.free();
    this.voices.length = 0;
    try { this.input.disconnect(); } catch { /* ignore */ }
    try { this.panner?.disconnect(); } catch { /* ignore */ }
  }
}

export class VoicePool {
  private readonly strips: Strip[] = [];

  constructor(private readonly ctx: BaseAudioContext, dest: AudioNode, size: number) {
    for (let i = 0; i < size; i++) this.strips.push(new Strip(ctx, dest));
  }

  get size(): number { return this.strips.length; }

  /** Strips currently producing sound. */
  busyCount(now: number): number {
    let n = 0;
    for (const s of this.strips) if (s.busyUntil > now) n++;
    return n;
  }

  /**
   * Reserve a strip for a sound of `priority`. Returns the strip and the time at which the
   * sound may start (slightly later when a voice had to be stolen), or null when every strip
   * is busy with more important sounds.
   */
  acquire(now: number, priority: number, gain: number, pan: number, when: number): { strip: Strip; start: number } | null {
    let pick: Strip | null = null;
    for (const s of this.strips) {
      if (s.busyUntil <= now) { pick = s; break; }
    }
    let start = Math.max(now, when);
    const g0 = pick?.input.gain;
    if (!pick) {
      let victim: Strip | null = null;
      for (const s of this.strips) {
        if (!victim || s.priority < victim.priority || (s.priority === victim.priority && s.startedAt < victim.startedAt)) victim = s;
      }
      if (!victim || victim.priority > priority) return null;
      // fade the stolen voice out (18 ms) before the new sound takes the strip
      victim.cut(now, now + 0.018);
      pick = victim;
      start = Math.max(start, now + 0.022);
    } else if (g0) {
      for (const v of pick.voices) v.free();
      pick.voices.length = 0;
      g0.cancelScheduledValues(now);
    }
    const g = pick.input.gain;
    g.setValueAtTime(Math.max(0, fin(gain)), start);
    if (pick.panner) {
      pick.panner.pan.cancelScheduledValues(now);
      pick.panner.pan.setValueAtTime(Math.max(-1, Math.min(1, fin(pan))), start);
    }
    pick.priority = priority;
    pick.startedAt = start;
    pick.busyUntil = start + 0.05;
    return { strip: pick, start };
  }

  /** Mark the strip busy until `end` (called after the sound has been built). */
  commit(strip: Strip, end: number): void {
    strip.busyUntil = Math.max(strip.busyUntil, fin(end, strip.busyUntil));
  }

  stopAll(now: number): void {
    for (const s of this.strips) {
      if (s.busyUntil > now) {
        s.cut(now, now + 0.03);
        s.busyUntil = now + 0.04; // not reusable until the fade has finished
      }
      s.priority = 0;
    }
  }

  dispose(): void {
    for (const s of this.strips) s.dispose();
    this.strips.length = 0;
  }
}

// ───────────────────────────── primitives ─────────────────────────────

export type Wave = OscillatorType | 'pulse25' | 'pulse12';

export interface ToneOpts {
  wave?: Wave;
  f0: number;
  /** Target frequency (exponential sweep). */
  f1?: number;
  /** Sweep time (defaults to dur). */
  sweep?: number;
  dur: number;
  peak: number;
  a?: number;
  /** Percussive decay time constant; when absent the tone holds for `dur`. */
  decay?: number;
  /** Vibrato [rate Hz, depth cents]. */
  vib?: readonly [number, number];
  /** Optional lowpass cutoff. */
  lp?: number;
  detune?: number;
}

function wave(v: Voice, w: Wave | undefined, f: number, detune = 0): OscillatorNode {
  if (w === 'pulse25') return v.osc(v.res.pulse(0.25), f, detune);
  if (w === 'pulse12') return v.osc(v.res.pulse(0.125), f, detune);
  return v.osc(w ?? 'sine', f, detune);
}

function envelope(p: AudioParam, t: number, o: { peak: number; a?: number; decay?: number; dur: number }): number {
  const a = o.a ?? 0.004;
  if (o.decay !== undefined) return perc(p, t, o.peak, a, o.decay);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(Math.max(0, fin(o.peak)), t + a);
  const off = Math.max(t + a + 0.005, t + o.dur);
  p.setTargetAtTime(0, off, 0.03);
  return off + 0.16;
}

/** One oscillator with optional sweep, vibrato and lowpass. Returns the end time. */
export function tone(k: Kit, out: Out, t: number, o: ToneOpts): number {
  const v = new Voice(k.ctx, k.res);
  const osc = wave(v, o.wave, o.f0, o.detune);
  if (o.f1 !== undefined) {
    osc.frequency.setValueAtTime(clampFreq(o.f0), t);
    osc.frequency.exponentialRampToValueAtTime(clampFreq(o.f1), t + Math.max(0.005, o.sweep ?? o.dur));
  }
  if (o.vib) {
    const lfo = v.osc('sine', o.vib[0]);
    const lg = v.gain(o.vib[1]);
    lfo.connect(lg);
    lg.connect(osc.detune);
  }
  const g = v.gain(0);
  if (o.lp) {
    const f = v.filter('lowpass', o.lp, 1);
    osc.connect(f);
    f.connect(g);
  } else {
    osc.connect(g);
  }
  g.connect(out.node);
  const end = envelope(g.gain, t, o);
  v.play(t, end);
  out.add(v);
  return end;
}

export interface NoiseOpts {
  color?: 'white' | 'pink' | 'brown';
  filter?: BiquadFilterType;
  f0: number;
  f1?: number;
  sweep?: number;
  q?: number;
  dur: number;
  peak: number;
  a?: number;
  decay?: number;
  rate?: number;
}

/** Filtered noise burst with optional cutoff sweep. Returns the end time. */
export function noise(k: Kit, out: Out, t: number, o: NoiseOpts): number {
  const v = new Voice(k.ctx, k.res);
  const src = v.noise(o.color ?? 'white', o.rate ?? 1);
  const f = v.filter(o.filter ?? 'bandpass', o.f0, o.q ?? 1);
  if (o.f1 !== undefined) {
    f.frequency.setValueAtTime(clampFreq(o.f0), t);
    f.frequency.exponentialRampToValueAtTime(clampFreq(o.f1), t + Math.max(0.005, o.sweep ?? o.dur));
  }
  const g = v.gain(0);
  src.connect(f);
  f.connect(g);
  g.connect(out.node);
  const end = envelope(g.gain, t, o);
  v.play(t, end);
  out.add(v);
  return end;
}

/** FM metallic hit (clangs, bells). `ratio` inharmonic for metal, integer for bells. */
export function fmHit(k: Kit, out: Out, t: number, f: number, ratio: number, index: number, decay: number, peak: number, indexDecay = decay * 0.5): number {
  const v = new Voice(k.ctx, k.res);
  const car = v.osc('sine', f);
  const mod = v.osc('sine', f * ratio);
  const mg = v.gain(0);
  mod.connect(mg);
  mg.connect(car.frequency);
  mg.gain.setValueAtTime(Math.max(EPS, f * index), t);
  mg.gain.setTargetAtTime(f * index * 0.08, t, Math.max(0.005, indexDecay));
  const g = v.gain(0);
  car.connect(g);
  g.connect(out.node);
  const end = perc(g.gain, t, peak, 0.002, decay);
  v.play(t, end);
  out.add(v);
  return end;
}

/** Simple bell (FM ratio 3.5). */
export function bell(k: Kit, out: Out, t: number, f: number, decay: number, peak: number): number {
  return fmHit(k, out, t, f, 3.5, 2.2, decay, peak, decay * 0.35);
}

/** Frequency of a MIDI note. */
export function hz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
