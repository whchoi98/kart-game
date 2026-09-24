/**
 * Tiny music-theory toolkit used by the pattern compiler and the song validator.
 * Pure functions only (no WebAudio) so everything here is unit-testable in Node.
 *
 * Pitches are MIDI note numbers (C4 = 60, A4 = 69 = 440 Hz).
 */

const LETTER_PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Parse a pitch class such as 'c', 'f#', 'bb', 'Eb'. Returns 0..11 or null. */
export function parsePitchClass(s: string): number | null {
  const m = /^([a-gA-G])(#|b)?$/.exec(s.trim());
  if (!m) return null;
  let pc = LETTER_PC[m[1]!.toLowerCase()]!;
  if (m[2] === '#') pc += 1;
  else if (m[2] === 'b') pc -= 1;
  return (pc + 12) % 12;
}

/** Parse a note name with octave ('c5', 'f#4', 'bb3', 'E2'). Returns a MIDI number or null. */
export function parseNote(s: string): number | null {
  const m = /^([a-gA-G])(#|b)?(-?\d)$/.exec(s.trim());
  if (!m) return null;
  let pc = LETTER_PC[m[1]!.toLowerCase()]!;
  if (m[2] === '#') pc += 1;
  else if (m[2] === 'b') pc -= 1;
  const oct = Number(m[3]);
  return (oct + 1) * 12 + pc;
}

export function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function pcOf(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

export type ScaleMode =
  | 'major' | 'minor' | 'dorian' | 'mixolydian' | 'lydian' | 'harmonicMinor' | 'phrygian';

export const SCALES: Record<ScaleMode, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

/** Pitch classes of a scale built on `tonicPc`. */
export function scalePitchClasses(tonicPc: number, mode: ScaleMode): Set<number> {
  return new Set(SCALES[mode].map(i => (tonicPc + i) % 12));
}

/** Chord qualities → intervals above the root. Order matters (longest suffix first when parsing). */
const QUALITIES: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['maj9', [0, 4, 7, 11, 14]],
  ['maj7', [0, 4, 7, 11]],
  ['madd9', [0, 3, 7, 14]],
  ['m7b5', [0, 3, 6, 10]],
  ['7sus4', [0, 5, 7, 10]],
  ['dim7', [0, 3, 6, 9]],
  ['add9', [0, 4, 7, 14]],
  ['sus2', [0, 2, 7]],
  ['sus4', [0, 5, 7]],
  ['dim', [0, 3, 6]],
  ['aug', [0, 4, 8]],
  ['m9', [0, 3, 7, 10, 14]],
  ['m7', [0, 3, 7, 10]],
  ['m6', [0, 3, 7, 9]],
  ['9', [0, 4, 7, 10, 14]],
  ['7', [0, 4, 7, 10]],
  ['6', [0, 4, 7, 9]],
  ['5', [0, 7]],
  ['m', [0, 3, 7]],
  ['', [0, 4, 7]],
];

export interface Chord {
  symbol: string;
  /** Root pitch class. */
  root: number;
  /** Intervals above the root (ascending, may exceed 12 for 9ths). */
  intervals: readonly number[];
  /** Bass pitch class (slash chords), defaults to the root. */
  bass: number;
  /** Set of chord-tone pitch classes. */
  pcs: ReadonlySet<number>;
}

const chordCache = new Map<string, Chord | null>();

/** Parse a chord symbol: 'C', 'Am', 'F#m7', 'Bbmaj7', 'Gsus4', 'C/E', 'D7/F#'. */
export function parseChord(symbol: string): Chord | null {
  const cached = chordCache.get(symbol);
  if (cached !== undefined) return cached;
  let result: Chord | null = null;
  const [main, slash] = symbol.split('/');
  const m = /^([A-G])(#|b)?(.*)$/.exec(main ?? '');
  if (m) {
    const root = parsePitchClass(m[1]! + (m[2] ?? ''));
    const q = QUALITIES.find(([name]) => name === m[3]);
    let bass = root;
    let ok = root !== null && q !== undefined;
    if (ok && slash !== undefined) {
      bass = parsePitchClass(slash);
      ok = bass !== null;
    }
    if (ok && root !== null && q && bass !== null) {
      const intervals = q[1];
      result = {
        symbol, root, intervals, bass,
        pcs: new Set(intervals.map(i => (root + i) % 12)),
      };
    }
  }
  chordCache.set(symbol, result);
  return result;
}

/**
 * Close-position voicing of a chord whose lowest note is the first chord tone at or above
 * `floor`. Returns ascending MIDI numbers (triad tones only plus 7th/9th if present).
 */
export function voiceChord(chord: Chord, floor: number, maxTones = 4): number[] {
  const pcs = chord.intervals.map(i => (chord.root + i) % 12);
  const notes: number[] = [];
  let base = floor;
  // find the lowest chord tone >= floor
  for (let m = floor; m < floor + 12; m++) {
    if (pcs.includes(pcOf(m))) { base = m; break; }
  }
  notes.push(base);
  let cur = base;
  while (notes.length < Math.min(maxTones, pcs.length)) {
    cur++;
    if (pcs.includes(pcOf(cur)) && !notes.some(n => pcOf(n) === pcOf(cur))) notes.push(cur);
    if (cur > base + 24) break;
  }
  return notes;
}

/**
 * Voice-led chord: picks the inversion (within [lo, hi]) with the smallest total motion
 * from the previous voicing. Keeps pads smooth instead of jumping in parallel.
 */
export function voiceLead(chord: Chord, prev: readonly number[] | null, lo: number, hi: number, maxTones = 4): number[] {
  let best: number[] = voiceChord(chord, lo, maxTones);
  if (!prev || prev.length === 0) return best;
  let bestCost = Infinity;
  for (let floor = lo; floor <= hi - 7; floor++) {
    const v = voiceChord(chord, floor, maxTones);
    if (v[v.length - 1]! > hi) continue;
    let cost = 0;
    for (const n of v) {
      let d = Infinity;
      for (const p of prev) d = Math.min(d, Math.abs(n - p));
      cost += d;
    }
    if (cost < bestCost) { bestCost = cost; best = v; }
  }
  return best;
}

/** Tones for an arpeggio: chord pitch classes expanded upward from `floor` over `octaves`. */
export function arpTones(chord: Chord, floor: number, count: number): number[] {
  const pcs = new Set(chord.intervals.map(i => (chord.root + i) % 12));
  const out: number[] = [];
  for (let m = floor; out.length < count && m < floor + 60; m++) {
    if (pcs.has(pcOf(m))) out.push(m);
  }
  return out;
}

/** Bass register root: keeps roots between E2 (40) and D#3 (51) for small speakers. */
export function bassRoot(pc: number, shift = 0): number {
  return 40 + ((pc - 4 + 12) % 12) + shift;
}
