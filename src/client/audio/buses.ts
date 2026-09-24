/**
 * Mixer graph:
 *
 *   song players ─► songGate ─► musicDuck ─► music ─► musicHold ─┐
 *   star layer   ─────────────────────────► music                  │
 *   final-lap sting ──────────────────────► music                  ├─► master ─► compressor ─► limiter ─► out
 *   music FX (echo + reverb returns) ─► musicDuck    │
 *   ui / race one-shots / race loops ─► sfx ────────┘
 *
 * `songGate` mutes the song for the final-lap sting, `musicDuck` lowers it under the
 * star jingle and the finish fanfare. User volumes move smoothly (no zipper noise).
 */
import { AudioResources, glideParam } from './context.js';

/** Slider (0..1) → gain. Slightly exponential so the lower half of the slider stays usable. */
export function volumeToGain(v: number): number {
  const x = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  return x <= 0.001 ? 0 : Math.pow(x, 1.6);
}

/** Internal bus levels: SFX sit slightly above the music bed at default settings. */
const UI_LEVEL = 1.1;
const EVENTS_LEVEL = 1.7;
const LOOPS_LEVEL = 1.3;

export class Mixer {
  readonly master: GainNode;
  readonly music: GainNode;
  /** Pause gate after the music volume (pause menu / hidden tab). */
  readonly musicHold: GainNode;
  readonly musicDuck: GainNode;
  readonly songGate: GainNode;
  readonly starBus: GainNode;
  readonly stingBus: GainNode;
  readonly sfx: GainNode;
  readonly ui: GainNode;
  readonly events: GainNode;
  readonly loops: GainNode;
  /** Music send effects. */
  readonly echoSend: GainNode;
  readonly verbSend: GainNode;
  private readonly echo: DelayNode;
  private readonly compressor: DynamicsCompressorNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly nodes: AudioNode[] = [];

  constructor(readonly ctx: BaseAudioContext, readonly res: AudioResources, dest: AudioNode) {
    const g = (v: number): GainNode => {
      const n = ctx.createGain();
      n.gain.value = v;
      this.nodes.push(n);
      return n;
    };
    this.master = g(0);
    this.music = g(0);
    this.musicHold = g(1);
    this.musicDuck = g(1);
    this.songGate = g(1);
    this.starBus = g(0.9);
    this.stingBus = g(0.95);
    this.sfx = g(0);
    this.ui = g(UI_LEVEL);
    this.events = g(EVENTS_LEVEL);
    this.loops = g(LOOPS_LEVEL);
    this.echoSend = g(1);
    this.verbSend = g(1);

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 8;
    this.compressor.ratio.value = 3.5;
    this.compressor.attack.value = 0.006;
    this.compressor.release.value = 0.22;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.09;
    this.nodes.push(this.compressor, this.limiter);

    // music chain
    this.songGate.connect(this.musicDuck);
    this.musicDuck.connect(this.music);
    this.starBus.connect(this.music);
    this.stingBus.connect(this.music);
    this.music.connect(this.musicHold);
    this.musicHold.connect(this.master);

    // tempo-synced echo (dotted eighth), darkened feedback
    this.echo = ctx.createDelay(1.5);
    this.echo.delayTime.value = 0.375;
    const fb = g(0.32);
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2600;
    const echoRet = g(0.22);
    this.nodes.push(this.echo, tone);
    this.echoSend.connect(this.echo);
    this.echo.connect(tone);
    tone.connect(fb);
    fb.connect(this.echo);
    tone.connect(echoRet);
    echoRet.connect(this.musicDuck);

    // procedural room reverb
    const verb = ctx.createConvolver();
    verb.buffer = res.impulse;
    const verbRet = g(0.28);
    this.nodes.push(verb);
    this.verbSend.connect(verb);
    verb.connect(verbRet);
    verbRet.connect(this.musicDuck);

    // sfx chain
    this.ui.connect(this.sfx);
    this.events.connect(this.sfx);
    this.loops.connect(this.sfx);
    this.sfx.connect(this.master);

    this.master.connect(this.compressor);
    this.compressor.connect(this.limiter);
    this.limiter.connect(dest);
  }

  setVolumes(v: { master: number; music: number; sfx: number }): void {
    const now = this.ctx.currentTime;
    glideParam(this.master.gain, volumeToGain(v.master), now, 0.05);
    glideParam(this.music.gain, volumeToGain(v.music), now, 0.05);
    glideParam(this.sfx.gain, volumeToGain(v.sfx), now, 0.05);
  }

  /** Set the echo to a dotted eighth of the given tempo. */
  setTempo(bpm: number): void {
    const t = Math.min(1.2, Math.max(0.08, (60 / Math.max(40, bpm)) * 0.75));
    glideParam(this.echo.delayTime, t, this.ctx.currentTime, 0.2);
  }

  /** Pause gate: silences music and race sounds but keeps UI sounds alive. */
  hold(on: boolean): void {
    const now = this.ctx.currentTime;
    glideParam(this.musicHold.gain, on ? 0 : 1, now, 0.03);
    glideParam(this.events.gain, on ? 0 : EVENTS_LEVEL, now, 0.03);
    glideParam(this.loops.gain, on ? 0 : LOOPS_LEVEL, now, 0.03);
  }

  /** Duck (or restore) the song under a jingle; `level` 1 = no duck. */
  duck(level: number, timeConstant = 0.12): void {
    glideParam(this.musicDuck.gain, level, this.ctx.currentTime, timeConstant);
  }

  dispose(): void {
    for (const n of this.nodes) {
      try { n.disconnect(); } catch { /* already gone */ }
    }
  }
}
