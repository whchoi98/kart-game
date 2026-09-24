import type { SectionDef, SongDef } from '../pattern.js';

/** Podium — majestic B-flat major brass fanfare, then a proud looping march. 112 bpm. */
const FANFARE: SectionDef = {
  bars: 4,
  chords: 'Bb | Eb/Bb | F/Bb | Bb',
  lead: 'f5:2 f5 f5 bb5:6 d6:4 | eb6:2 eb6 eb6 g6:6 eb6:4 | c6:2 c6 c6 f6:6 a6:4 | bb6:12! r:4',
  counter: 'd5:2 d5 d5 f5:6 bb5:4 | g5:2 g5 g5 bb5:6 g5:4 | a5:2 a5 a5 c6:6 f6:4 | f6:12 r:4',
  bass: '1-----1-1-----1-',
  pad: 'hold',
  drums: { t: 'l.....l.l.....l.', k: 'x.......x.......' },
  fill: { t: 'l.l.l.l.LLLLLLLL', s: '............XXXX' },
  crash: true,
};

const MARCH: SectionDef = {
  bars: 8,
  chords: 'Bb | Gm | Eb | F | Bb | Gm | Eb F | Bb',
  lead:
    'd6:6 c6:2 bb5:4 f5:4 | g5:6 a5:2 bb5:8 | g5:4 bb5:4 eb6:6 d6:2 | c6:12 r:4 | ' +
    'd6:6 eb6:2 f6:4 d6:4 | g6:6 f6:2 d6:8 | eb6:4 g6:4 f6:4 a6:4 | bb6:8 f6:4 d6:4',
  bass: '1...5...1...5...',
  arp: '0.1.2.1.0.1.2.1.',
  pad: 'hold',
  drums: { k: 'x.......x.......', s: '....x..o....x.oo', t: '..............l.' },
  fill: { s: '....x...x.x.XXXX' },
  crash: true,
};

export const PODIUM: SongDef = {
  id: 'podium',
  title: 'Golden Trophy March',
  bpm: 112,
  tonic: 'bb',
  mode: 'major',
  loop: true,
  instruments: { lead: 'brass', counter: 'brass', bass: 'saw', pad: 'strings', arp: 'bell', kit: 'rock' },
  arpFloor: 65,
  sections: { FANFARE, MARCH },
  intro: ['FANFARE'],
  body: ['MARCH'],
};
