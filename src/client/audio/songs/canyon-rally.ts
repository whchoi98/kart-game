import type { SectionDef, SongDef } from '../pattern.js';

/** Red Canyon Rally — galloping frontier twang in E minor with a mixolydian lift. 140 bpm. */
const GALLOP = {
  k: 'x...x...x...x...',
  s: '....x.......x...',
  h: 'x.xxx.xxx.xxx.xx',
};

const INTRO: SectionDef = {
  bars: 4,
  chords: 'Em | Em | Am | B7',
  counter: 'b5:6 e6:2 g6:8 | f#6:4 e6:4 d6:4 b5:4 | c6:6 b5:2 a5:8 | d#6:4 f#6:4 b5:8',
  arp: '0.1.2.1.0.1.2.1.',
  bass: '1---------------',
  drums: { r: 'x.......x.......' },
  fill: { k: 'x...x...x...x...', t: '........l.l.m.hh' },
};

const A: SectionDef = {
  bars: 8,
  chords: 'Em | D | C | B7 | Em | D | C B7 | Em',
  lead:
    'e5:2 e5 g5 b5 e6:4 d6:2 b5:2 | a5:2 a5 f#5 a5 d6:4 c6:2 a5:2 | g5:2 g5 e5 g5 c6:4 b5:2 g5:2 | f#5:4 a5:4 d#6:4 b5:4 | ' +
    'e6:2 e6 d6 b5 g5:4 b5:2 e6:2 | f#6:2 f#6 e6 d6 a5:4 d6:2 f#6:2 | e6:4 g6:4 f#6:4 d#6:4 | e6:8 r:4 b5:2 d6:2',
  bass: '1.115.551.115.55',
  pad: 'stab4',
  drums: GALLOP,
  fill: { s: '....x.......xxXX' },
  crash: true,
};

const B: SectionDef = {
  bars: 8,
  chords: 'E | D | A | E | E | D | A | B7',
  lead:
    'g#5:4 b5:4 e6:6 d6:2 | f#6:6 e6:2 d6:4 a5:4 | e6:4 c#6:4 a5:4 e5:4 | b5:6 g#5:2 e5:8 | ' +
    'e5:2 g#5 b5 e6 g#6:4 e6:4 | f#6:2 e6 d6 a5 f#5:8 | a5:2 c#6 e6 a6 g6:4 e6:4 | f#6:4 d#6:4 b5:4 a5:4',
  bass: '1.1.5.5.8.8.5.5.',
  pad: 'hold',
  drums: { k: 'x...x...x...x...', s: 'o.o.x.o.o.o.x.o.', h: 'x.x.x.x.x.x.x.x.' },
  fill: { s: '....x...xxxxXXXX', t: '........h.h.m.l.' },
  crash: true,
};

const A2: SectionDef = {
  ...A,
  counter: 'g4:8 b4:8 | f#4:8 a4:8 | e4:8 g4:8 | d#4:8 f#4:8 | g4:8 b4:8 | a4:8 f#4:8 | g4:8 f#4:8 | g4:8 e4:8',
  arp: '0.2.1.2.0.2.1.2.',
  drums: { ...GALLOP, b: 'x...x...x...x...' },
};

const C: SectionDef = {
  bars: 4,
  chords: 'Am | Em | C | B7',
  counter: 'e6:6 d6:2 c6:4 a5:4 | b5:6 a5:2 g5:8 | e6:4 g6:4 e6:4 c6:4 | b5:4 d#6:4 f#6:4 a6:4',
  arp: '0120 1201 0120 1232',
  bass: '1.......5.......',
  pad: 'hold',
  drums: { k: 'x.......x.......', t: 'l..ll..lm..mm..m' },
  fill: { s: 'x.x.x.x.xxxxXXXX', k: 'x...x...x...x...' },
};

export const CANYON_RALLY: SongDef = {
  id: 'canyon-rally',
  title: 'Mesa Gallop',
  bpm: 140,
  tonic: 'e',
  mode: 'minor',
  chromatic: ['d#', 'g#', 'c#'],
  loop: true,
  instruments: { lead: 'twang', counter: 'flute', bass: 'pluck', pad: 'strings', arp: 'pluck', kit: 'rock' },
  arpFloor: 52,
  sections: { INTRO, A, B, A2, C },
  intro: ['INTRO'],
  body: ['A', 'B', 'A2', 'C'],
};
