import type { SectionDef, SongDef } from '../pattern.js';

/** Results — short celebratory D major loop for the standings screen. 132 bpm. */
const INTRO: SectionDef = {
  bars: 1,
  chords: 'D',
  lead: 'd5:2 f#5 a5 d6:6 r:4',
  bass: '1-------........',
  drums: { k: 'x...............', s: '........xxxxXXXX' },
  crash: true,
};

const A: SectionDef = {
  bars: 8,
  chords: 'D | G | A | D | Bm | G | Em A | D',
  lead:
    'f#6:2 e6 d6 a5 d6:4 f#6:4 | g6:2 f#6 e6 d6 b5:8 | a5:2 c#6 e6 a6 g6:4 e6:4 | f#6:6 e6:2 d6:8 | ' +
    'd6:2 c#6 b5 f#5 b5:4 d6:4 | e6:2 d6 b5 g5 b5:4 d6:4 | g6:4 e6:4 e6:4 c#6:4 | d6:8 a5:4 f#5:4',
  bass: '1.1.5.1.8.1.5.1.',
  arp: '0.1.2.1.0.1.2.1.',
  pad: 'stab8',
  drums: { k: 'x.....x.x.......', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.', c: '............x...' },
  fill: { s: '....x.......xxXX' },
  crash: true,
};

export const RESULTS: SongDef = {
  id: 'results',
  title: 'Checkered Confetti',
  bpm: 132,
  tonic: 'd',
  mode: 'major',
  loop: true,
  instruments: { lead: 'pulse', counter: 'square', bass: 'tri', pad: 'soft', arp: 'pluck', kit: 'pop' },
  arpFloor: 66,
  sections: { INTRO, A },
  intro: ['INTRO'],
  body: ['A'],
};
