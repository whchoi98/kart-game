/**
 * Synthesized drum kit: sine-sweep kicks, noise+tone snares, high-passed noise hats,
 * clap bursts, pitched toms, congas, rim, shaker, cowbell and crash.
 */
import type { AudioResources } from './context.js';
import type { DrumId, KitPreset } from './pattern.js';
import { Voice, perc, sweep } from './synth.js';

interface KitTuning {
  kickFrom: number; kickTo: number; kickDecay: number; kickDrive: number;
  snareTone: number; snareDecay: number; snareBand: number;
  hatDecay: number; tomScale: number; level: number;
}

const KITS: Record<KitPreset, KitTuning> = {
  pop: { kickFrom: 150, kickTo: 48, kickDecay: 0.09, kickDrive: 0, snareTone: 190, snareDecay: 0.05, snareBand: 1800, hatDecay: 0.012, tomScale: 1, level: 1 },
  rock: { kickFrom: 160, kickTo: 46, kickDecay: 0.1, kickDrive: 1.5, snareTone: 180, snareDecay: 0.065, snareBand: 1500, hatDecay: 0.014, tomScale: 0.9, level: 1 },
  electro: { kickFrom: 130, kickTo: 42, kickDecay: 0.16, kickDrive: 0, snareTone: 220, snareDecay: 0.045, snareBand: 2600, hatDecay: 0.01, tomScale: 1.1, level: 1 },
  latin: { kickFrom: 120, kickTo: 50, kickDecay: 0.07, kickDrive: 0, snareTone: 240, snareDecay: 0.04, snareBand: 2200, hatDecay: 0.01, tomScale: 1.15, level: 0.95 },
  tribal: { kickFrom: 110, kickTo: 42, kickDecay: 0.12, kickDrive: 0.6, snareTone: 170, snareDecay: 0.06, snareBand: 1300, hatDecay: 0.012, tomScale: 0.85, level: 1 },
  heavy: { kickFrom: 190, kickTo: 44, kickDecay: 0.085, kickDrive: 3, snareTone: 175, snareDecay: 0.07, snareBand: 1400, hatDecay: 0.014, tomScale: 0.8, level: 1.05 },
};

function kick(v: Voice, out: GainNode, t: number, vel: number, k: KitTuning): number {
  const o = v.osc('sine', k.kickFrom);
  sweep(o.frequency, k.kickFrom, k.kickTo, t, 0.11);
  let src: AudioNode = o;
  if (k.kickDrive > 0) {
    const sh = v.shaper(k.kickDrive);
    o.connect(sh);
    src = sh;
  }
  src.connect(out);
  // beater click
  const n = v.noise('white');
  const hp = v.filter('highpass', 3000);
  const cg = v.gain(0);
  n.connect(hp); hp.connect(cg); cg.connect(out);
  perc(cg.gain, t, 0.22 * vel, 0.001, 0.004);
  return perc(out.gain, t, 0.95 * vel * k.level, 0.002, k.kickDecay);
}

function snare(v: Voice, out: GainNode, t: number, vel: number, k: KitTuning): number {
  const n = v.noise('white');
  const bp = v.filter('bandpass', k.snareBand, 0.7);
  const hp = v.filter('highpass', 900);
  const ng = v.gain(0);
  n.connect(hp); hp.connect(bp); bp.connect(ng); ng.connect(out);
  const tone = v.osc('triangle', k.snareTone);
  sweep(tone.frequency, k.snareTone * 1.3, k.snareTone, t, 0.03);
  const tg = v.gain(0);
  tone.connect(tg); tg.connect(out);
  perc(tg.gain, t, 0.5 * vel, 0.001, 0.03);
  out.gain.value = 1;
  return perc(ng.gain, t, 0.62 * vel * k.level, 0.001, k.snareDecay);
}

function hat(v: Voice, out: GainNode, t: number, vel: number, decay: number): number {
  const n = v.noise('white');
  const hp = v.filter('highpass', 7200, 0.9);
  const pk = v.filter('peaking', 10000, 1);
  pk.gain.value = 5;
  n.connect(hp); hp.connect(pk); pk.connect(out);
  return perc(out.gain, t, 0.26 * vel, 0.001, decay);
}

function clap(v: Voice, out: GainNode, t: number, vel: number): number {
  const n = v.noise('white');
  const bp = v.filter('bandpass', 1400, 1.1);
  n.connect(bp); bp.connect(out);
  const g = out.gain;
  const pk = 0.55 * vel;
  g.setValueAtTime(0, t);
  for (let i = 0; i < 3; i++) {
    const s = t + i * 0.011;
    g.setValueAtTime(pk, s);
    g.setTargetAtTime(0.05, s + 0.001, 0.003);
  }
  g.setValueAtTime(pk * 0.8, t + 0.034);
  g.setTargetAtTime(0, t + 0.035, 0.045);
  return t + 0.35;
}

function tom(v: Voice, out: GainNode, t: number, vel: number, f: number): number {
  const o = v.osc('sine', f);
  sweep(o.frequency, f * 1.35, f * 0.75, t, 0.22);
  const o2 = v.osc('triangle', f * 1.5);
  sweep(o2.frequency, f * 2, f * 1.1, t, 0.1);
  const g2 = v.gain(0);
  o.connect(out); o2.connect(g2); g2.connect(out);
  perc(g2.gain, t, 0.2, 0.001, 0.03);
  return perc(out.gain, t, 0.7 * vel, 0.002, 0.09);
}

function conga(v: Voice, out: GainNode, t: number, vel: number, f: number): number {
  const o = v.osc('sine', f);
  sweep(o.frequency, f * 1.18, f, t, 0.03);
  const n = v.noise('white');
  const bp = v.filter('bandpass', 2800, 1.5);
  const ng = v.gain(0);
  o.connect(out); n.connect(bp); bp.connect(ng); ng.connect(out);
  perc(ng.gain, t, 0.18 * vel, 0.001, 0.008);
  return perc(out.gain, t, 0.5 * vel, 0.002, 0.06);
}

function crash(v: Voice, out: GainNode, t: number, vel: number): number {
  const n = v.noise('white');
  const hp = v.filter('highpass', 4200, 0.6);
  const bp = v.filter('peaking', 7000, 0.8);
  bp.gain.value = 4;
  n.connect(hp); hp.connect(bp); bp.connect(out);
  return perc(out.gain, t, 0.3 * vel, 0.002, 0.38);
}

function rim(v: Voice, out: GainNode, t: number, vel: number): number {
  const o = v.osc('triangle', 1650);
  const n = v.noise('white');
  const hp = v.filter('highpass', 2500);
  const ng = v.gain(0.4);
  o.connect(out); n.connect(hp); hp.connect(ng); ng.connect(out);
  return perc(out.gain, t, 0.3 * vel, 0.001, 0.012);
}

function shaker(v: Voice, out: GainNode, t: number, vel: number): number {
  const n = v.noise('white');
  const hp = v.filter('highpass', 5200, 0.8);
  n.connect(hp); hp.connect(out);
  const g = out.gain;
  g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(0.13 * vel, t + 0.012);
  g.setTargetAtTime(0, t + 0.014, 0.022);
  return t + 0.2;
}

function cowbell(v: Voice, out: GainNode, t: number, vel: number): number {
  const a = v.osc(v.res.pulse(0.5), 562);
  const b = v.osc(v.res.pulse(0.5), 845);
  const bp = v.filter('bandpass', 900, 2.5);
  a.connect(bp); b.connect(bp); bp.connect(out);
  return perc(out.gain, t, 0.16 * vel, 0.001, 0.07);
}

/** Play one drum hit at time `t` into `dest`. */
export function playDrum(ctx: BaseAudioContext, res: AudioResources, dest: AudioNode, kit: KitPreset, drum: DrumId, t: number, vel: number): void {
  const k = KITS[kit] ?? KITS.pop;
  const v = new Voice(ctx, res);
  const out = v.gain(0);
  out.connect(dest);
  let end: number;
  switch (drum) {
    case 'kick': end = kick(v, out, t, vel, k); break;
    case 'snare': end = snare(v, out, t, vel, k); break;
    case 'hat': end = hat(v, out, t, vel, k.hatDecay); break;
    case 'open': end = hat(v, out, t, vel * 0.9, k.hatDecay * 9); break;
    case 'clap': end = clap(v, out, t, vel); break;
    case 'tomHi': end = tom(v, out, t, vel, 210 * k.tomScale); break;
    case 'tomMid': end = tom(v, out, t, vel, 150 * k.tomScale); break;
    case 'tomLo': end = tom(v, out, t, vel, 105 * k.tomScale); break;
    case 'crash': end = crash(v, out, t, vel); break;
    case 'rim': end = rim(v, out, t, vel); break;
    case 'shaker': end = shaker(v, out, t, vel); break;
    case 'congaHi': end = conga(v, out, t, vel, 330); break;
    case 'congaLo': end = conga(v, out, t, vel, 220); break;
    case 'cowbell': end = cowbell(v, out, t, vel); break;
    default: end = t + 0.1;
  }
  v.play(t, end);
}
