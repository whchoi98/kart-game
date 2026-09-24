import type { SectionDef, SongDef } from '../pattern.js';

/** Menu theme — relaxed, jazzy A major shuffle for browsing the garage. 108 bpm. */
const LAZY = {
  k: 'x.......x..x....',
  r: '....x.......x...',
  h: 'x.x.x.x.x.x.x.x.',
};

const INTRO: SectionDef = {
  bars: 2,
  chords: 'Dmaj7 | E7sus4',
  lead: 'f#5:4 a5:4 c#6:8 | b5:8 a5:8',
  bass: '1-------5-------',
  pad: 'hold',
  drums: { h: '..x...x...x...x.' },
  fill: { r: '............x.x.' },
};

const A: SectionDef = {
  bars: 8,
  chords: 'Amaj7 | F#m7 | Bm7 | E7 | Amaj7 | F#m7 | Bm7 E7 | Amaj7',
  lead:
    'e5:2 a5 c#6:4 b5:2 a5:2 e5:4 | f#5:6 a5:2 c#6:4 r:4 | d6:2 c#6 b5:4 a5:2 f#5 d5:4 | e5:6 g#5:2 b5:4 r:4 | ' +
    'e5:2 a5 c#6:4 e6:2 d6 c#6:4 | a5:6 f#5:2 e5:4 r:4 | d6:4 f#6:4 e6:4 d6:4 | c#6:8 r:8',
  bass: '1...5.8.1...5.3.',
  pad: 'stab4',
  drums: LAZY,
  fill: { r: '....x.......x.xx' },
};

const B: SectionDef = {
  bars: 8,
  chords: 'Dmaj7 | C#m7 | Bm7 | E7 | Dmaj7 | C#m7 | F#m7 | Bm7 E7',
  lead:
    'a5:4 c#6:4 f#6:6 e6:2 | e6:6 c#6:2 g#5:8 | f#5:2 a5 d6 f#6 e6:4 d6:4 | b5:8 g#5:4 e5:4 | ' +
    'f#5:2 a5 c#6 f#6 a6:4 f#6:4 | g#6:6 e6:2 c#6:8 | c#6:4 e6:4 a6:4 f#6:4 | d6:4 b5:4 d6:4 e6:4',
  bass: '1---5---8---5---',
  arp: '0.1.2.3.2.1.0.1.',
  pad: 'hold',
  drums: { ...LAZY, z: '..x...x...x...x.' },
};

const A2: SectionDef = {
  ...A,
  counter:
    'a4:4 c#5:4 e5:8 | f#4:4 a4:4 c#5:8 | f#4:4 b4:4 d5:8 | g#4:4 b4:4 d5:8 | ' +
    'a4:4 c#5:4 e5:8 | a4:4 c#5:4 f#5:8 | f#4:4 b4:4 g#4:4 b4:4 | a4:4 c#5:4 e5:8',
};

export const MENU: SongDef = {
  id: 'menu',
  title: 'Garage Lounge',
  bpm: 108,
  tonic: 'a',
  mode: 'major',
  swing: 0.18,
  loop: true,
  instruments: { lead: 'square', counter: 'marimba', bass: 'sub', pad: 'soft', arp: 'pluck', kit: 'pop' },
  arpFloor: 64,
  sections: { INTRO, A, B, A2 },
  intro: ['INTRO'],
  body: ['A', 'B', 'A2'],
};
