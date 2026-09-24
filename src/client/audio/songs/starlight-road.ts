import type { SectionDef, SongDef } from '../pattern.js';

/** Starlight Road — E-flat lydian space anthem: shimmering 16th arps, soaring pulse lead. 146 bpm. */
const PULSE = {
  k: 'x...x...x...x...',
  s: '....x.......x...',
  h: '..x...x...x...x.',
  z: 'x.xxx.xxx.xxx.xx',
};

const INTRO: SectionDef = {
  bars: 4,
  chords: 'Ebmaj7 | F/Eb | Ebmaj7 | F/Eb',
  counter: 'g5:4 bb5:4 d6:8 | a5:4 c6:4 f6:8 | bb5:4 d6:4 g6:8 | c6:4 f6:4 a6:8',
  arp: '0123 4321 0123 4321',
  bass: '1---------------',
  pad: 'hold',
  fill: { k: 'x...x...x...x...', s: '........x.x.xxXX' },
};

const A: SectionDef = {
  bars: 8,
  chords: 'Eb | F/Eb | Cm7 | Bb | Eb | F/Eb | Gm7 F | Bbsus4 Bb',
  lead:
    'bb5:4 g5:2 bb5:2 eb6:6 d6:2 | c6:4 a5:2 c6:2 f6:8 | eb6:4 d6:2 c6:2 g5:4 bb5:4 | d6:6 c6:2 bb5:8 | ' +
    'bb5:2 eb6 g6 bb6 -:4 a6:2 g6:2 | a6:6 f6:2 c6:8 | d6:4 bb5:4 c6:4 a5:4 | eb6:8 d6:8',
  arp: '0123 2101 0123 2101',
  bass: '1.8.1.8.1.8.5.8.',
  pad: 'hold',
  drums: PULSE,
  fill: { s: '....x.......x.xx' },
  crash: true,
};

const B: SectionDef = {
  bars: 8,
  chords: 'Cm7 | Dm7 | Ebmaj7 | F | Gm7 | Dm7 | Ebmaj7 | F',
  lead:
    'g5:2 bb5 eb6 g6 f6:4 eb6:4 | a5:2 c6 f6 a6 g6:4 f6:4 | bb5:2 d6 g6 bb6 a6:4 g6:4 | a6:8 f6:4 c6:4 | ' +
    'bb6:6 a6:2 g6:8 | f6:6 d6:2 a5:8 | g6:4 bb6:4 d6:4 g6:4 | a6:6 g6:2 f6:4 c6:4',
  arp: '0246 4202 0246 4202',
  bass: '1---8---5---8---',
  pad: 'hold',
  drums: { ...PULSE, c: '....x.......x...', o: '..x...x...x...x.' },
  fill: { s: '....x...x.x.XXXX', t: '..........h.m.l.' },
  crash: true,
};

const A2: SectionDef = {
  ...A,
  counter: 'g5:8 bb5:8 | a5:8 c6:8 | g5:8 eb5:8 | f5:8 d5:8 | g5:8 bb5:8 | a5:8 f5:8 | bb5:8 a5:8 | f5:8 f5:8',
  arp: '0123 4567 7654 3210',
};

const C: SectionDef = {
  bars: 4,
  chords: 'Ebmaj7 | F/Eb | Dm7 | Bbsus4 Bb',
  lead: 'd6:16 | c6:8 a6:8 | a6:8 f6:8 | f6:8 d6:8',
  arp: '0246 8642 0246 8642',
  bass: '1-------8-------',
  pad: 'hold',
  drums: { z: 'x.xxx.xxx.xxx.xx', k: 'x.......x.......' },
  fill: { k: 'x...x...x...x...', s: 'x.x.x.x.xxxxXXXX' },
};

export const STARLIGHT_ROAD: SongDef = {
  id: 'starlight-road',
  title: 'Aurora Highway',
  bpm: 146,
  tonic: 'eb',
  mode: 'lydian',
  loop: true,
  instruments: { lead: 'pulse', counter: 'bell', bass: 'saw', pad: 'strings', arp: 'sparkle', kit: 'electro' },
  arpFloor: 63,
  sections: { INTRO, A, B, A2, C },
  intro: ['INTRO'],
  body: ['A', 'B', 'A2', 'C'],
};
