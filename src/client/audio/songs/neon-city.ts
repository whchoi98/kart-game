import type { SectionDef, SongDef } from '../pattern.js';

/** Neon City Nights — funky synthwave in A minor, octave-popping bass and gliding saw lead. 124 bpm. */
const BEAT = {
  k: 'x...x...x...x...',
  s: '....x.......x...',
  c: '....x.......x...',
  h: 'x.x.x.x.x.x.x.x.',
  o: '..x...x...x...x.',
};

const INTRO: SectionDef = {
  bars: 4,
  chords: 'Am7 | Fmaj7 | C | G',
  lead: 'r:16 | r:16 | r:8 e5:4 g5:4 | a5:4 b5:4 ~d6:8',
  arp: '0123 2103 0123 2103',
  bass: '1-------1-------',
  pad: 'hold',
  drums: { k: 'x...x...x...x...', h: '..x...x...x...x.' },
  fill: { s: '....x...x.x.xxXX', c: '............x...' },
};

const A: SectionDef = {
  bars: 8,
  chords: 'Am7 | Fmaj7 | C | G | Am7 | Fmaj7 | C G | Am7',
  lead:
    'a5:3 c6:3 e6:4 d6:2 c6:2 a5:2 | c6:6 a5:2 ~e6:8 | g5:3 c6:3 e6:4 f6:2 e6:2 c6:2 | d6:6 b5:2 g5:8 | ' +
    'a5:3 c6:3 e6:4 g6:2 e6:2 a6:2 | g6:4 f6:2 e6:2 c6:8 | e6:4 c6:4 d6:4 b5:4 | a5:8 r:4 e5:2 g5:2',
  bass: '1.8.1.81.18.1.58',
  pad: 'hold',
  drums: BEAT,
  fill: { s: '....x.......x.xx', t: '..........h.m.l.' },
  crash: true,
};

const B: SectionDef = {
  bars: 8,
  chords: 'Dm7 | Em7 | Fmaj7 | G | Dm7 | Em7 | Fmaj7 | E7',
  lead:
    'f5:2 a5 c6 f6 -:4 e6:2 d6:2 | g5:2 b5 d6 g6 -:4 e6:2 d6:2 | a5:2 c6 e6 a6 -:4 g6:2 e6:2 | g6:6 f6:2 d6:8 | ' +
    'd6:3 f6:3 a6:2 g6:4 f6:4 | e6:3 g6:3 b6:2 a6:4 g6:4 | a6:4 g6:4 f6:4 e6:4 | g#6:6 e6:2 b5:4 d6:4',
  bass: '1.8..81.1.8..858',
  arp: '0.1.2.3.2.1.0.1.',
  pad: 'hold',
  drums: { ...BEAT, h: 'xxxxxxxxxxxxxxxx' },
  fill: { s: '....x...x.x.XXXX' },
};

const A2: SectionDef = {
  ...A,
  counter: 'e5:8 g5:8 | c5:8 e5:8 | e5:8 g5:8 | d5:8 b4:8 | e5:8 g5:8 | a5:8 e5:8 | g5:8 g5:8 | e5:8 c5:8',
  arp: '0120 3210 0120 3210',
};

const C: SectionDef = {
  bars: 4,
  chords: 'Fmaj7 | G | Em7 | E7',
  lead: 'c6:6 e6:2 a6:8 | g6:6 d6:2 b5:8 | e6:4 g6:4 b6:4 g6:4 | g#5:4 b5:4 d6:4 e6:4',
  arp: '0123 4321 0123 4321',
  bass: '1-----1-8-----8-',
  pad: 'hold',
  drums: { k: 'x.......x.......', c: '....x.......x...', z: 'x.xxx.xxx.xxx.xx' },
  fill: { k: 'x...x...x...x...', s: 'x.x.x.x.xxxxXXXX' },
};

export const NEON_CITY: SongDef = {
  id: 'neon-city',
  title: 'Midnight Overdrive',
  bpm: 124,
  tonic: 'a',
  mode: 'minor',
  chromatic: ['g#'],
  swing: 0.06,
  loop: true,
  instruments: { lead: 'synth', counter: 'square', bass: 'funk', pad: 'soft', arp: 'saw', kit: 'electro' },
  arpFloor: 57,
  sections: { INTRO, A, B, A2, C },
  intro: ['INTRO'],
  body: ['A', 'B', 'A2', 'C'],
};
