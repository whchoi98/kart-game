import type { SectionDef, SongDef } from '../pattern.js';

/** Lava Fortress — C minor siege: crunchy distorted lead, pounding kicks, dark choir. 160 bpm. */
const DRIVE = {
  k: 'x.x...x.x.x...x.',
  s: '....x.......x...',
  h: 'x.x.x.x.x.x.x.x.',
};

const INTRO: SectionDef = {
  bars: 4,
  chords: 'C5 | Ab | Bb | G',
  lead: 'c5:2 c5 eb5 c5 g5 c5 f5 eb5 | c5:2 c5 eb5 c5 ab5 c5 g5 eb5 | d5:2 d5 f5 d5 bb5 d5 ab5 f5 | b4:2 d5 g5 b5 d6:4 b5:4',
  bass: '1.1.1.1.1.1.1.1.',
  drums: { k: 'x...x...x...x...', h: 'x.x.x.x.x.x.x.x.' },
  fill: { s: '....x...x.x.XXXX', t: '........h.m.l.l.' },
  crash: true,
};

const A: SectionDef = {
  bars: 8,
  chords: 'Cm | Ab | Bb | G | Cm | Ab | Fm G | Cm',
  lead:
    'g5:4 c6:4 eb6:6 d6:2 | c6:4 ab5:4 eb5:8 | f5:2 bb5 d6 f6 eb6:4 d6:4 | d6:8 b5:4 g5:4 | ' +
    'g5:4 c6:4 eb6:4 g6:4 | ab6:6 g6:2 eb6:8 | f6:4 ab6:4 g6:4 f6:2 d6:2 | eb6:4 d6:2 c6:2 -:8',
  bass: '1.1.1.1.1.1.8.5.',
  pad: 'hold',
  drums: DRIVE,
  fill: { s: '....x.......xxXX', t: '..........h.m.l.' },
  crash: true,
};

const B: SectionDef = {
  bars: 8,
  chords: 'Ab | Bb | Gm | Cm | Ab | Bb | Fm | G',
  lead:
    'eb6:6 c6:2 ab5:8 | f6:6 d6:2 bb5:8 | g6:4 f6:4 d6:4 bb5:4 | c6:6 d6:2 eb6:8 | ' +
    'ab5:2 c6 eb6 ab6 g6:4 eb6:4 | bb5:2 d6 f6 bb6 ab6:4 f6:4 | c6:2 f6 ab6 f6 c6:4 ab5:4 | b5:4 d6:4 g6:4 b6:4',
  bass: '1.1.8.1.1.1.8.5.',
  arp: '0.1.2.1.0.1.2.1.',
  pad: 'hold',
  drums: { k: 'x.x.x.x.x.x.x.x.', s: '....x.......x...', o: '..x...x...x...x.' },
  fill: { s: '....x...xxxxXXXX', k: 'x.x.x.x.x.x.x.x.' },
  crash: true,
};

const A2: SectionDef = {
  ...A,
  counter: 'eb5:8 g5:8 | eb5:8 c5:8 | d5:8 f5:8 | b4:8 d5:8 | eb5:8 g5:8 | c5:8 eb5:8 | c5:8 b4:8 | c5:8 g4:8',
  arp: '0120 1201 0120 1232',
  drums: { ...DRIVE, h: 'x.xxx.xxx.xxx.xx' },
};

const C: SectionDef = {
  bars: 4,
  chords: 'Fm | Ab | Db | G',
  lead: 'ab5:6 g5:2 f5:8 | c6:6 bb5:2 ab5:8 | db6:4 f6:4 ab6:4 f6:4 | g6:4 f6:4 d6:4 b5:4',
  bass: '1-------1-------',
  pad: 'hold',
  drums: { k: 'x.......x.......', t: 'l...l...l...l.l.' },
  fill: { k: 'x.x.x.x.x.x.x.x.', s: 'x.x.x.x.xxxxXXXX', t: 'L...............' },
};

export const LAVA_FORTRESS: SongDef = {
  id: 'lava-fortress',
  title: 'Magma Bastion',
  bpm: 160,
  tonic: 'c',
  mode: 'minor',
  chromatic: ['b', 'db'],
  loop: true,
  instruments: { lead: 'dist', counter: 'brass', bass: 'dist', pad: 'choir', arp: 'saw', kit: 'heavy' },
  arpFloor: 60,
  sections: { INTRO, A, B, A2, C },
  intro: ['INTRO'],
  body: ['A', 'B', 'A2', 'C'],
};
