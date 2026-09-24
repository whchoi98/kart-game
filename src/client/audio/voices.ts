/**
 * Tiny formant-filtered character chirps ("aww!", "yay!", "ya-hoo!") pitched by species.
 * Short and quiet by design — flavour, not dialogue.
 */
import type { Species } from '../../sim/types.js';
import type { Kit, Out } from './sfx-lib.js';
import { Voice, clampFreq } from './synth.js';

export const SPECIES_ORDER: readonly Species[] = ['penguin', 'bear', 'rabbit', 'dino', 'fox', 'raccoon', 'cat', 'robot'];

interface Profile {
  f: number;
  wave: OscillatorType | 'pulse';
  formants: readonly [number, number];
  /** Amplitude-modulation rate for growl/robot timbres (0 = none). */
  am: number;
  amDepth: number;
}

const PROFILES: Record<Species, Profile> = {
  penguin: { f: 620, wave: 'pulse', formants: [520, 1050], am: 0, amDepth: 0 },
  bear: { f: 190, wave: 'sawtooth', formants: [460, 860], am: 0, amDepth: 0 },
  rabbit: { f: 820, wave: 'triangle', formants: [380, 2300], am: 0, amDepth: 0 },
  dino: { f: 150, wave: 'sawtooth', formants: [700, 1100], am: 27, amDepth: 0.35 },
  fox: { f: 520, wave: 'sawtooth', formants: [720, 1250], am: 0, amDepth: 0 },
  raccoon: { f: 460, wave: 'square', formants: [480, 1900], am: 0, amDepth: 0 },
  cat: { f: 700, wave: 'sawtooth', formants: [420, 2100], am: 0, amDepth: 0 },
  robot: { f: 330, wave: 'square', formants: [650, 1500], am: 68, amDepth: 0.8 },
};

export type ChirpKind = 'hurt' | 'joy' | 'win' | 'sad';

/** Pitch contours as [time offset s, pitch multiplier] points plus total length. */
const CONTOURS: Record<ChirpKind, { pts: ReadonlyArray<readonly [number, number]>; len: number; syllables?: ReadonlyArray<readonly [number, number]> }> = {
  hurt: { pts: [[0, 1.3], [0.07, 1.25], [0.28, 0.72]], len: 0.3 },
  joy: { pts: [[0, 0.9], [0.1, 1.38], [0.22, 1.18]], len: 0.24 },
  win: { pts: [[0, 1], [0.12, 1.22], [0.2, 1.3], [0.34, 1.62], [0.5, 1.42]], len: 0.52, syllables: [[0, 0.14], [0.19, 0.52]] },
  sad: { pts: [[0, 1.02], [0.18, 0.95], [0.45, 0.76]], len: 0.46 },
};

export function speciesIndex(s: Species): number {
  return Math.max(0, SPECIES_ORDER.indexOf(s));
}

/** Render one chirp. `species` is an index into SPECIES_ORDER. Returns the end time. */
export function chirp(k: Kit, o: Out, t: number, kind: ChirpKind, species: number): number {
  const sp = SPECIES_ORDER[Math.max(0, Math.min(SPECIES_ORDER.length - 1, Math.round(species)))]!;
  const p = PROFILES[sp];
  const c = CONTOURS[kind];
  const v = new Voice(k.ctx, k.res);
  const src = p.wave === 'pulse' ? v.osc(v.res.pulse(0.3), p.f) : v.osc(p.wave, p.f);
  const fq = src.frequency;
  const [t0, m0] = c.pts[0]!;
  fq.setValueAtTime(clampFreq(p.f * m0), t + t0);
  for (let i = 1; i < c.pts.length; i++) {
    const [dt, m] = c.pts[i]!;
    fq.linearRampToValueAtTime(clampFreq(p.f * m), t + dt);
  }
  // light vibrato for liveliness
  const lfo = v.osc('sine', 9);
  const lg = v.gain(18);
  lfo.connect(lg);
  lg.connect(src.detune);

  const f1 = v.filter('bandpass', p.formants[0], 5);
  const f2 = v.filter('bandpass', p.formants[1], 7);
  const body = v.filter('lowpass', p.formants[1] * 1.4, 0.7);
  const g1 = v.gain(1);
  const g2 = v.gain(0.6);
  const gb = v.gain(0.12);
  const env = v.gain(0);
  src.connect(f1); src.connect(f2); src.connect(body);
  f1.connect(g1); f2.connect(g2); body.connect(gb);
  let tail: AudioNode = env;
  g1.connect(env); g2.connect(env); gb.connect(env);
  if (p.am > 0) {
    const ring = v.gain(1 - p.amDepth * 0.5);
    const am = v.osc(p.wave === 'square' ? 'square' : 'sine', p.am);
    const ag = v.gain(p.amDepth * 0.5);
    am.connect(ag);
    ag.connect(ring.gain);
    env.connect(ring);
    tail = ring;
  }
  tail.connect(o.node);

  const peak = sp === 'bear' || sp === 'dino' ? 0.5 : 0.36;
  const g = env.gain;
  g.setValueAtTime(0, t);
  const sylls = c.syllables ?? [[0, c.len]];
  for (const [s0, s1] of sylls) {
    g.setValueAtTime(0, t + s0);
    g.linearRampToValueAtTime(peak, t + s0 + 0.02);
    g.setValueAtTime(peak * 0.85, t + Math.max(s0 + 0.03, s1 - 0.05));
    g.linearRampToValueAtTime(0, t + s1);
  }
  const end = t + c.len + 0.05;
  v.play(t, end);
  o.add(v);
  return end;
}
