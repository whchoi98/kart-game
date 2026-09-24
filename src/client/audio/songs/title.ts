import type { SectionDef, SongDef } from '../pattern.js';

/** Title theme — anthemic G major brass fanfare into a big sing-along hook. 120 bpm. */
const ROCK = {
  k: 'x.......x.x.....',
  s: '....x.......x...',
  h: 'x.x.x.x.x.x.x.x.',
};

const INTRO: SectionDef = {
  bars: 4,
  chords: 'G | C/G | D/G | G',
  lead: 'd5:2 d5 d5 g5:6 b5:4 | c6:2 c6 c6 e6:6 c6:4 | a5:2 a5 a5 d6:6 f#6:4 | g6:12! r:4',
  bass: '1-----1-1-----1-',
  pad: 'hold',
  drums: { k: 'x.....x.x.......', t: '..........l.l.l.' },
  fill: { t: 'h.h.m.m.l.l.LLLL', s: '............XXXX' },
  crash: true,
};

const A: SectionDef = {
  bars: 8,
  chords: 'G | D/F# | Em | C | G | D | C D | G',
  lead:
    'b5:6 a5:2 g5:4 d6:4 | d6:6 c6:2 a5:8 | g5:4 b5:4 e6:6 d6:2 | e6:4 d6:4 c6:8 | ' +
    'b5:6 a5:2 g5:4 b5:4 | a5:4 d6:4 f#6:6 e6:2 | e6:4 g6:4 f#6:4 a6:4 | g6:12 r:4',
  bass: '1.1.1.1.1.1.5.8.',
  pad: 'hold',
  drums: ROCK,
  fill: { s: '....x.......xxXX', t: '........h.m.l.l.' },
  crash: true,
};

const B: SectionDef = {
  bars: 8,
  chords: 'Em | C | G | D | Em | C | Am7 | D',
  lead:
    'e6:4 f#6:2 g6:2 b6:8 | a6:4 g6:4 e6:8 | d6:4 g6:4 b6:8 | a6:6 f#6:2 d6:8 | ' +
    'g6:4 e6:4 b5:4 e6:4 | g6:4 e6:4 c6:8 | c6:4 e6:4 a6:4 g6:4 | f#6:8 d6:4 a5:4',
  bass: '1.1.8.1.1.1.8.5.',
  arp: '0.1.2.1.0.1.2.1.',
  pad: 'hold',
  drums: { k: 'x...x...x...x...', s: '....x.......x...', o: '..x...x...x...x.' },
  fill: { s: '....x...x.x.XXXX', t: '..........hhmmll' },
  crash: true,
};

const A2: SectionDef = {
  ...A,
  counter: 'd5:8 b4:8 | a4:8 f#4:8 | b4:8 g4:8 | g4:8 e4:8 | d5:8 b4:8 | f#4:8 a4:8 | g4:8 a4:8 | b4:8 d5:8',
  arp: '0120 1201 0120 1232',
  drums: { ...ROCK, h: 'x.xxx.xxx.xxx.xx' },
};

export const TITLE: SongDef = {
  id: 'title',
  title: 'Turbo Pals Anthem',
  bpm: 120,
  tonic: 'g',
  mode: 'major',
  loop: true,
  instruments: { lead: 'brass', counter: 'pulse', bass: 'saw', pad: 'strings', arp: 'pluck', kit: 'rock' },
  arpFloor: 62,
  sections: { INTRO, A, B, A2 },
  intro: ['INTRO'],
  body: ['A', 'B', 'A2'],
};
