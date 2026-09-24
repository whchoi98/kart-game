/**
 * Melodic instrument presets for the music sequencer (all synthesized).
 * Each preset builds a small voice graph into `dest` and returns nothing; voices free
 * themselves when their sources end.
 */
import type { AudioResources } from './context.js';
import type { ArpPreset, BassPreset, LeadPreset, PadPreset } from './pattern.js';
import { Voice, adsr, perc, pitch, sweep, vibrato } from './synth.js';

export interface NoteSpec {
  /** Start time (AudioContext seconds). */
  t: number;
  /** Gate length in seconds. */
  dur: number;
  freq: number;
  vel: number;
  /** Frequency to glide from, 0 = none. */
  glide: number;
}

type Build = (v: Voice, out: GainNode, n: NoteSpec) => number;

function pulseLead(duty: number, level: number): Build {
  return (v, out, n) => {
    const o = v.osc(v.res.pulse(duty), n.freq);
    pitch(o.frequency, n.freq, n.t, n.glide, 0.06);
    vibrato(v, [o.detune], n.t, n.dur, 5.8, 16);
    o.connect(out);
    return adsr(out.gain, n.t, level * n.vel, 0.006, 0.12, 0.72, n.t + n.dur, 0.05);
  };
}

function fm(v: Voice, out: AudioNode, n: NoteSpec, ratio: number, index0: number, index1: number, indexTc: number): OscillatorNode {
  const car = v.osc('sine', n.freq);
  const mod = v.osc('sine', n.freq * ratio);
  const mg = v.gain(0);
  mod.connect(mg);
  mg.connect(car.frequency);
  mg.gain.setValueAtTime(n.freq * index0, n.t);
  mg.gain.setTargetAtTime(n.freq * index1, n.t, indexTc);
  pitch(car.frequency, n.freq, n.t, n.glide, 0.05);
  pitch(mod.frequency, n.freq * ratio, n.t, n.glide > 0 ? n.glide * ratio : 0, 0.05);
  car.connect(out);
  return car;
}

const steel = (level: number, ring: number): Build => (v, out, n) => {
  fm(v, out, n, 2, 2.4, 0.3, 0.07);
  return Math.max(n.t + n.dur, adsr(out.gain, n.t, level * n.vel, 0.003, ring, 0.22, n.t + n.dur, 0.18));
};

const bell = (level: number, decay: number): Build => (v, out, n) => {
  fm(v, out, n, 3.5, 3, 0.2, 0.22);
  const air = v.osc('sine', n.freq * 2.001);
  const ag = v.gain(0);
  air.connect(ag);
  ag.connect(out);
  perc(ag.gain, n.t, 0.25, 0.002, decay * 0.5);
  return perc(out.gain, n.t, level * n.vel, 0.002, decay);
};

const marimba = (level: number): Build => (v, out, n) => {
  const o = v.osc('sine', n.freq);
  const o4 = v.osc('sine', n.freq * 4.01);
  const g4 = v.gain(0);
  o.connect(out);
  o4.connect(g4);
  g4.connect(out);
  perc(g4.gain, n.t, 0.45, 0.001, 0.018);
  pitch(o.frequency, n.freq, n.t, n.glide, 0.04);
  return perc(out.gain, n.t, level * n.vel, 0.002, Math.min(0.2, 0.08 + n.dur * 0.25));
};

const LEADS: Record<LeadPreset, Build> = {
  pulse: pulseLead(0.25, 0.3),
  square: pulseLead(0.5, 0.26),
  thin: pulseLead(0.125, 0.3),
  steel: steel(0.36, 0.3),
  bell: bell(0.3, 0.42),
  marimba: marimba(0.5),
  twang: (v, out, n) => {
    const a = v.osc('sawtooth', n.freq, -6);
    const b = v.osc('sawtooth', n.freq, 6);
    const lp = v.filter('lowpass', 3800, 5);
    a.connect(lp); b.connect(lp); lp.connect(out);
    sweep(lp.frequency, 4400, 1150, n.t, 0.28);
    const bend = n.glide > 0 ? n.glide : n.freq * 0.965;
    pitch(a.frequency, n.freq, n.t, bend, 0.05);
    pitch(b.frequency, n.freq, n.t, bend, 0.05);
    vibrato(v, [a.detune, b.detune], n.t, n.dur, 6.2, 22, 0.2);
    return adsr(out.gain, n.t, 0.22 * n.vel, 0.003, 0.2, 0.45, n.t + n.dur, 0.1);
  },
  dist: (v, out, n) => {
    const a = v.osc('sawtooth', n.freq, -9);
    const b = v.osc('sawtooth', n.freq, 9);
    const sq = v.osc(v.res.pulse(0.5), n.freq / 2);
    const pre = v.gain(0.8);
    const sg = v.gain(0.3);
    const sh = v.shaper(7);
    const lp = v.filter('lowpass', 3100, 1.2);
    a.connect(pre); b.connect(pre); sq.connect(sg); sg.connect(pre);
    pre.connect(sh); sh.connect(lp); lp.connect(out);
    for (const o of [a, b]) pitch(o.frequency, n.freq, n.t, n.glide, 0.07);
    pitch(sq.frequency, n.freq / 2, n.t, n.glide > 0 ? n.glide / 2 : 0, 0.07);
    vibrato(v, [a.detune, b.detune], n.t, n.dur, 6, 20);
    return adsr(out.gain, n.t, 0.16 * n.vel, 0.006, 0.2, 0.85, n.t + n.dur, 0.07);
  },
  synth: (v, out, n) => {
    const a = v.osc('sawtooth', n.freq, -11);
    const b = v.osc('sawtooth', n.freq, 11);
    const sub = v.osc(v.res.pulse(0.5), n.freq / 2);
    const sg = v.gain(0.3);
    const lp = v.filter('lowpass', 3000, 2);
    a.connect(lp); b.connect(lp); sub.connect(sg); sg.connect(lp); lp.connect(out);
    sweep(lp.frequency, 3600, 1700, n.t, 0.3);
    for (const o of [a, b]) pitch(o.frequency, n.freq, n.t, n.glide, 0.09);
    pitch(sub.frequency, n.freq / 2, n.t, n.glide > 0 ? n.glide / 2 : 0, 0.09);
    vibrato(v, [a.detune, b.detune], n.t, n.dur, 5.2, 14);
    return adsr(out.gain, n.t, 0.2 * n.vel, 0.01, 0.2, 0.75, n.t + n.dur, 0.12);
  },
  brass: (v, out, n) => {
    const a = v.osc('sawtooth', n.freq);
    const b = v.osc('sawtooth', n.freq, 7);
    const lp = v.filter('lowpass', 500, 1.4);
    a.connect(lp); b.connect(lp); lp.connect(out);
    lp.frequency.setValueAtTime(450, n.t);
    lp.frequency.linearRampToValueAtTime(3000, n.t + 0.06);
    lp.frequency.setTargetAtTime(1800, n.t + 0.06, 0.15);
    for (const o of [a, b]) pitch(o.frequency, n.freq, n.t, n.glide, 0.06);
    vibrato(v, [a.detune, b.detune], n.t, n.dur, 5.4, 12, 0.24);
    return adsr(out.gain, n.t, 0.21 * n.vel, 0.028, 0.2, 0.8, n.t + n.dur, 0.09);
  },
  flute: (v, out, n) => {
    const o = v.osc('triangle', n.freq);
    const o2 = v.osc('sine', n.freq * 2);
    const g2 = v.gain(0.12);
    const br = v.noise('white');
    const bp = v.filter('bandpass', n.freq * 2, 1.4);
    const bg = v.gain(0);
    o.connect(out); o2.connect(g2); g2.connect(out);
    br.connect(bp); bp.connect(bg); bg.connect(out);
    bg.gain.setValueAtTime(0.18, n.t);
    bg.gain.setTargetAtTime(0.03, n.t, 0.04);
    pitch(o.frequency, n.freq, n.t, n.glide, 0.08);
    pitch(o2.frequency, n.freq * 2, n.t, n.glide > 0 ? n.glide * 2 : 0, 0.08);
    vibrato(v, [o.detune, o2.detune], n.t, n.dur, 5, 13, 0.2);
    return adsr(out.gain, n.t, 0.34 * n.vel, 0.035, 0.2, 0.85, n.t + n.dur, 0.08);
  },
};

const BASSES: Record<BassPreset, Build> = {
  tri: (v, out, n) => {
    const o = v.osc('triangle', n.freq);
    o.connect(out);
    return adsr(out.gain, n.t, 0.4 * n.vel, 0.004, 0.2, 0.85, n.t + n.dur, 0.04);
  },
  saw: (v, out, n) => {
    const o = v.osc('sawtooth', n.freq);
    const lp = v.filter('lowpass', 800, 3);
    o.connect(lp); lp.connect(out);
    sweep(lp.frequency, 1900, 650, n.t, 0.16);
    return adsr(out.gain, n.t, 0.3 * n.vel, 0.004, 0.2, 0.8, n.t + n.dur, 0.04);
  },
  funk: (v, out, n) => {
    const a = v.osc(v.res.pulse(0.5), n.freq);
    const b = v.osc('sawtooth', n.freq, 5);
    const lp = v.filter('lowpass', 3000, 9);
    a.connect(lp); b.connect(lp); lp.connect(out);
    sweep(lp.frequency, 3600, 360, n.t, 0.15);
    return adsr(out.gain, n.t, 0.24 * n.vel, 0.003, 0.14, 0.6, n.t + n.dur, 0.04);
  },
  sub: (v, out, n) => {
    const o = v.osc('sine', n.freq);
    const o2 = v.osc('triangle', n.freq * 2);
    const g2 = v.gain(0.22);
    o.connect(out); o2.connect(g2); g2.connect(out);
    return adsr(out.gain, n.t, 0.34 * n.vel, 0.006, 0.3, 0.9, n.t + n.dur, 0.05);
  },
  pluck: (v, out, n) => {
    const o = v.osc('triangle', n.freq);
    const s = v.osc('sawtooth', n.freq);
    const sg = v.gain(0.3);
    const lp = v.filter('lowpass', 2400, 2);
    o.connect(lp); s.connect(sg); sg.connect(lp); lp.connect(out);
    sweep(lp.frequency, 2600, 480, n.t, 0.2);
    return adsr(out.gain, n.t, 0.38 * n.vel, 0.003, 0.16, 0.4, n.t + n.dur, 0.06);
  },
  dist: (v, out, n) => {
    const o = v.osc('sawtooth', n.freq);
    const sh = v.shaper(4);
    const lp = v.filter('lowpass', 1400, 1.5);
    o.connect(sh); sh.connect(lp); lp.connect(out);
    return adsr(out.gain, n.t, 0.22 * n.vel, 0.004, 0.2, 0.8, n.t + n.dur, 0.05);
  },
};

const PADS: Record<PadPreset, Build> = {
  soft: (v, out, n) => {
    const a = v.osc('sawtooth', n.freq, -8);
    const b = v.osc('sawtooth', n.freq, 8);
    const lp = v.filter('lowpass', 1300, 0.8);
    a.connect(lp); b.connect(lp); lp.connect(out);
    return adsr(out.gain, n.t, 0.055 * n.vel, Math.min(0.12, n.dur * 0.3), 0.5, 0.85, n.t + n.dur, 0.28);
  },
  glass: (v, out, n) => {
    const a = v.osc('triangle', n.freq);
    const b = v.osc('sine', n.freq * 2);
    const bg = v.gain(0.3);
    a.connect(out); b.connect(bg); bg.connect(out);
    return adsr(out.gain, n.t, 0.075 * n.vel, 0.03, 0.4, 0.6, n.t + n.dur, 0.4);
  },
  organ: (v, out, n) => {
    const o = v.osc(v.res.additive('organ', [1, 0.7, 0.45, 0.2, 0.25, 0, 0.12, 0.1]), n.freq);
    o.connect(out);
    return adsr(out.gain, n.t, 0.07 * n.vel, 0.008, 0.1, 0.85, n.t + n.dur, 0.06);
  },
  strings: (v, out, n) => {
    const a = v.osc('sawtooth', n.freq, -10);
    const b = v.osc('sawtooth', n.freq, 10);
    const lp = v.filter('lowpass', 2200, 0.7);
    a.connect(lp); b.connect(lp); lp.connect(out);
    return adsr(out.gain, n.t, 0.05 * n.vel, Math.min(0.18, n.dur * 0.35), 0.5, 0.9, n.t + n.dur, 0.35);
  },
  choir: (v, out, n) => {
    const o = v.osc(v.res.additive('choir', [1, 0.55, 0.9, 0.7, 0.32, 0.2, 0.15, 0.1, 0.05]), n.freq);
    const lp = v.filter('lowpass', 1800, 1.5);
    o.connect(lp); lp.connect(out);
    return adsr(out.gain, n.t, 0.07 * n.vel, Math.min(0.2, n.dur * 0.35), 0.6, 0.9, n.t + n.dur, 0.4);
  },
};

const ARPS: Record<ArpPreset, Build> = {
  pluck: (v, out, n) => {
    const o = v.osc(v.res.pulse(0.25), n.freq);
    o.connect(out);
    return perc(out.gain, n.t, 0.15 * n.vel, 0.002, 0.06);
  },
  bell: bell(0.13, 0.16),
  sparkle: (v, out, n) => {
    const a = v.osc('sine', n.freq);
    const b = v.osc('sine', n.freq * 2.003);
    const bg = v.gain(0.4);
    a.connect(out); b.connect(bg); bg.connect(out);
    return perc(out.gain, n.t, 0.14 * n.vel, 0.002, 0.09);
  },
  saw: (v, out, n) => {
    const o = v.osc('sawtooth', n.freq);
    const lp = v.filter('lowpass', 4000, 3);
    o.connect(lp); lp.connect(out);
    sweep(lp.frequency, 4200, 900, n.t, 0.12);
    return perc(out.gain, n.t, 0.1 * n.vel, 0.002, 0.08);
  },
  marimba: marimba(0.26),
  steel: steel(0.16, 0.12),
};

export type MelodicKind = 'lead' | 'bass' | 'pad' | 'arp';

/** Play one melodic note into `dest`. */
export function playNote(
  ctx: BaseAudioContext, res: AudioResources, dest: AudioNode,
  kind: MelodicKind, preset: string, n: NoteSpec,
): void {
  const table: Record<string, Build> = kind === 'lead' ? LEADS : kind === 'bass' ? BASSES : kind === 'pad' ? PADS : ARPS;
  const build = table[preset] ?? (kind === 'lead' ? LEADS.pulse : kind === 'bass' ? BASSES.tri : kind === 'pad' ? PADS.soft : ARPS.pluck);
  const v = new Voice(ctx, res);
  const out = v.gain(0);
  out.connect(dest);
  const end = build(v, out, n);
  v.play(n.t, Math.max(end, n.t + 0.05));
}
