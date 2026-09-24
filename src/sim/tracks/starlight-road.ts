import type { TrackDef } from '../types.js';

const P = (x: number, y: number, z: number, w?: number, bank?: number) => ({ p: [x, y, z] as [number, number, number], w, bank });

/**
 * Thunder Cup 4 — Starlight Road (final).
 * A figure-eight ribbon floating in space with no railings: launch under the sky
 * bridge, climb a banked sweeper to the summit hairpin, take the comet jump, dive
 * through the second banked sweeper and jump the sky bridge right over the launch
 * deck (≈ 20 m below), then run the meteor shower and the nebula double hairpin.
 * Barriers only at the two tight hairpin complexes and through the meteor belt (so a
 * meteor hit never flings a kart into space); everything else is open space.
 */
export const starlightRoad: TrackDef = {
  id: 'starlight-road',
  name: '별빛 은하 로드',
  nameEn: 'Starlight Road',
  cup: 'thunder',
  order: 4,
  theme: 'galaxy',
  laps: 3,
  halfWidth: 10,
  shoulder: 6,
  defaultEdge: 'pit',
  startAt: 47.4,
  points: [
    // 0: Launch deck exit (under the sky bridge)
    P(0, 4, 0, 11),
    P(25.7, 4.7, -25.7, 11),
    // 2: Banked right sweeper, climbing
    P(51.3, 5.5, -51.3, undefined, 0.05),
    P(74.6, 7.6, -68.4, undefined, 0.1),
    P(102, 9.8, -77.7, undefined, 0.1),
    P(130.9, 12, -78.3, undefined, 0.1),
    // 6: Star climb
    P(158.7, 14.2, -70.3, undefined, 0.05),
    P(194.9, 19, -53.3),
    P(231.2, 23.8, -36.4),
    // 9: Summit hairpin (walled)
    P(267.5, 28.6, -19.5, 9.5),
    P(280.1, 29.2, -9.4, 9.5),
    P(286.6, 29.9, 5.4, 9.5),
    P(285.6, 30.5, 21.5, 9.5),
    // 13: Summit — comet jump
    P(277.2, 31.2, 35.4, 9.5),
    P(262, 31.3, 50.6),
    P(246.8, 31.4, 65.8),
    P(231.6, 31.5, 81),
    // 17: Banked right sweeper, diving
    P(216.4, 31.6, 96.2, undefined, 0.06),
    P(188.8, 30.4, 114.6, undefined, 0.12),
    P(156.3, 29.3, 121.1, undefined, 0.12),
    P(123.7, 28.1, 114.6, undefined, 0.12),
    // 21: Sky bridge over the launch deck (jump)
    P(96.2, 26.9, 96.2, undefined, 0.06),
    P(72.1, 26.2, 72.1),
    P(48.1, 25.5, 48.1),
    P(24, 24.7, 24),
    // 25: skyExit
    P(0, 24, 0),
    P(-21.2, 22.8, -21.2),
    // 27: Banked left sweeper, descending
    P(-42.4, 21.6, -42.4, undefined, -0.06),
    P(-68, 20.3, -60.4, undefined, -0.12),
    P(-98.2, 19.1, -68.4, undefined, -0.12),
    P(-129.4, 17.8, -65.7, undefined, -0.12),
    // 31: Meteor field
    P(-157.7, 16.6, -52.5, undefined, -0.06),
    P(-187.6, 15.3, -31.6, 11),
    P(-217.5, 14, -10.6, 11),
    // 34: Nebula double hairpin (walled)
    P(-247.5, 12.7, 10.4, 9.5),
    P(-258.8, 12.6, 23.8, 9.5),
    // 36: hpMid
    P(-261.8, 12.4, 41.2, 9.5),
    // 37: hp3
    P(-259.6, 12.1, 67.1, 9.5),
    P(-253.6, 11.9, 83.6, 9.5),
    // 39: run2
    P(-240.1, 11.8, 94.9, 9.5),
    P(-217.5, 11.3, 105.4),
    // 41: Banked left sweeper onto the launch deck
    P(-195, 10.8, 115.9, undefined, -0.05),
    P(-170.2, 10.3, 123.2, undefined, -0.1),
    P(-144.3, 9.7, 122.6, undefined, -0.1),
    P(-119.9, 9.2, 114.3, undefined, -0.1),
    // 45: Launch deck (start/finish)
    P(-99, 8.7, 99, undefined, -0.05),
    P(-74.2, 7.5, 74.2, 11),
    P(-49.5, 6.3, 49.5, 11),
    P(-24.7, 5.2, 24.7, 11),
  ],
  edges: [
    { from: 5.586, to: 13.651, side: 'both', kind: 'wall' }, // summit hairpin — walled for fairness
    { from: 31.602, to: 39.402, side: 'both', kind: 'wall' }, // asteroid-belt barriers through the meteor shower and the nebula double hairpin
  ],
  itemRows: [
    { at: 4.412, count: 5 }, // climbing sweeper
    { at: 16.535, count: 5 }, // summit, after the comet jump
    { at: 26.3, count: 4 }, // past the sky-bridge crossover (railing-less: 4 boxes kept near the centre)
    { at: 40.046, count: 5 }, // nebula exit
  ],
  boostPads: [
    { at: 6.599, d: 0 }, // up the star climb
    { at: 21.824, d: 0 }, // run-up to the sky-bridge jump
    { at: 31.219, d: -3 },
    { at: 45.571, d: 3 },
  ],
  ramps: [
    { at: 14.023, length: 16, height: 2.6, trick: true }, // comet jump off the summit
    { at: 22.235, length: 14, height: 2.2, trick: true }, // sky-bridge jump over the launch deck
  ],
  coins: [
    { at: 0.11, d: 0, count: 5, spacing: 4 },
    { at: 2.689, d: 4, count: 6, spacing: 5 }, // inside of the climbing sweeper
    { at: 15.047, d: 0, count: 6, spacing: 4 }, // on the comet line
    { at: 18.198, d: 4.5, count: 6, spacing: 5 },
    { at: 27.955, d: -4.5, count: 6, spacing: 5 },
    { at: 36.077, d: 0, count: 5 },
    { at: 42.156, d: -4, count: 5, spacing: 5 },
  ],
  movers: [
    { kind: 'sweep', at: 32.204, d: -4, amplitude: 3.5, period: 4.5, phase: 3.14, radius: 1.6, look: 'meteor' }, // meteor shower (walled belt, descending): left lane
    { kind: 'sweep', at: 33.299, d: 4, amplitude: 3.5, period: 4.5, phase: 3.14, radius: 1.6, look: 'meteor' }, // right lane
  ],
  landmarks: [
    { kind: 'grandstand', at: 46.886, side: 'left', dist: 30 },
    { kind: 'grandstand', at: 46.886, side: 'right', dist: 30 },
    { kind: 'banner', at: 48.2, side: 'over', dist: 0 },
    { kind: 'planet', at: 4.068, side: 'left', dist: 150, scale: 2.4 },
    { kind: 'ring-gate', at: 6.999, side: 'over', dist: 0 },
    { kind: 'space-station', at: 12.064, side: 'right', dist: 60, scale: 1.3 },
    { kind: 'arch', at: 13.186, side: 'over', dist: 0 },
    { kind: 'comet', at: 18.798, side: 'left', dist: 90, scale: 1.5 },
    { kind: 'ring-gate', at: 21.588, side: 'over', dist: 0, scale: 1.2 },
    { kind: 'asteroid', at: 28.91, side: 'right', dist: 50 },
    { kind: 'asteroid', at: 32.916, side: 'left', dist: 40, scale: 0.8 },
    { kind: 'planet', at: 36.385, side: 'right', dist: 110, scale: 1.4 },
    { kind: 'space-station', at: 40.61, side: 'right', dist: 45, scale: 0.8 },
  ],
  music: { bpm: 146, key: 'Eb', mood: 'cosmic' },
  scenerySeed: 8404,
  parLap: 45,
};
