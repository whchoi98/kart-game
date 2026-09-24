/**
 * Compact song DSL and its compiler.
 *
 * A song is a set of sections (bars of 16 sixteenth-steps, 4/4) played as
 * `intro` once and then `body` in a loop. Each section holds:
 *
 *  chords   'C | G | Am F'          one bar per '|', several chords split a bar evenly,
 *                                    '%' repeats the previous chord.
 *  lead     'e5:2 g5 ~c6:4! r:2 - | …'  melody tokens: pitch[:dur16][!]. dur defaults to the
 *                                    previous token's value; 'r' rest, '-' tie (extends previous
 *                                    note), '~' glides (portamento) from the previous pitch,
 *                                    '!' accent. Every bar must add up to 16 steps.
 *  counter  second melody, same syntax.
 *  bass     '1.1.5.8-..1.5.3.'      16 chars per bar (repeated). Digits are chord degrees
 *                                    (1 root, 3 third, 5 fifth, 7 seventh/octave, 8 octave,
 *                                    0 fifth below), '-' holds, '.' rests.
 *  arp      '0123 2101 …'           chord-tone indices from the arp floor ('-' hold, '.' rest).
 *  pad      'hold' | 'stab8' | 'stab4' | 'pulse'
 *  drums    lanes of 16·n chars: x hit, X accent, o ghost, '.' rest; toms use h/m/l,
 *           congas h/l. Lanes: k kick, s snare, h hat, o open hat, c clap, t toms,
 *           x crash, r rim, z shaker, g conga, b cowbell.
 *  fill     drum lanes that replace the pattern on the section's last bar.
 *
 * Lines whose bar count divides the section length repeat to fill it.
 */
import {
  arpTones, bassRoot, parseChord, parseNote, parsePitchClass, pcOf, scalePitchClasses, voiceLead,
  type Chord, type ScaleMode,
} from './theory.js';

export type LeadPreset = 'pulse' | 'square' | 'thin' | 'steel' | 'twang' | 'bell' | 'marimba' | 'dist' | 'synth' | 'brass' | 'flute';
export type BassPreset = 'tri' | 'saw' | 'funk' | 'sub' | 'pluck' | 'dist';
export type PadPreset = 'soft' | 'glass' | 'organ' | 'strings' | 'choir';
export type ArpPreset = 'pluck' | 'bell' | 'sparkle' | 'saw' | 'marimba' | 'steel';
export type KitPreset = 'pop' | 'rock' | 'electro' | 'latin' | 'tribal' | 'heavy';
export type PadMode = 'hold' | 'stab8' | 'stab4' | 'pulse';

export type DrumId =
  | 'kick' | 'snare' | 'hat' | 'open' | 'clap' | 'tomHi' | 'tomMid' | 'tomLo'
  | 'crash' | 'rim' | 'shaker' | 'congaHi' | 'congaLo' | 'cowbell';

export interface DrumPattern {
  k?: string; s?: string; h?: string; o?: string; c?: string; t?: string;
  x?: string; r?: string; z?: string; g?: string; b?: string;
}

export interface SectionDef {
  bars: number;
  chords: string;
  lead?: string;
  counter?: string;
  bass?: string;
  arp?: string;
  pad?: PadMode;
  drums?: DrumPattern;
  fill?: DrumPattern;
  /** Crash cymbal on the section's first beat. */
  crash?: boolean;
}

export type PartKey = 'lead' | 'counter' | 'bass' | 'pad' | 'arp' | 'drums' | 'extra';

export interface SongDef {
  id: string;
  /** Internal English title (never shown as Nintendo-like branding). */
  title: string;
  bpm: number;
  tonic: string;          // pitch class, e.g. 'c', 'eb'
  mode: ScaleMode;
  /** 0 = straight, 0.1..0.3 = shuffled odd sixteenths. */
  swing?: number;
  loop: boolean;
  instruments: { lead: LeadPreset; counter?: LeadPreset; bass: BassPreset; pad: PadPreset; arp: ArpPreset; kit: KitPreset };
  /** Arp floor (MIDI), default 64. */
  arpFloor?: number;
  /** Semitone shift applied to bass roots (−12..12). */
  bassShift?: number;
  sections: Record<string, SectionDef>;
  intro: string[];
  body: string[];
  /** Pitch classes allowed outside the scale (blue notes, chromatic passing tones). */
  chromatic?: string[];
  /** Part levels 0..1.5 (defaults per part). */
  mix?: Partial<Record<PartKey, number>>;
}

export interface NoteEv {
  step: number;
  part: PartKey;
  midi: number;
  /** Duration in sixteenth steps. */
  dur: number;
  vel: number;
  /** MIDI pitch to glide from, or -1. */
  glide: number;
  drum: DrumId | null;
}

export interface CompiledSong {
  def: SongDef;
  totalSteps: number;
  /** First step of the looping body. */
  loopStart: number;
  events: NoteEv[];
  /** index[s] = first event with step >= s (length totalSteps + 1). */
  index: Uint32Array;
  /** Final-lap intensity layer (extra hats and a doubled arp), same timeline. */
  intensity: NoteEv[];
  intensityIndex: Uint32Array;
  /** Chord active at each span start. */
  chords: Array<{ step: number; chord: Chord }>;
  errors: string[];
}

export const PART_RANGES: Record<Exclude<PartKey, 'drums'>, readonly [number, number]> = {
  lead: [52, 98], counter: [45, 93], bass: [28, 67], pad: [48, 84], arp: [48, 100], extra: [48, 108],
};

const LANE_DRUMS: Record<string, Record<string, DrumId>> = {
  k: { x: 'kick', X: 'kick', o: 'kick' },
  s: { x: 'snare', X: 'snare', o: 'snare' },
  h: { x: 'hat', X: 'hat', o: 'hat' },
  o: { x: 'open', X: 'open', o: 'open' },
  c: { x: 'clap', X: 'clap', o: 'clap' },
  t: { h: 'tomHi', m: 'tomMid', l: 'tomLo', H: 'tomHi', M: 'tomMid', L: 'tomLo' },
  x: { x: 'crash', X: 'crash', o: 'crash' },
  r: { x: 'rim', X: 'rim', o: 'rim' },
  z: { x: 'shaker', X: 'shaker', o: 'shaker' },
  g: { h: 'congaHi', l: 'congaLo', H: 'congaHi', L: 'congaLo' },
  b: { x: 'cowbell', X: 'cowbell', o: 'cowbell' },
};
export const DRUM_LANES = Object.keys(LANE_DRUMS) as Array<keyof DrumPattern>;

function clean(s: string): string { return s.replace(/\s+/g, ''); }

function splitBars(line: string): string[] {
  return line.split('|').map(b => b.trim());
}

function charVel(c: string): number {
  if (c === 'X' || c === 'H' || c === 'M' || c === 'L') return 1;
  if (c === 'o') return 0.42;
  return 0.78;
}

interface Ctx {
  def: SongDef;
  events: NoteEv[];
  errors: string[];
  chords: Array<{ step: number; chord: Chord }>;
  scale: Set<number>;
  chromatic: Set<number>;
  padPrev: number[] | null;
}

function chordAt(chords: ReadonlyArray<{ step: number; chord: Chord }>, step: number): Chord | null {
  let lo = 0, hi = chords.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chords[mid]!.step <= step) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? chords[ans]!.chord : null;
}

function compileChords(c: Ctx, name: string, sec: SectionDef, base: number): Array<{ step: number; len: number; chord: Chord }> {
  const bars = splitBars(sec.chords);
  const out: Array<{ step: number; len: number; chord: Chord }> = [];
  if (sec.bars % bars.length !== 0) c.errors.push(`${name}: chord bars ${bars.length} do not divide ${sec.bars}`);
  let prev: Chord | null = null;
  for (let b = 0; b < sec.bars; b++) {
    const syms = bars[b % bars.length]!.split(/\s+/).filter(Boolean);
    if (syms.length === 0 || 16 % syms.length !== 0) {
      c.errors.push(`${name}: bar ${b + 1} has ${syms.length} chords (must be 1, 2 or 4)`);
      continue;
    }
    const len = 16 / syms.length;
    syms.forEach((sym, i) => {
      const chord = sym === '%' ? prev : parseChord(sym);
      if (!chord) { c.errors.push(`${name}: bad chord '${sym}'`); return; }
      prev = chord;
      out.push({ step: base + b * 16 + i * len, len, chord });
    });
  }
  return out;
}

function compileMelody(c: Ctx, name: string, part: 'lead' | 'counter', line: string, sec: SectionDef, base: number): void {
  const bars = splitBars(line);
  if (sec.bars % bars.length !== 0) c.errors.push(`${name}.${part}: ${bars.length} bars do not divide ${sec.bars}`);
  const [lo, hi] = PART_RANGES[part];
  let dur = 2;
  let last: NoteEv | null = null;
  let lastMidi = -1;
  for (let b = 0; b < sec.bars; b++) {
    const tokens = bars[b % bars.length]!.split(/\s+/).filter(Boolean);
    let pos = 0;
    for (const tok of tokens) {
      const m = /^(~)?([a-gA-G](?:#|b)?-?\d|r|-)(?::(\d+))?(!)?$/.exec(tok);
      if (!m) { c.errors.push(`${name}.${part}: bad token '${tok}'`); continue; }
      if (m[3]) dur = Number(m[3]);
      const step = base + b * 16 + pos;
      pos += dur;
      if (m[2] === 'r') { last = null; continue; }
      if (m[2] === '-') {
        if (last) last.dur += dur;
        continue;
      }
      const midi = parseNote(m[2]!);
      if (midi === null) { c.errors.push(`${name}.${part}: bad note '${m[2]}'`); continue; }
      if (midi < lo || midi > hi) c.errors.push(`${name}.${part}: note ${m[2]} out of range`);
      const pc = pcOf(midi);
      if (!c.scale.has(pc) && !c.chromatic.has(pc)) c.errors.push(`${name}.${part}: ${m[2]} is outside the scale`);
      const ev: NoteEv = {
        step, part, midi, dur, vel: m[4] ? 1 : 0.8,
        glide: m[1] && lastMidi >= 0 ? lastMidi : -1, drum: null,
      };
      c.events.push(ev);
      last = ev;
      lastMidi = midi;
    }
    if (pos !== 16) c.errors.push(`${name}.${part}: bar ${b % bars.length + 1} has ${pos} steps (expected 16)`);
  }
}

function degreeToMidi(ch: string, chord: Chord, shift: number): number {
  const root = bassRoot(chord.root, shift);
  const iv = chord.intervals;
  switch (ch) {
    case '1': return chord.bass !== chord.root ? bassRoot(chord.bass, shift) : root;
    case '3': return root + (iv[1] ?? 4);
    case '5': return root + (iv[2] ?? 7);
    case '7': return root + (iv[3] !== undefined && iv[3] < 12 ? iv[3] : 12);
    case '8': return root + 12;
    case '0': return root - 12 + (iv[2] ?? 7);
    default: return root;
  }
}

function compileStepLine(c: Ctx, name: string, part: 'bass' | 'arp', line: string, sec: SectionDef, base: number): void {
  const pat = clean(line);
  if (pat.length === 0 || pat.length % 16 !== 0) {
    c.errors.push(`${name}.${part}: pattern length ${pat.length} is not a multiple of 16`);
    return;
  }
  const floor = c.def.arpFloor ?? 64;
  const shift = c.def.bassShift ?? 0;
  const [lo, hi] = PART_RANGES[part];
  const total = sec.bars * 16;
  for (let i = 0; i < total; i++) {
    const ch = pat[i % pat.length]!;
    if (ch === '.' || ch === '-') continue;
    if (!/[0-9]/.test(ch)) { c.errors.push(`${name}.${part}: bad char '${ch}'`); continue; }
    let dur = 1;
    while (i + dur < total && pat[(i + dur) % pat.length] === '-') dur++;
    const step = base + i;
    const chord = chordAt(c.chords, step);
    if (!chord) continue;
    let midi: number;
    if (part === 'bass') midi = degreeToMidi(ch, chord, shift);
    else {
      const tones = arpTones(chord, floor, 10);
      midi = tones[Number(ch)] ?? tones[0]!;
    }
    if (midi < lo || midi > hi) c.errors.push(`${name}.${part}: note ${midi} out of range`);
    const accent = i % 4 === 0 ? 0.88 : 0.72;
    c.events.push({ step, part, midi, dur, vel: accent, glide: -1, drum: null });
  }
}

function compilePad(c: Ctx, mode: PadMode, spans: ReadonlyArray<{ step: number; len: number; chord: Chord }>): void {
  for (const sp of spans) {
    const v = voiceLead(sp.chord, c.padPrev, 53, 77, 4);
    c.padPrev = v;
    const hits: Array<[number, number]> = [];
    if (mode === 'hold') hits.push([0, sp.len]);
    else if (mode === 'stab8') for (let s = 2; s < sp.len; s += 4) hits.push([s, 2]);
    else if (mode === 'stab4') for (let s = 4; s < sp.len; s += 8) hits.push([s, 3]);
    else for (let s = 0; s < sp.len; s += 2) hits.push([s, 2]);
    for (const [off, len] of hits) {
      for (const midi of v) c.events.push({ step: sp.step + off, part: 'pad', midi, dur: len, vel: mode === 'hold' ? 0.7 : 0.8, glide: -1, drum: null });
    }
  }
}

function compileDrums(c: Ctx, name: string, sec: SectionDef, base: number): void {
  if (sec.crash) c.events.push({ step: base, part: 'drums', midi: 0, dur: 1, vel: 0.9, glide: -1, drum: 'crash' });
  const pat = sec.drums;
  if (!pat) return;
  for (let b = 0; b < sec.bars; b++) {
    const src: DrumPattern = b === sec.bars - 1 && sec.fill ? { ...pat, ...sec.fill } : pat;
    for (const lane of DRUM_LANES) {
      const raw = src[lane];
      if (raw === undefined) continue;
      const s = clean(raw);
      if (s.length === 0 || s.length % 16 !== 0) {
        c.errors.push(`${name}.drums.${lane}: length ${s.length} is not a multiple of 16`);
        continue;
      }
      const map = LANE_DRUMS[lane]!;
      const barOff = ((b * 16) % s.length);
      for (let i = 0; i < 16; i++) {
        const ch = s[barOff + i]!;
        if (ch === '.') continue;
        const drum = map[ch];
        if (!drum) { c.errors.push(`${name}.drums.${lane}: bad char '${ch}'`); continue; }
        c.events.push({ step: base + b * 16 + i, part: 'drums', midi: 0, dur: 1, vel: charVel(ch), glide: -1, drum });
      }
    }
  }
}

/** Avoid-note check: a melody note struck on a chord change must not rub a semitone above a chord tone. */
function checkHarmony(c: Ctx): void {
  const changes = new Set(c.chords.map(x => x.step));
  for (const ev of c.events) {
    if ((ev.part !== 'lead' && ev.part !== 'counter') || ev.dur < 2 || !changes.has(ev.step)) continue;
    const chord = chordAt(c.chords, ev.step)!;
    const pc = pcOf(ev.midi);
    if (chord.pcs.has(pc)) continue;
    for (const t of chord.pcs) {
      if ((t + 1) % 12 === pc) {
        c.errors.push(`${c.def.id}: ${ev.part} pitch ${ev.midi} clashes with ${chord.symbol} at step ${ev.step}`);
        break;
      }
    }
  }
}

function buildIndex(events: readonly NoteEv[], total: number): Uint32Array {
  const idx = new Uint32Array(total + 1);
  let e = 0;
  for (let s = 0; s <= total; s++) {
    while (e < events.length && events[e]!.step < s) e++;
    idx[s] = e;
  }
  return idx;
}

function buildIntensity(c: Ctx, total: number): NoteEv[] {
  const out: NoteEv[] = [];
  const floor = (c.def.arpFloor ?? 64) + 12;
  const cycle = [0, 1, 2, 3, 2, 1, 0, 2];
  for (let s = 0; s < total; s++) {
    const beat = s % 4 === 0;
    out.push({ step: s, part: 'drums', midi: 0, dur: 1, vel: beat ? 0.5 : s % 2 === 0 ? 0.36 : 0.24, glide: -1, drum: 'hat' });
    const chord = chordAt(c.chords, s);
    if (!chord) continue;
    const tones = arpTones(chord, floor, 4);
    const midi = tones[cycle[s % cycle.length]! % tones.length]!;
    out.push({ step: s, part: 'extra', midi, dur: 1, vel: beat ? 0.62 : 0.45, glide: -1, drum: null });
  }
  return out;
}

const compiledCache = new Map<string, CompiledSong>();

export function compileSong(def: SongDef): CompiledSong {
  const hit = compiledCache.get(def.id);
  if (hit && hit.def === def) return hit;
  const tonic = parsePitchClass(def.tonic);
  const errors: string[] = [];
  if (tonic === null) errors.push(`${def.id}: bad tonic '${def.tonic}'`);
  const chromatic = new Set<number>();
  for (const p of def.chromatic ?? []) {
    const pc = parsePitchClass(p);
    if (pc === null) errors.push(`${def.id}: bad chromatic '${p}'`); else chromatic.add(pc);
  }
  const c: Ctx = { def, events: [], errors, chords: [], scale: scalePitchClasses(tonic ?? 0, def.mode), chromatic, padPrev: null };
  const order = [...def.intro, ...def.body];
  let step = 0;
  let loopStart = 0;
  order.forEach((name, i) => {
    if (i === def.intro.length) loopStart = step;
    const sec = def.sections[name];
    if (!sec) { errors.push(`${def.id}: missing section '${name}'`); return; }
    const label = `${def.id}.${name}`;
    const spans = compileChords(c, label, sec, step);
    for (const sp of spans) c.chords.push({ step: sp.step, chord: sp.chord });
    if (sec.lead) compileMelody(c, label, 'lead', sec.lead, sec, step);
    if (sec.counter) compileMelody(c, label, 'counter', sec.counter, sec, step);
    if (sec.bass) compileStepLine(c, label, 'bass', sec.bass, sec, step);
    if (sec.arp) compileStepLine(c, label, 'arp', sec.arp, sec, step);
    if (sec.pad) compilePad(c, sec.pad, spans);
    compileDrums(c, label, sec, step);
    step += sec.bars * 16;
  });
  if (def.intro.length === order.length) loopStart = step;
  checkHarmony(c);
  const events = c.events.sort((a, b) => a.step - b.step);
  const intensity = buildIntensity(c, step);
  const song: CompiledSong = {
    def, totalSteps: step, loopStart, events, index: buildIndex(events, step),
    intensity, intensityIndex: buildIndex(intensity, step), chords: c.chords, errors,
  };
  compiledCache.set(def.id, song);
  return song;
}

/** Number of bars in the looping body. */
export function bodyBars(def: SongDef): number {
  return def.body.reduce((n, s) => n + (def.sections[s]?.bars ?? 0), 0);
}

export { chordAt };
