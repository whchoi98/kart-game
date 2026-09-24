/**
 * Low-level voice building blocks. A `Voice` collects the nodes of one short-lived sound,
 * starts every source together and disconnects the whole sub-graph when it has finished,
 * so nothing leaks no matter how many notes the sequencer or the SFX system fires.
 */
import { AudioResources, EPS, fin } from './context.js';

export class Voice {
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly offsets: number[] = [];
  private done = false;

  constructor(readonly ctx: BaseAudioContext, readonly res: AudioResources) {}

  osc(type: OscillatorType | PeriodicWave, freq: number, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (typeof type === 'string') o.type = type as OscillatorType; else o.setPeriodicWave(type as PeriodicWave);
    o.frequency.value = fin(freq, 440);
    if (detune) o.detune.value = fin(detune);
    this.sources.push(o);
    this.offsets.push(-1);
    this.nodes.push(o);
    return o;
  }

  /** Looping noise source starting at a random point of the precomputed buffer. */
  noise(kind: 'white' | 'pink' | 'brown' = 'white', rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    const buf = kind === 'white' ? this.res.white : kind === 'pink' ? this.res.pink : this.res.brown;
    s.buffer = buf;
    s.loop = true;
    if (rate !== 1) s.playbackRate.value = fin(rate, 1);
    this.sources.push(s);
    this.offsets.push(Math.random() * Math.max(0, buf.duration - 0.6));
    this.nodes.push(s);
    return s;
  }

  gain(v = 0): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = fin(v);
    this.nodes.push(g);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.707): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = clampFreq(freq);
    f.Q.value = fin(q, 0.707);
    this.nodes.push(f);
    return f;
  }

  shaper(amount: number): WaveShaperNode {
    const w = this.ctx.createWaveShaper();
    w.curve = this.res.drive(amount);
    w.oversample = '2x';
    this.nodes.push(w);
    return w;
  }

  /** Start every source at `start`, stop at `stop`, then free the graph. */
  play(start: number, stop: number): void {
    if (this.sources.length === 0) return;
    const t0 = Math.max(0, fin(start));
    const t1 = Math.max(t0 + 0.01, fin(stop, t0 + 0.5));
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i]!;
      const off = this.offsets[i]!;
      if (off >= 0) (s as AudioBufferSourceNode).start(t0, off);
      else s.start(t0);
      s.stop(t1);
    }
    this.sources[0]!.onended = () => this.free();
  }

  /** Cut the voice short (voice stealing / stopRace). Safe to call at any time. */
  stopEarly(t: number): void {
    if (this.done) return;
    for (const s of this.sources) {
      try { s.stop(Math.max(0, fin(t))); } catch { /* not started or already stopped */ }
    }
  }

  get finished(): boolean { return this.done; }

  /** Disconnect everything (idempotent). */
  free(): void {
    if (this.done) return;
    this.done = true;
    for (const n of this.nodes) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
  }
}

export function clampFreq(f: number): number {
  return Math.min(20000, Math.max(10, fin(f, 1000)));
}

/**
 * Attack-decay-sustain-release on a gain param. Returns the time the voice is silent.
 * `end` is the note-off time.
 */
export function adsr(p: AudioParam, t: number, peak: number, a: number, d: number, sus: number, end: number, r: number): number {
  const pk = Math.max(0, fin(peak));
  const ta = t + Math.max(0.001, a);
  const off = Math.max(end, ta + 0.005);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(pk, ta);
  p.setTargetAtTime(pk * sus, ta, Math.max(0.005, d));
  p.setTargetAtTime(0, off, Math.max(0.005, r));
  return off + r * 5;
}

/** Percussive envelope: fast attack, exponential-ish decay (time constant `decay`). */
export function perc(p: AudioParam, t: number, peak: number, a: number, decay: number): number {
  const pk = Math.max(0, fin(peak));
  const ta = t + Math.max(0.001, a);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(pk, ta);
  p.setTargetAtTime(0, ta, Math.max(0.004, decay));
  return ta + decay * 6;
}

/** Exponential sweep between two positive values (frequencies, cutoffs). */
export function sweep(p: AudioParam, from: number, to: number, t: number, dur: number): void {
  p.setValueAtTime(Math.max(EPS, fin(from, 100)), t);
  p.exponentialRampToValueAtTime(Math.max(EPS, fin(to, 100)), t + Math.max(0.002, dur));
}

/** Set a frequency, optionally gliding from a previous pitch (portamento). */
export function pitch(p: AudioParam, freq: number, t: number, glideFrom = 0, glideTime = 0.07): void {
  if (glideFrom > 0) {
    p.setValueAtTime(clampFreq(glideFrom), t);
    p.exponentialRampToValueAtTime(clampFreq(freq), t + glideTime);
  } else {
    p.setValueAtTime(clampFreq(freq), t);
  }
}

/** Delayed vibrato into an oscillator's detune (cents). */
export function vibrato(v: Voice, targets: readonly AudioParam[], t: number, dur: number, rate = 5.6, depth = 14, delay = 0.16): void {
  if (dur < 0.3) return;
  const lfo = v.osc('sine', rate);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.setValueAtTime(0, t + delay);
  g.gain.linearRampToValueAtTime(depth, t + Math.min(dur, delay + 0.25));
  lfo.connect(g);
  for (const d of targets) g.connect(d);
}
