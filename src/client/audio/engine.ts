/**
 * Continuous race sounds: rich engines for human karts, cheap engines for the three nearest
 * CPU karts, drift screech with spark tint, boost roar, autopilot jet, off-road rumble, ice
 * hiss and the respawn propeller. Filters/gains are persistent per kart; noise/oscillator
 * sources start lazily and stop after a short silence, so idle layers cost nothing.
 */
import type { KartState } from '../../sim/types.js';
import { getCharacter } from '../../sim/characters.js';
import { PHYS } from '../../sim/constants.js';
import type { Listener } from '../contracts.js';
import type { AudioResources } from './context.js';
import { fin, trackParam } from './context.js';
import { engineBaseHz, engineTone, loopTargets, newLoopTargets, rouletteInterval, type EngineTone } from './engine-model.js';
import { newSpatial, spatialize } from './spatial.js';

/** A lazily started group of source nodes feeding a persistent chain. */
class Lazy {
  private nodes: AudioScheduledSourceNode[] = [];
  private quiet = 0;
  running = false;

  constructor(private readonly start: (now: number) => AudioScheduledSourceNode[]) {}

  update(level: number, dt: number, now: number): void {
    if (level > 0.002) {
      this.quiet = 0;
      if (!this.running) { this.nodes = this.start(now); this.running = true; }
    } else if (this.running) {
      this.quiet += dt;
      if (this.quiet > 0.8) this.halt(now);
    }
  }

  halt(now: number): void {
    for (const n of this.nodes) {
      n.onended = () => { try { n.disconnect(); } catch { /* ignore */ } };
      try { n.stop(now + 0.05); } catch { try { n.disconnect(); } catch { /* ignore */ } }
    }
    this.nodes = [];
    this.running = false;
    this.quiet = 0;
  }
}

function loopNoise(ctx: BaseAudioContext, buf: AudioBuffer, into: AudioNode, now: number): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  s.connect(into);
  s.start(now, Math.random() * Math.max(0, buf.duration - 0.5));
  return s;
}

function startOsc(ctx: BaseAudioContext, type: OscillatorType, f: number, into: AudioNode, now: number): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = f;
  o.connect(into);
  o.start(now);
  return o;
}

abstract class Rig {
  readonly out: GainNode;
  protected readonly panner: StereoPannerNode | null;
  protected readonly chain: AudioNode[] = [];
  protected readonly persistent: AudioScheduledSourceNode[] = [];
  protected readonly lazies: Lazy[] = [];
  protected readonly tone: EngineTone = { gear: 0, rpm: 0, freq: 40, cutoff: 400 };
  kart = -1;
  alive = true;

  constructor(protected readonly ctx: BaseAudioContext, protected readonly res: AudioResources, dest: AudioNode) {
    this.out = this.gain(0);
    const anyCtx = ctx as BaseAudioContext & { createStereoPanner?: () => StereoPannerNode };
    this.panner = typeof anyCtx.createStereoPanner === 'function' ? anyCtx.createStereoPanner() : null;
    if (this.panner) { this.chain.push(this.panner); this.out.connect(this.panner); this.panner.connect(dest); } else this.out.connect(dest);
  }

  protected gain(v: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    this.chain.push(g);
    return g;
  }

  protected filter(type: BiquadFilterType, f: number, q: number): BiquadFilterNode {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    this.chain.push(b);
    return b;
  }

  place(gain: number, pan: number, now: number): void {
    trackParam(this.out.gain, gain, now, 0.06);
    if (this.panner) trackParam(this.panner.pan, Math.max(-1, Math.min(1, pan)), now, 0.06);
  }

  /** Fade out, stop every source and free the graph. */
  stop(now: number): void {
    if (!this.alive) return;
    this.alive = false;
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(fin(g.value), now);
    g.linearRampToValueAtTime(0, now + 0.12);
    for (const l of this.lazies) l.halt(now + 0.12);
    const chain = this.chain;
    const srcs = this.persistent;
    let pending = srcs.length;
    const free = () => { for (const n of chain) { try { n.disconnect(); } catch { /* ignore */ } } };
    if (pending === 0) { free(); return; }
    for (const s of srcs) {
      s.onended = () => {
        try { s.disconnect(); } catch { /* ignore */ }
        if (--pending === 0) free();
      };
      try { s.stop(now + 0.16); } catch { if (--pending === 0) free(); }
    }
  }
}

/** Full-featured rig for a human kart. */
class HumanRig extends Rig {
  private readonly oscA: OscillatorNode;
  private readonly oscB: OscillatorNode;
  private readonly engLP: BiquadFilterNode;
  private readonly engAmp: GainNode;
  private readonly lfoDepth: GainNode;
  private readonly driftBP: BiquadFilterNode;
  private readonly driftGain: GainNode;
  private readonly sparkBP: BiquadFilterNode;
  private readonly sparkGain: GainNode;
  private readonly boostLP: BiquadFilterNode;
  private readonly boostGain: GainNode;
  private readonly jetGain: GainNode;
  private readonly roughLP: BiquadFilterNode;
  private readonly roughGain: GainNode;
  private readonly iceGain: GainNode;
  private readonly propGain: GainNode;
  private readonly drift: Lazy; private readonly boost: Lazy; private readonly jet: Lazy;
  private readonly rough: Lazy; private readonly ice: Lazy; private readonly prop: Lazy;
  private readonly targets = newLoopTargets();
  private baseHz = 40;
  private prevSpeed = 0;
  private load = 0;

  constructor(ctx: BaseAudioContext, res: AudioResources, dest: AudioNode, now: number) {
    super(ctx, res, dest);
    // engine: two detuned oscillators → soft clip → lowpass → amp (+ idle AM rumble)
    const mix = this.gain(0.5);
    const shaper = ctx.createWaveShaper();
    shaper.curve = res.drive(2.4);
    this.chain.push(shaper);
    this.engLP = this.filter('lowpass', 600, 2.2);
    this.engAmp = this.gain(0);
    this.oscA = startOsc(ctx, 'sawtooth', 40, mix, now);
    this.oscB = ctx.createOscillator();
    this.oscB.setPeriodicWave(res.pulse(0.5));
    this.oscB.frequency.value = 40;
    this.oscB.detune.value = 9;
    this.oscB.connect(mix);
    this.oscB.start(now);
    mix.connect(shaper); shaper.connect(this.engLP); this.engLP.connect(this.engAmp); this.engAmp.connect(this.out);
    this.lfoDepth = this.gain(0);
    const lfo = startOsc(ctx, 'sine', 11, this.lfoDepth, now);
    this.lfoDepth.connect(this.engAmp.gain);
    this.persistent.push(this.oscA, this.oscB, lfo);

    // drift screech + spark tint (share one noise source)
    this.driftBP = this.filter('bandpass', 1800, 5);
    this.driftGain = this.gain(0);
    this.sparkBP = this.filter('bandpass', 4200, 14);
    this.sparkGain = this.gain(0);
    this.driftBP.connect(this.driftGain); this.driftGain.connect(this.out);
    this.sparkBP.connect(this.sparkGain); this.sparkGain.connect(this.out);
    this.drift = new Lazy(t => {
      const n = loopNoise(ctx, res.white, this.driftBP, t);
      n.connect(this.sparkBP);
      return [n];
    });

    // boost roar
    this.boostLP = this.filter('lowpass', 1500, 1.2);
    this.boostGain = this.gain(0);
    this.boostLP.connect(this.boostGain); this.boostGain.connect(this.out);
    const sawG = this.gain(0.25);
    sawG.connect(this.boostLP);
    this.boost = new Lazy(t => [loopNoise(ctx, res.pink, this.boostLP, t), startOsc(ctx, 'sawtooth', 58, sawG, t)]);

    // autopilot jet
    const jetHP = this.filter('highpass', 900, 0.8);
    this.jetGain = this.gain(0);
    const jetSaw = this.filter('lowpass', 1300, 1);
    jetHP.connect(this.jetGain); jetSaw.connect(this.jetGain); this.jetGain.connect(this.out);
    this.jet = new Lazy(t => [loopNoise(ctx, res.white, jetHP, t), startOsc(ctx, 'sawtooth', 150, jetSaw, t)]);

    // off-road rumble
    this.roughLP = this.filter('lowpass', 420, 1.5);
    this.roughGain = this.gain(0);
    this.roughLP.connect(this.roughGain); this.roughGain.connect(this.out);
    this.rough = new Lazy(t => [loopNoise(ctx, res.brown, this.roughLP, t)]);

    // ice hiss
    const iceHP = this.filter('highpass', 4800, 0.7);
    this.iceGain = this.gain(0);
    iceHP.connect(this.iceGain); this.iceGain.connect(this.out);
    this.ice = new Lazy(t => [loopNoise(ctx, res.white, iceHP, t)]);

    // respawn propeller: buzzy saw, amplitude-chopped
    const propLP = this.filter('lowpass', 1000, 1);
    const chop = this.gain(0.5);
    this.propGain = this.gain(0);
    propLP.connect(chop); chop.connect(this.propGain); this.propGain.connect(this.out);
    const chopDepth = this.gain(0.5);
    chopDepth.connect(chop.gain);
    this.prop = new Lazy(t => [startOsc(ctx, 'sawtooth', 96, propLP, t), startOsc(ctx, 'square', 27, chopDepth, t)]);

    this.lazies.push(this.drift, this.boost, this.jet, this.rough, this.ice, this.prop);
  }

  bind(k: KartState): void {
    this.kart = k.index;
    try { this.baseHz = engineBaseHz(getCharacter(k.charId)); } catch { this.baseHz = 41; }
    this.prevSpeed = Math.abs(k.speed);
  }

  update(k: KartState, dt: number, now: number, countdown: boolean): void {
    const speed = Math.abs(k.speed);
    const ratio = k.maxSpeed > 0 ? speed / k.maxSpeed : 0;
    const accel = dt > 0 ? (speed - this.prevSpeed) / dt : 0;
    this.prevSpeed = speed;
    let loadT = Math.min(1, Math.max(0, accel / Math.max(1, k.accel)));
    if (k.throttle && !countdown) loadT = Math.max(loadT, 0.45);
    if (k.boostTime > 0 || k.autopilotTime > 0) loadT = 1;
    const revving = countdown && k.throttle;
    let r = ratio;
    if (revving) { r = 0.55 + 0.08 * Math.sin(now * 23); loadT = 1; }
    if (!k.grounded && k.respawnTime <= 0) r = Math.min(1.3, r + 0.18);
    if (k.spinTime > 0 || k.tumbleTime > 0) r *= 0.7;
    this.load += (loadT - this.load) * Math.min(1, dt * 6);
    const tone = engineTone(r, this.load, this.baseHz, this.tone);
    let freq = tone.freq;
    let amp = 0.15 * (0.55 + 0.45 * tone.rpm) * (0.72 + 0.28 * this.load);
    if (k.stallTime > 0) { freq *= 0.78; amp *= 0.2 + Math.random() * 0.8; }
    if (k.respawnTime > 0) amp *= 0.35;
    trackParam(this.oscA.frequency, freq, now, 0.05);
    trackParam(this.oscB.frequency, freq * 1.004, now, 0.05);
    trackParam(this.engLP.frequency, tone.cutoff, now, 0.06);
    trackParam(this.engAmp.gain, amp, now, 0.05);
    const idle = speed < 1.5 && !revving;
    trackParam(this.lfoDepth.gain, amp * (idle ? 0.45 : 0.08), now, 0.1);

    const L = loopTargets(k, this.targets);
    this.drift.update(L.drift, dt, now);
    trackParam(this.driftGain.gain, L.drift * 0.07, now, 0.04);
    trackParam(this.driftBP.frequency, 1500 + L.driftTint * 260 + ratio * 300, now, 0.08);
    trackParam(this.sparkGain.gain, L.drift > 0 && L.driftTint > 0 ? 0.035 + 0.02 * L.driftTint : 0, now, 0.05);
    trackParam(this.sparkBP.frequency, 3200 + L.driftTint * 900, now, 0.08);
    this.boost.update(L.boost, dt, now);
    trackParam(this.boostGain.gain, L.boost * 0.16, now, 0.08);
    trackParam(this.boostLP.frequency, 1200 + L.boost * 2000, now, 0.1);
    this.jet.update(L.jet, dt, now);
    trackParam(this.jetGain.gain, L.jet * 0.12, now, 0.12);
    this.rough.update(L.offroad, dt, now);
    trackParam(this.roughGain.gain, L.offroad * (L.mud ? 0.24 : 0.18), now, 0.06);
    trackParam(this.roughLP.frequency, L.mud ? 260 : 460, now, 0.1);
    this.ice.update(L.ice, dt, now);
    trackParam(this.iceGain.gain, L.ice * 0.05, now, 0.08);
    this.prop.update(L.propeller, dt, now);
    trackParam(this.propGain.gain, L.propeller * 0.06, now, 0.1);
  }
}

/** Cheap single-oscillator engine for a nearby CPU kart. */
class CpuRig extends Rig {
  private readonly osc: OscillatorNode;
  private readonly lp: BiquadFilterNode;
  private baseHz = 40;

  constructor(ctx: BaseAudioContext, res: AudioResources, dest: AudioNode, now: number) {
    super(ctx, res, dest);
    this.lp = this.filter('lowpass', 700, 1.6);
    const amp = this.gain(0.075);
    this.osc = startOsc(ctx, 'sawtooth', 40, this.lp, now);
    this.lp.connect(amp);
    amp.connect(this.out);
    this.persistent.push(this.osc);
  }

  bind(k: KartState): void {
    this.kart = k.index;
    try { this.baseHz = engineBaseHz(getCharacter(k.charId)); } catch { this.baseHz = 41; }
  }

  update(k: KartState, now: number): void {
    const ratio = k.maxSpeed > 0 ? Math.abs(k.speed) / k.maxSpeed : 0;
    const t = engineTone(ratio, k.boostTime > 0 ? 1 : 0.6, this.baseHz, this.tone);
    trackParam(this.osc.frequency, t.freq, now, 0.06);
    trackParam(this.lp.frequency, t.cutoff * 0.8, now, 0.08);
  }
}

export type RouletteTick = (kart: number, n: number) => void;

/** Owns every continuous voice for the current race. */
export class ContinuousAudio {
  private readonly humans = new Map<number, HumanRig>();
  private readonly cpus: CpuRig[] = [];
  private readonly sp = newSpatial();
  private readonly nearest: number[] = [-1, -1, -1];
  private readonly nearestD: number[] = [Infinity, Infinity, Infinity];
  private readonly roulette = new Map<number, { timer: number; n: number }>();

  constructor(private readonly ctx: BaseAudioContext, private readonly res: AudioResources, private readonly dest: AudioNode) {}

  update(karts: readonly KartState[], listeners: readonly Listener[], humanKarts: readonly number[], dt: number, countdown: boolean, tick: RouletteTick): void {
    const now = this.ctx.currentTime;
    const step = Math.min(0.1, Math.max(0, fin(dt)));
    // human rigs
    for (const [idx, rig] of this.humans) {
      if (!humanKarts.includes(idx) || !karts[idx]) { rig.stop(now); this.humans.delete(idx); }
    }
    for (const idx of humanKarts) {
      const k = karts[idx];
      if (!k) continue;
      let rig = this.humans.get(idx);
      if (!rig) { rig = new HumanRig(this.ctx, this.res, this.dest, now); rig.bind(k); this.humans.set(idx, rig); }
      spatialize(k.x, k.z, listeners, this.sp);
      rig.place(Math.max(0.55, this.sp.gain), this.sp.pan * 0.5, now);
      rig.update(k, step, now, countdown);
      this.updateRoulette(k, step, tick);
    }
    this.updateCpus(karts, listeners, humanKarts, now);
  }

  private updateRoulette(k: KartState, dt: number, tick: RouletteTick): void {
    let r = this.roulette.get(k.index);
    if (k.rouletteTime <= 0) { if (r) this.roulette.delete(k.index); return; }
    if (!r) { r = { timer: 0, n: 0 }; this.roulette.set(k.index, r); tick(k.index, r.n++); }
    r.timer += dt;
    const iv = rouletteInterval(k.rouletteTime, PHYS.rouletteTime);
    if (r.timer >= iv) { r.timer -= iv; tick(k.index, r.n++); }
  }

  private updateCpus(karts: readonly KartState[], listeners: readonly Listener[], humanKarts: readonly number[], now: number): void {
    const n = this.nearest, nd = this.nearestD;
    n.fill(-1); nd.fill(Infinity);
    if (listeners.length > 0) {
      for (const k of karts) {
        if (k.human >= 0 || humanKarts.includes(k.index)) continue;
        spatialize(k.x, k.z, listeners, this.sp);
        const d = this.sp.dist;
        if (this.sp.gain <= 0 || d >= nd[2]!) continue;
        let i = 2;
        while (i > 0 && d < nd[i - 1]!) { nd[i] = nd[i - 1]!; n[i] = n[i - 1]!; i--; }
        nd[i] = d; n[i] = k.index;
      }
    }
    while (this.cpus.length < 3) this.cpus.push(new CpuRig(this.ctx, this.res, this.dest, now));
    // keep rigs on karts that are still among the nearest, reassign the rest
    const free: CpuRig[] = [];
    for (const rig of this.cpus) if (!n.includes(rig.kart)) { rig.kart = -1; free.push(rig); }
    for (const idx of n) {
      if (idx < 0 || this.cpus.some(r => r.kart === idx)) continue;
      const rig = free.pop();
      if (rig) rig.bind(karts[idx]!);
    }
    for (const rig of this.cpus) {
      const k = rig.kart >= 0 ? karts[rig.kart] : undefined;
      if (!k) { rig.place(0, 0, now); continue; }
      spatialize(k.x, k.z, listeners, this.sp);
      rig.place(this.sp.gain, this.sp.pan, now);
      rig.update(k, now);
    }
  }

  /** Karts with an active voice (diagnostics/tests). */
  get activeKarts(): number[] {
    return [...this.humans.keys(), ...this.cpus.filter(r => r.kart >= 0).map(r => r.kart)];
  }

  stop(): void {
    const now = this.ctx.currentTime;
    for (const rig of this.humans.values()) rig.stop(now);
    for (const rig of this.cpus) rig.stop(now);
    this.humans.clear();
    this.cpus.length = 0;
    this.roulette.clear();
  }
}
