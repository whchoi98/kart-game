import type { SectionDef, SongDef } from '../pattern.js';

/** Game over — a short, gentle "try again" sting: minor descent resolving to a warm major chord. */
const STING: SectionDef = {
  bars: 2,
  chords: 'Ab Fm | G C',
  lead: 'c6:4 eb6:2 c6:2 ab5:4 f5:4 | g5:2 f5 eb5 d5 c5:8',
  counter: 'ab5:8 f5:8 | b4:8 e5:8',
  bass: '1-------1-------',
  pad: 'hold',
  drums: { t: '........l.......', k: 'x...............' },
  fill: { t: 'h.m.l...........', x: '........x.......' },
};

export const GAMEOVER: SongDef = {
  id: 'gameover',
  title: 'Try Again',
  bpm: 100,
  tonic: 'c',
  mode: 'minor',
  chromatic: ['b', 'e'],
  loop: false,
  instruments: { lead: 'square', counter: 'thin', bass: 'tri', pad: 'soft', arp: 'bell', kit: 'pop' },
  sections: { STING },
  intro: [],
  body: ['STING'],
};
