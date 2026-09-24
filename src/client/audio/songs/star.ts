import type { SectionDef, SongDef } from '../pattern.js';

/** Super Star power-up layer — a hyper, sparkling 4-bar G major loop at 180 bpm. */
const LOOP: SectionDef = {
  bars: 4,
  chords: 'G | C | G | D',
  lead: 'g5:1 g5 b5 d6 g6:2 d6 b5 d6 g6:4 | e6:1 e6 g6 e6 c6:2 e6 g6:4 c7:4 | d6:1 d6 g6 d6 b5:2 d6 g6:4 b6:4 | a6:2 f#6 d6 a5 f#6 a6 d7:4',
  bass: '1.8.1.8.1.8.1.8.',
  arp: '0123 0123 0123 0123',
  drums: { k: 'x...x...x...x...', s: '....x.......x...', h: 'xxxxxxxxxxxxxxxx' },
  fill: { s: '....x.......xxxx' },
  crash: true,
};

export const STAR: SongDef = {
  id: 'star',
  title: 'Invincible Sparkle',
  bpm: 180,
  tonic: 'g',
  mode: 'major',
  loop: true,
  instruments: { lead: 'square', bass: 'tri', pad: 'soft', arp: 'sparkle', kit: 'pop' },
  arpFloor: 67,
  sections: { LOOP },
  intro: [],
  body: ['LOOP'],
  mix: { lead: 0.8, arp: 0.5 },
};
