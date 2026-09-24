/**
 * Lookahead music scheduler (setInterval ~25 ms, notes scheduled ~120 ms ahead on the
 * AudioContext clock). Handles crossfades between cues, the final-lap sting + tempo lift
 * + intensity layer, and the Super Star jingle layer that ducks the track music.
 */
import type { AudioResources } from './context.js';
import { glideParam } from './context.js';
import type { Mixer } from './buses.js';
import { playDrum } from './drums.js';
import { playNote, type MelodicKind, type NoteSpec } from './instruments.js';
import { compileSong, type CompiledSong, type NoteEv, type PartKey, type SongDef } from './pattern.js';
import { resolveCue, STAR_SONG } from './songs/index.js';
import { midiToFreq, parsePitchClass } from './theory.js';

export const LOOKAHEAD = 0.12;
export const TICK_MS = 25;
export const CROSSFADE = 0.6;
export const FINAL_LAP_TEMPO = 1.12;
const STING_LENGTH = 1.55;

const PARTS: readonly PartKey[] = ['lead', 'counter', 'bass', 'pad', 'arp', 'drums', 'extra'];
const DEFAULT_MIX: Record<PartKey, number> = { lead: 1, counter: 0.62, bass: 0.95, pad: 0.85, arp: 0.7, drums: 0.9, extra: 0.5 };
const GATE: Record<PartKey, number> = { lead: 0.94, counter: 0.94, bass: 0.86, pad: 1, arp: 0.9, drums: 1, extra: 0.8 };
const ECHO: Partial<Record<PartKey, number>> = { lead: 0.3, arp: 0.2, extra: 0.22 };
const VERB: Partial<Record<PartKey, number>> = { lead: 0.14, counter: 0.3, pad: 0.4, arp: 0.25, drums: 0.06 };

function kindOf(p: PartKey): MelodicKind {
  return p === 'lead' || p === 'counter' ? 'lead' : p === 'bass' ? 'bass' : p === 'pad' ? 'pad' : 'arp';
}

/** One playing song instance with its own channel strip (so two can crossfade). */
export class SongPlayer {
  readonly out: GainNode;
  /** Post-send gains that follow the player's fades (so echo/reverb tails crossfade too). */
  private readonly fxTargets: AudioParam[] = [];
  private readonly parts = {} as Record<PartKey, GainNode>;
  private readonly nodes: AudioNode[] = [];
  private readonly spec: NoteSpec = { t: 0, dur: 0, freq: 440, vel: 1, glide: 0 };
  step = 0;
  nextTime: number;
  tempo = 1;
  intensity = false;
  /** Semitone offset applied to every melodic note (star layer follows the track's key). */
  transpose = 0;
  /** Time after which the player is silent and can be disposed. */
  endTime = Infinity;
  disposed = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly res: AudioResources,
    /** Mixer whose echo/reverb sends this player feeds (null = dry). */
    mixer: Mixer | null,
    readonly song: CompiledSong,
    dest: AudioNode,
    startTime: number,
    fadeIn: number,
  ) {
    this.nextTime = startTime;
    this.out = ctx.createGain();
    this.nodes.push(this.out);
    const mix = song.def.mix ?? {};
    for (const p of PARTS) {
      const g = ctx.createGain();
      g.gain.value = mix[p] ?? DEFAULT_MIX[p];
      g.connect(this.out);
      this.parts[p] = g;
      this.nodes.push(g);
      const e = ECHO[p], r = VERB[p];
      if (mixer && e) this.send(g, e, mixer.echoSend);
      if (mixer && r) this.send(g, r, mixer.verbSend);
    }
    this.out.connect(dest);
    for (const gain of [this.out.gain, ...this.fxTargets]) {
      gain.setValueAtTime(0, Math.max(0, startTime - 0.01));
      gain.linearRampToValueAtTime(1, startTime + Math.max(0.02, fadeIn));
    }
  }

  private send(from: GainNode, level: number, to: GainNode): void {
    const s = this.ctx.createGain();
    s.gain.value = level;
    const post = this.ctx.createGain();
    from.connect(s);
    s.connect(post);
    post.connect(to);
    this.fxTargets.push(post.gain);
    this.nodes.push(s, post);
  }

  get stepDur(): number {
    return 60 / (this.song.def.bpm * this.tempo) / 4;
  }

  /** Schedule every step whose time falls before `until`. */
  schedule(until: number, now: number): void {
    if (this.disposed || this.step < 0) return;
    if (this.nextTime < now - 0.25) this.nextTime = now + 0.02; // fell behind (throttled tab): resync
    const song = this.song;
    while (this.nextTime < until && this.step >= 0) {
      const sd = this.stepDur;
      const s = this.step;
      const swing = s % 2 === 1 ? (song.def.swing ?? 0) * sd : 0;
      const t = this.nextTime + swing;
      this.fire(song.events, song.index[s]!, song.index[s + 1]!, t, sd);
      if (this.intensity) this.fire(song.intensity, song.intensityIndex[s]!, song.intensityIndex[s + 1]!, t, sd);
      this.nextTime += sd;
      this.step++;
      if (this.step >= song.totalSteps) {
        if (song.def.loop && song.loopStart < song.totalSteps) this.step = song.loopStart;
        else { this.step = -1; this.endTime = Math.min(this.endTime, this.nextTime + 2.5); }
      }
    }
  }

  private fire(list: readonly NoteEv[], from: number, to: number, t: number, sd: number): void {
    const inst = this.song.def.instruments;
    for (let i = from; i < to; i++) {
      const ev = list[i]!;
      const dest = this.parts[ev.part];
      if (ev.drum) {
        playDrum(this.ctx, this.res, dest, inst.kit, ev.drum, t, ev.vel);
        continue;
      }
      const sp = this.spec;
      sp.t = t;
      sp.dur = ev.dur * sd * GATE[ev.part];
      sp.freq = midiToFreq(ev.midi + this.transpose);
      sp.vel = ev.vel;
      sp.glide = ev.glide >= 0 ? midiToFreq(ev.glide + this.transpose) : 0;
      const preset = ev.part === 'lead' ? inst.lead
        : ev.part === 'counter' ? (inst.counter ?? 'thin')
        : ev.part === 'bass' ? inst.bass
        : ev.part === 'pad' ? inst.pad : inst.arp;
      playNote(this.ctx, this.res, dest, kindOf(ev.part), preset, sp);
    }
  }

  /** Continue from the next bar line at `time` (after the final-lap sting). */
  resumeAtNextBar(time: number): void {
    if (this.step < 0) return;
    let next = Math.ceil(this.step / 16) * 16;
    if (next >= this.song.totalSteps) next = this.song.def.loop ? this.song.loopStart : this.song.totalSteps - 1;
    this.step = next;
    this.nextTime = time;
  }

  fadeOut(now: number, dur: number): void {
    for (const p of [this.out.gain, ...this.fxTargets]) {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(0, now + Math.max(0.02, dur));
    }
    this.endTime = Math.min(this.endTime, now + dur + 0.1);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const n of this.nodes) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
  }
}

/** Major key sharing the song's scale: the star jingle is transposed there so it never clashes. */
const PARENT_MAJOR: Record<SongDef['mode'], number> = {
  major: 0, minor: 3, harmonicMinor: 3, dorian: -2, mixolydian: 5, lydian: 7, phrygian: -4,
};

export function starTranspose(track: SongDef): number {
  const target = ((parsePitchClass(track.tonic) ?? 0) + PARENT_MAJOR[track.mode] + 24) % 12;
  const from = parsePitchClass(STAR_SONG.tonic) ?? 0;
  let d = (target - from + 12) % 12;
  if (d > 6) d -= 12;
  return d;
}

/** Owns every song player and the scheduler timer. */
export class Sequencer {
  private current: SongPlayer | null = null;
  private currentId: string | null = null;
  private readonly retiring: SongPlayer[] = [];
  private star: SongPlayer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private finalLap = false;
  private paused = false;
  private starOn = false;
  private baseDuck = 1;
  private stingUntil = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly res: AudioResources,
    private readonly mixer: Mixer,
  ) {}

  get cue(): string | null { return this.currentId; }
  get isFinalLap(): boolean { return this.finalLap; }
  get starActive(): boolean { return this.starOn; }
  get tempoFactor(): number { return this.current?.tempo ?? 1; }
  /** Players still producing sound (current + fading out + star layer). */
  get playerCount(): number { return this.active().length + this.retiring.length; }
  get isPaused(): boolean { return this.paused; }

  /**
   * Start (or crossfade to) a cue. Re-requesting the playing cue is a no-op unless `restart`
   * is set (a new race on the same track), which crossfades into a fresh copy from the intro.
   */
  play(cue: string, restart = false): void {
    const def = resolveCue(cue);
    if (!restart && this.currentId === def.id && this.current && !this.current.disposed && this.current.step >= 0) return;
    const now = this.ctx.currentTime;
    const hadMusic = !!this.current;
    if (this.current) this.retire(this.current, now, CROSSFADE);
    this.finalLap = false;
    this.stingUntil = 0;
    glideParam(this.mixer.songGate.gain, 1, now, 0.03);
    this.setStar(false);
    this.baseDuck = 1;
    this.applyDuck(0.2);
    const song = compileSong(def);
    this.current = new SongPlayer(this.ctx, this.res, this.mixer, song, this.mixer.songGate, now + 0.06, hadMusic ? CROSSFADE : 0.04);
    this.currentId = def.id;
    this.mixer.setTempo(def.bpm);
    this.ensureTimer();
  }

  stop(fade = 0.8): void {
    const now = this.ctx.currentTime;
    if (this.current) this.retire(this.current, now, Math.max(0.02, fade));
    this.current = null;
    this.currentId = null;
    this.finalLap = false;
    this.setStar(false);
  }

  /** Final lap: short rising sting, then the same song at ×1.12 with the intensity layer. */
  setFinalLap(on: boolean): void {
    if (on === this.finalLap) return;
    this.finalLap = on;
    const p = this.current;
    if (!p) return;
    if (!on) {
      p.tempo = 1;
      p.intensity = false;
      this.mixer.setTempo(p.song.def.bpm);
      return;
    }
    const now = this.ctx.currentTime;
    const t0 = now + 0.03;
    const resumeAt = t0 + STING_LENGTH;
    const gate = this.mixer.songGate.gain;
    glideParam(gate, 0, now, 0.03);
    gate.setTargetAtTime(1, resumeAt - 0.02, 0.02);
    this.stingUntil = resumeAt;
    p.tempo = FINAL_LAP_TEMPO;
    p.intensity = true;
    p.resumeAtNextBar(resumeAt);
    this.mixer.setTempo(p.song.def.bpm * FINAL_LAP_TEMPO);
    this.playSting(p.song.def, t0);
  }

  private playSting(def: SongDef, t0: number): void {
    const tonic = parsePitchClass(def.tonic) ?? 0;
    const minor = def.mode === 'minor' || def.mode === 'dorian' || def.mode === 'harmonicMinor' || def.mode === 'phrygian';
    const third = minor ? 3 : 4;
    let root = 72 + tonic;
    if (root > 77) root -= 12;
    const bus = this.mixer.stingBus;
    const spec: NoteSpec = { t: 0, dur: 0, freq: 0, vel: 1, glide: 0 };
    const note = (kind: MelodicKind, preset: string, midi: number, t: number, dur: number, vel: number) => {
      spec.t = t; spec.dur = dur; spec.freq = midiToFreq(midi); spec.vel = vel; spec.glide = 0;
      playNote(this.ctx, this.res, bus, kind, preset, spec);
    };
    // rising 5-1-3-5 pickup into a held octave with a full chord hit
    const run = [root - 5, root, root + third, root + 7];
    const step = 0.1;
    run.forEach((m, i) => {
      note('lead', 'brass', m, t0 + i * step, step * 0.9, 0.85 + i * 0.05);
      note('lead', 'square', m - 12, t0 + i * step, step * 0.9, 0.5);
    });
    const hit = t0 + run.length * step + 0.03;
    note('lead', 'brass', root + 12, hit, 0.85, 1);
    note('lead', 'pulse', root + 12 + third, hit, 0.85, 0.7);
    for (const m of [root, root + third, root + 7]) note('pad', 'strings', m, hit, 0.9, 1);
    note('bass', 'saw', root - 24, hit, 0.8, 1);
    for (let i = 0; i < 8; i++) playDrum(this.ctx, this.res, bus, 'rock', 'snare', t0 + i * 0.06, 0.35 + i * 0.07);
    playDrum(this.ctx, this.res, bus, 'rock', 'kick', hit, 1);
    playDrum(this.ctx, this.res, bus, 'rock', 'crash', hit, 1);
  }

  /** Super Star layer: jingle on its own bus while the track music ducks underneath. */
  setStar(on: boolean): void {
    if (on === this.starOn) return;
    this.starOn = on;
    const now = this.ctx.currentTime;
    if (on) {
      if (this.star) this.retire(this.star, now, 0.05);
      this.star = new SongPlayer(this.ctx, this.res, null, compileSong(STAR_SONG), this.mixer.starBus, now + 0.04, 0.12);
      this.star.transpose = this.current ? starTranspose(this.current.song.def) : 0;
      this.ensureTimer();
    } else if (this.star) {
      this.retire(this.star, now, 0.45);
      this.star = null;
    }
    this.applyDuck(on ? 0.08 : 0.35);
  }

  /** Extra duck requested by the race (e.g. under the finish fanfare). 1 = none. */
  setDuck(level: number): void {
    this.baseDuck = Math.min(1, Math.max(0, level));
    this.applyDuck(0.25);
  }

  private applyDuck(tc: number): void {
    const level = Math.min(this.baseDuck, this.starOn ? 0.2 : 1);
    this.mixer.duck(level, tc);
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.stopTimer();
    const now = this.ctx.currentTime;
    // Players still fading out keep their (absolute) fade and end times: their already-scheduled
    // notes ring out under the pause fade instead of being cut mid-waveform, and tick() frees them.
    // remember where we were relative to the clock so resume() continues seamlessly
    for (const p of this.active()) {
      p.nextTime = Math.max(0, p.nextTime - now);
      if (Number.isFinite(p.endTime)) p.endTime = Math.max(0, p.endTime - now);
    }
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const now = this.ctx.currentTime;
    for (const p of this.active()) {
      const offset = Math.min(LOOKAHEAD, p.nextTime);
      if (Number.isFinite(p.endTime)) p.endTime = now + 0.05 + offset + Math.max(0, p.endTime - p.nextTime);
      p.nextTime = now + 0.05 + offset;
    }
    if (this.stingUntil > 0 && this.current) {
      // a sting interrupted by the pause simply resumes the song
      this.stingUntil = 0;
      glideParam(this.mixer.songGate.gain, 1, now, 0.03);
    }
    this.ensureTimer();
  }

  private active(): SongPlayer[] {
    const out: SongPlayer[] = [];
    if (this.current) out.push(this.current);
    if (this.star) out.push(this.star);
    return out;
  }

  private retire(p: SongPlayer, now: number, fade: number): void {
    p.fadeOut(now, fade);
    this.retiring.push(p);
  }

  private ensureTimer(): void {
    if (this.timer !== null || this.paused) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Scheduler heartbeat. Public for tests / offline rendering. */
  tick(until?: number): void {
    const now = this.ctx.currentTime;
    const horizon = until ?? now + LOOKAHEAD;
    if (this.stingUntil > 0 && now >= this.stingUntil) this.stingUntil = 0;
    // free finished fade-outs first so no notes are scheduled into a player about to be disposed
    for (let i = this.retiring.length - 1; i >= 0; i--) {
      const p = this.retiring[i]!;
      if (now >= p.endTime) { p.dispose(); this.retiring.splice(i, 1); }
    }
    this.current?.schedule(horizon, now);
    this.star?.schedule(horizon, now);
    for (const p of this.retiring) p.schedule(horizon, now);
    if (this.current && now >= this.current.endTime) {
      this.current.dispose();
      this.current = null;
      this.currentId = null;
    }
    if (!this.current && !this.star && this.retiring.length === 0) this.stopTimer();
  }

  dispose(): void {
    this.stopTimer();
    for (const p of [...this.active(), ...this.retiring]) p.dispose();
    this.retiring.length = 0;
    this.current = null;
    this.star = null;
    this.currentId = null;
  }
}
