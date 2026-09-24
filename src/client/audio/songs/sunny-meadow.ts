import type { SectionDef, SongDef } from '../pattern.js';

/** Sunny Meadow Circuit — bright, bouncy C major chip-pop at 150 bpm. */
const A: SectionDef = {
  bars: 8,
  chords: 'C | G | Am | F | C | G | F G | C',
  lead:
    'e5:2 g5 c6:4 b5:2 c6 d6 e6 | d6:6 b5:2 g5:4 r:4 | c6:2 b5 a5 e5 a5:4 c6:4 | a5:6 g5:2 f5:4 r:4 | ' +
    'e5:2 g5 c6:4 b5:2 c6 d6 e6 | f6:4 e6:2 d6 b5:4 g5:4 | a5:4 c6:4 b5:4 d6:4 | c6:8 r:4 g5:2 a5:2',
  bass: '1.1.8.1.5.1.8.5.',
  pad: 'stab8',
  drums: {
    k: 'x.....x...x.....',
    s: '....x.......x...',
    h: 'x.x.x.x.x.x.x.x.',
  },
  fill: { s: '....x.......xxXX', t: '........h.m.....' },
};

const B: SectionDef = {
  bars: 8,
  chords: 'F | G | Em | Am | F | G | Am Em | F G',
  lead:
    'c6:4 a5:2 c6 f6:6 e6:2 | d6:4 b5:2 d6 g6:8 | e6:4 d6:2 b5 g5:4 b5:4 | c6:6 b5:2 a5:8 | ' +
    'f5:2 a5 c6 f6 e6:4 c6:4 | d6:2 e6 f6 e6 d6:4 b5:4 | c6:4 e6:4 b5:4 g5:4 | a5:4 c6:4 d6:4 ~g6:4',
  bass: '1---5---8---5-3-',
  arp: '0.2.1.2.0.2.1.2.',
  pad: 'hold',
  drums: {
    k: 'x.......x.x.....',
    s: '....x.......x...',
    o: '..x...x...x...x.',
    h: 'x...x...x...x...',
  },
  fill: { s: '....x...x.x.XXXX' },
};

const A2: SectionDef = {
  ...A,
  crash: true,
  counter:
    'c5:8 e5:8 | b4:8 d5:8 | a4:8 c5:8 | a4:8 f4:8 | c5:8 e5:8 | d5:8 b4:8 | c5:8 b4:8 | g4:8 e4:8',
  arp: '0120 1201 2012 3210',
  drums: {
    k: 'x.....x...x.....',
    s: '....x.......x...',
    h: 'x.xxx.x.x.xxx.x.',
  },
};

const C: SectionDef = {
  bars: 4,
  chords: 'Am | F | Dm | G',
  lead: 'e6:6 d6:2 c6:4 a5:4 | c6:6 a5:2 f5:8 | d6:4 f6:4 e6:4 d6:4 | b5:4 d6:4 g6:4 f6:2 d6:2',
  bass: '1-----1-5-----5-',
  arp: '0.1.2.3.2.1.0.1.',
  pad: 'hold',
  drums: {
    k: 'x.......x.......',
    r: '....x.......x...',
    z: 'x.xxx.xxx.xxx.xx',
  },
  fill: { s: 'x.x.x.x.xxxxXXXX', k: 'x...x...x...x...' },
};

const INTRO: SectionDef = {
  bars: 4,
  chords: 'C | F | Dm | G',
  lead: 'c5:2 e5 g5 c6 -:4 g5:2 c6:2 | a5:2 c6 f6:4 e6:2 c6 a5:4 | f5:2 a5 d6:4 c6:2 a5 f5:4 | g5:4 b5:4 d6:4 g6:2! r:2',
  bass: '1-------5-------',
  pad: 'hold',
  drums: { x: 'x...............', k: 'x.......x.......', h: '..x...x...x...x.' },
  fill: { s: '........x.x.XXXX', k: 'x...x...x...x...' },
};

export const SUNNY_MEADOW: SongDef = {
  id: 'sunny-meadow',
  title: 'Dandelion Dash',
  bpm: 150,
  tonic: 'c',
  mode: 'major',
  loop: true,
  instruments: { lead: 'pulse', counter: 'thin', bass: 'tri', pad: 'soft', arp: 'pluck', kit: 'pop' },
  arpFloor: 67,
  sections: { INTRO, A, B, A2, C },
  intro: ['INTRO'],
  body: ['A', 'B', 'A2', 'C'],
};
