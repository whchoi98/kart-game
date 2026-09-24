/**
 * AudioContext discovery plus per-context shared resources (noise buffers, periodic
 * waves, shaper curves, reverb impulse). Everything expensive is computed once.
 */

export type AudioContextCtor = new (opts?: AudioContextOptions) => AudioContext;

/** The browser's AudioContext constructor, or null (Node, very old browsers, blocked). */
export function getAudioContextCtor(): AudioContextCtor | null {
  try {
    const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    return g.AudioContext ?? g.webkitAudioContext ?? null;
  } catch {
    return null;
  }
}

/** Ramp-safe positive floor for exponential ramps. */
export const EPS = 0.0001;

/** Clamp to a finite number (AudioParam setters throw on NaN/Infinity). */
export function fin(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

/** Smoothly move a param to `v` without clicks (cancels pending automation first). */
export function glideParam(p: AudioParam, v: number, now: number, timeConstant = 0.04): void {
  const target = fin(v);
  const anyP = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof anyP.cancelAndHoldAtTime === 'function') {
    anyP.cancelAndHoldAtTime(now);
  } else {
    p.cancelScheduledValues(now);
    p.setValueAtTime(fin(p.value, target), now);
  }
  p.setTargetAtTime(target, now, Math.max(0.001, timeConstant));
}

/** Per-frame param update: cheap setTargetAtTime without cancelling (for continuous voices). */
export function trackParam(p: AudioParam, v: number, now: number, timeConstant: number): void {
  p.setTargetAtTime(fin(v), now, Math.max(0.001, timeConstant));
}

function makeNoise(ctx: BaseAudioContext, seconds: number, kind: 'white' | 'pink' | 'brown'): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') d[i] = w;
    else if (kind === 'pink') {
      // Paul Kellet's refined pink filter
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  // Short crossfade at the loop point so looping sources never click.
  const fade = Math.min(256, len >> 2);
  for (let i = 0; i < fade; i++) {
    const a = i / fade;
    d[len - fade + i] = d[len - fade + i]! * (1 - a) + d[i]! * a;
  }
  return buf;
}

function makeIR(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const w = Math.random() * 2 - 1;
      lp += (w - lp) * (0.55 - 0.4 * t); // darker tail
      const early = i < ctx.sampleRate * 0.012 ? 0.3 : 1;
      d[i] = lp * Math.pow(1 - t, decay) * early;
    }
  }
  return buf;
}

/** Resources shared by music, SFX and engines. Created once per AudioContext. */
export class AudioResources {
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;
  readonly impulse: AudioBuffer;
  private waves = new Map<string, PeriodicWave>();
  private curves = new Map<number, Float32Array<ArrayBuffer>>();

  constructor(readonly ctx: BaseAudioContext) {
    this.white = makeNoise(ctx, 2, 'white');
    this.pink = makeNoise(ctx, 2, 'pink');
    this.brown = makeNoise(ctx, 2, 'brown');
    this.impulse = makeIR(ctx, 1.9, 2.6);
  }

  /** Band-limited pulse wave with the given duty cycle (0.5 = square). */
  pulse(duty: number): PeriodicWave {
    const key = `p${duty.toFixed(3)}`;
    let w = this.waves.get(key);
    if (!w) {
      const n = 48;
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let k = 1; k < n; k++) {
        real[k] = Math.sin(2 * Math.PI * k * duty) / (Math.PI * k);
        imag[k] = (1 - Math.cos(2 * Math.PI * k * duty)) / (Math.PI * k);
      }
      w = this.ctx.createPeriodicWave(real, imag);
      this.waves.set(key, w);
    }
    return w;
  }

  /** Additive wave from harmonic amplitudes (organs, choir-ish timbres). */
  additive(key: string, harmonics: readonly number[]): PeriodicWave {
    let w = this.waves.get(key);
    if (!w) {
      const real = new Float32Array(harmonics.length + 1);
      const imag = new Float32Array(harmonics.length + 1);
      harmonics.forEach((a, i) => { imag[i + 1] = a; });
      w = this.ctx.createPeriodicWave(real, imag);
      this.waves.set(key, w);
    }
    return w;
  }

  /** Soft-clipping curve; higher amount = more drive. */
  drive(amount: number): Float32Array<ArrayBuffer> {
    const key = Math.round(amount * 10);
    let c = this.curves.get(key);
    if (!c) {
      const n = 1024;
      c = new Float32Array(n);
      const k = Math.max(0.01, amount);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
      }
      this.curves.set(key, c);
    }
    return c;
  }
}
