import type { SectionDef, SongDef } from '../pattern.js';

/** Frost Peak Pass — chilly celesta and bells in D major, soft shuffled groove. 132 bpm. */
const SOFT = {
  k: 'x.......x..x....',
  r: '....x.......x...',
  z: 'x.x.x.x.x.x.x.x.',
  h: '..x...x...x...x.',
};

const INTRO: SectionDef = {
  bars: 4,
  chords: 'Dmaj7 | Gmaj7 | Dmaj7 | A7sus4',
  lead: 'a5:2 c#6 f#6 a6 -:8 | b5:2 d6 f#6 b6 -:8 | a6:4 f#6:4 d6:4 c#6:4 | e6:8 d6:8',
  pad: 'hold',
  bass: '1---------------',
  drums: { z: '..x...x...x...x.' },
  fill: { k: 'x.......x.x.x.x.', s: '............x.xx' },
};

const A: SectionDef = {
  bars: 8,
  chords: 'D | A/C# | Bm | G | D | A | G A | D',
  lead:
    'f#5:4 a5:2 d6:6 c#6:2 d6:2 | e6:6 c#6:2 a5:8 | d6:4 f#6:2 b5:6 a5:2 b5:2 | g5:6 b5:2 d6:8 | ' +
    'f#5:4 a5:2 d6:6 e6:2 f#6:2 | e6:6 c#6:2 a5:4 e5:4 | d6:4 b5:4 c#6:4 e6:4 | d6:12 r:4',
  bass: '1---1.5-1---5.3.',
  pad: 'hold',
  drums: SOFT,
  fill: { s: '............x.xx' },
  crash: true,
};

const B: SectionDef = {
  bars: 8,
  chords: 'Gmaj7 | F#m7 | Em7 | A7 | Gmaj7 | F#m7 | Em7 | A7sus4 A7',
  lead:
    'b5:2 d6 f#6:4 e6:2 d6 b5:4 | a5:2 c#6 e6:4 d6:2 c#6 a5:4 | g5:2 b5 d6:4 e6:2 f#6 g6:4 | e6:8 c#6:4 a5:4 | ' +
    'd6:2 f#6 a6:4 g6:2 f#6 d6:4 | c#6:2 e6 a6:4 f#6:2 e6 c#6:4 | b5:4 d6:4 g6:4 f#6:4 | d6:8 c#6:8',
  arp: '0.1.2.3.4.3.2.1.',
  bass: '1-----5-8-----5-',
  pad: 'hold',
  drums: { ...SOFT, k: 'x.......x.......', o: '..............x.' },
  fill: { s: '........x.x.xxXX', t: '............h.m.' },
};

const A2: SectionDef = {
  ...A,
  counter: 'd5:8 f#5:8 | c#5:8 e5:8 | b4:8 d5:8 | b4:8 g4:8 | a4:8 d5:8 | c#5:8 e5:8 | b4:8 c#5:8 | a4:8 f#4:8',
  arp: '0120 3212 0120 3212',
};

const C: SectionDef = {
  bars: 4,
  chords: 'Bm | G | Em7 | A7',
  lead: 'f#6:6 e6:2 d6:4 b5:4 | d6:6 b5:2 g5:8 | e6:4 g6:4 b6:4 a6:4 | g6:4 e6:4 c#6:4 a5:4',
  arp: '0123 2101 0123 2101',
  bass: '1.......5.......',
  pad: 'hold',
  drums: { z: 'x.x.x.x.x.x.x.x.', r: '....x.......x...' },
  fill: { k: 'x...x...x...x...', s: '........xxxxXXXX' },
};

export const FROST_PEAK: SongDef = {
  id: 'frost-peak',
  title: 'Snowglobe Serenade',
  bpm: 132,
  tonic: 'd',
  mode: 'major',
  swing: 0.08,
  loop: true,
  instruments: { lead: 'bell', counter: 'flute', bass: 'sub', pad: 'glass', arp: 'bell', kit: 'pop' },
  arpFloor: 69,
  sections: { INTRO, A, B, A2, C },
  intro: ['INTRO'],
  body: ['A', 'B', 'A2', 'C'],
};
