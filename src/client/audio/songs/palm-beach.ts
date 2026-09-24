import type { SectionDef, SongDef } from '../pattern.js';

/** Palm Beach Boulevard — sunny calypso in F major, steel-pan lead over congas. 128 bpm. */
const GROOVE = {
  k: 'x.......x.......',
  r: '...x..x....x..x.',
  z: 'XoxoXoxoXoxoXoxo',
  g: '..h.l.hh..h.l.hl',
};

const INTRO: SectionDef = {
  bars: 4,
  chords: 'F | Bb | Gm7 | C7',
  lead: 'c6:2 c6 a5 c6 f6:4 e6:2 c6:2 | d6:2 d6 bb5 d6 f6:4 d6:4 | bb5:2 a5 g5 bb5 d6:4 c6:2 bb5:2 | a5:2 g5 e5 g5 c6:6 r:2',
  bass: '1-------5-------',
  pad: 'hold',
  drums: { z: 'XoxoXoxoXoxoXoxo', g: '..h.l.hh..h.l.hl' },
  fill: { s: '............x.xx', k: 'x.......x.......' },
};

const A: SectionDef = {
  bars: 8,
  chords: 'F | C/E | Dm | Bb | F | C | Bb C | F',
  lead:
    'a5:3 c6:3 f6:2 e6:2 c6:2 a5:4 | g5:3 c6:3 e6:2 d6:2 c6:2 g5:4 | f5:3 a5:3 d6:2 c6:2 a5:2 f5:4 | d6:6 c6:2 bb5:4 a5:4 | ' +
    'a5:3 c6:3 f6:2 g6:2 f6:2 c6:4 | e6:3 g6:3 e6:2 c6:2 bb5:2 g5:4 | d6:4 f6:4 e6:4 g6:4 | f6:8 r:4 c6:2 d6:2',
  bass: '1..5..1.8..5..1.',
  pad: 'stab8',
  drums: GROOVE,
  fill: { s: '..........x.xXxX' },
  crash: true,
};

const B: SectionDef = {
  bars: 8,
  chords: 'Dm | Am | Bb | F | Gm | Am | Bb | C7',
  lead:
    'a5:4 d6:4 f6:6 e6:2 | e6:4 c6:4 a5:8 | bb5:2 c6 d6 f6 d6:4 bb5:4 | c6:6 a5:2 f5:8 | ' +
    'g5:2 bb5 d6 g6 f6:4 d6:4 | e6:2 f6 e6 c6 a5:8 | d6:3 f6:3 d6:2 bb5:4 c6:4 | e6:4 g6:4 bb6:6 r:2',
  bass: '1...1.5.1...5.3.',
  pad: 'hold',
  arp: '0.1.2.1.0.1.2.1.',
  drums: { ...GROOVE, k: 'x..x....x..x....' },
  fill: { s: '....x...x.xxXXXX', t: '..........hhmmll' },
};

const A2: SectionDef = {
  ...A,
  counter:
    'r:8 f5:2 a5 c6 a5 | r:8 e5:2 g5 c6 g5 | r:8 d5:2 f5 a5 f5 | r:8 bb4:2 d5 f5 d5 | ' +
    'r:8 c5:2 f5 a5 f5 | r:8 c5:2 e5 g5 e5 | bb4:4 d5:4 c5:4 e5:4 | f5:8 r:8',
  drums: { ...GROOVE, k: 'x..x..x.x..x..x.', o: '..............x.' },
};

const C: SectionDef = {
  bars: 4,
  chords: 'Gm7 | Am7 | Bb | C7',
  lead: 'd6:6 c6:2 bb5:4 g5:4 | c6:6 a5:2 e5:8 | f5:2 bb5 d6 f6 d6:4 f6:4 | g6:4 e6:4 c6:4 bb5:4',
  bass: '1-----5-1-----5-',
  arp: '0123 2103 0123 2103',
  pad: 'hold',
  drums: { z: 'XoxoXoxoXoxoXoxo', g: 'h.hlh.hlh.hlhhll' },
  fill: { k: 'x...x...x...x...', s: '........x.x.XXXX' },
};

export const PALM_BEACH: SongDef = {
  id: 'palm-beach',
  title: 'Coconut Cruise',
  bpm: 128,
  tonic: 'f',
  mode: 'major',
  swing: 0.1,
  loop: true,
  instruments: { lead: 'steel', counter: 'marimba', bass: 'sub', pad: 'organ', arp: 'steel', kit: 'latin' },
  arpFloor: 65,
  sections: { INTRO, A, B, A2, C },
  intro: ['INTRO'],
  body: ['A', 'B', 'A2', 'C'],
};
