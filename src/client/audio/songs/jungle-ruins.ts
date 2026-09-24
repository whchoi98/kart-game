import type { SectionDef, SongDef } from '../pattern.js';

/** Jungle Ruins — G minor expedition: marimba hooks, pan-flute lines and rolling toms. 136 bpm. */
const TRIBAL = {
  k: 'x.....x.x.....x.',
  t: '..l.m...l.m.h.m.',
  s: '....x.......x...',
  z: 'x.x.x.x.x.x.x.x.',
};

const INTRO: SectionDef = {
  bars: 4,
  chords: 'Gm | Gm | Eb | D7',
  counter: 'd5:6 g5:2 bb5:8 | a5:4 bb5:4 c6:4 a5:4 | g5:6 f5:2 eb5:8 | f#5:4 a5:4 d6:8',
  arp: '0.1.2.1.0.1.2.1.',
  bass: '1-------1-------',
  drums: { k: 'x.......x.......', t: 'l...l...l...m.m.' },
  fill: { t: 'l.l.m.m.h.h.hmhm', s: '............xxXX' },
};

const A: SectionDef = {
  bars: 8,
  chords: 'Gm | Eb | Bb | F | Gm | Eb | Cm D7 | Gm',
  lead:
    'g5:2 bb5 d6 g6 f6 d6 bb5 d6 | eb6:2 d6 bb5 g5 bb5:4 eb6:4 | d6:2 f6 d6 bb5 f5:4 bb5:4 | c6:2 a5 f5 a5 c6:8 | ' +
    'g5:2 bb5 d6 g6 a6 g6 f6 d6 | g6:2 f6 eb6 d6 eb6:4 bb5:4 | c6:2 eb6 g6 eb6 d6:2 f#6 a6 f#6 | g6:4 d6:2 bb5:2 g5:4 r:4',
  bass: '1..1..5.1..1..58',
  pad: 'hold',
  drums: TRIBAL,
  fill: { t: '........h.h.m.l.', s: '....x.......xxXX' },
  crash: true,
};

const B: SectionDef = {
  bars: 8,
  chords: 'Eb | F | Dm | Gm | Cm | F | Bb | D7',
  counter:
    'bb5:6 g5:2 eb6:8 | c6:6 a5:2 f5:8 | d6:4 f6:4 a6:4 f6:4 | g6:12 r:4 | ' +
    'eb6:6 d6:2 c6:8 | a5:6 c6:2 f6:8 | f6:4 d6:4 bb5:4 d6:4 | f#6:8 a5:4 c6:4',
  lead:
    'r:8 g5:2 bb5 eb6 bb5 | r:8 a5:2 c6 f6 c6 | r:8 f5:2 a5 d6 a5 | r:8 d6:2 bb5 g5 bb5 | ' +
    'r:8 eb5:2 g5 c6 g5 | r:8 f5:2 a5 c6 a5 | r:8 d6:2 f6 bb6 f6 | r:8 a5:2 c6 d6 f#6',
  bass: '1.......5...8...',
  pad: 'hold',
  drums: { k: 'x.......x.......', t: 'l.l.m.m.l.l.h.h.', r: '..x...x...x...x.' },
  fill: { t: 'l.l.m.m.h.h.HMHL', k: 'x...x...x...x...' },
  crash: true,
};

const A2: SectionDef = {
  ...A,
  counter: 'd5:8 bb4:8 | eb5:8 g5:8 | f5:8 d5:8 | f5:8 c5:8 | d5:8 g5:8 | g5:8 bb5:8 | eb5:8 f#5:8 | g5:8 d5:8',
  arp: '0.2.1.2.0.2.1.2.',
  drums: { ...TRIBAL, g: 'h.hl..h.h.hl..l.' },
};

const C: SectionDef = {
  bars: 4,
  chords: 'Cm | Gm | Eb | D7',
  lead: 'c6:2 eb6 g6 eb6 c6 g5 eb5 g5 | d6:2 g6 bb6 g6 d6 bb5 g5 bb5 | eb6:2 g6 bb6 g6 eb6 bb5 g5 bb5 | d6:2 f#6 a6 f#6 d6:4 a5:4',
  bass: '1-------5-------',
  drums: { k: 'x...x...x...x...', t: 'lmlhlmlhlmlhlmlh' },
  fill: { t: 'HHMMLLHHMMLLHMHL', s: '............XXXX' },
};

export const JUNGLE_RUINS: SongDef = {
  id: 'jungle-ruins',
  title: 'Temple of Vines',
  bpm: 136,
  tonic: 'g',
  mode: 'minor',
  chromatic: ['f#'],
  loop: true,
  instruments: { lead: 'marimba', counter: 'flute', bass: 'sub', pad: 'strings', arp: 'marimba', kit: 'tribal' },
  arpFloor: 55,
  sections: { INTRO, A, B, A2, C },
  intro: ['INTRO'],
  body: ['A', 'B', 'A2', 'C'],
};
