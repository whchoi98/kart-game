import type { TrackDef } from '../types.js';

const P = (x: number, y: number, z: number, w?: number, bank?: number) => ({ p: [x, y, z] as [number, number, number], w, bank });

/**
 * Thunder Cup 3 — Lava Fortress.
 * Cross the railing-less lava bridge into the gatehouse chicane, dodge lava blobs
 * leaping over the walled channel, then climb the banked spiral around the great
 * tower — the road passes over its own first loop — and run the ramparts. Descend
 * over the second lava bridge, snake through the lower courtyard and launch over
 * the lava moat (clears even at 50cc) back to the outer bailey.
 */
export const lavaFortress: TrackDef = {
  id: 'lava-fortress',
  name: '용암 요새',
  nameEn: 'Lava Fortress',
  cup: 'thunder',
  order: 3,
  theme: 'volcano',
  laps: 3,
  halfWidth: 9.5,
  shoulder: 6,
  defaultEdge: 'wall',
  startAt: 2,
  points: [
    // 0: Outer bailey (start/finish)
    P(0, 0, 0),
    P(33, 0, 0),
    P(66, 0, 0),
    P(99, 0, 0),
    // 4: T1 — left onto the lava bridge
    P(132, 0, 0),
    P(150, 0, -4.8),
    P(163.2, 0, -18),
    // 7: Lava bridge 1 (no railings)
    P(168, 0, -36, 8.5),
    P(168, 0, -76, 8.5),
    // 9: East gate
    P(168, 0, -116, 8.5),
    // 10: Gatehouse chicane: left
    P(168, 0, -138),
    P(163.4, 0, -155),
    // 12: chanMid
    P(151, 0, -167.4),
    // 13: Gatehouse chicane: right
    P(125, 0, -182.4),
    P(112.6, 0, -194.9),
    // 15: Lava channel (blobs leap across)
    P(108, 0, -211.9),
    P(108, 0, -242.6),
    P(108, 0, -273.2),
    // 18: Right kink
    P(108, 0, -303.9),
    P(110.7, 0, -324.6),
    // 20: preT2
    P(118.7, 0, -343.9),
    // 21: T2 — left into the keep
    P(131.7, 0, -366.4),
    P(136.3, 0, -383.4),
    P(131.7, 0, -400.4),
    P(119.3, 0, -412.9),
    // 25: Keep courtyard
    P(102.3, 0, -417.4),
    P(62.3, 0, -417.4),
    P(22.3, 0, -417.4),
    P(-17.8, 0, -417.4),
    // 29: Banked climbing spiral around the tower (passes over itself)
    P(-57.8, 0, -417.4, undefined, 0.06),
    P(-77.8, 0.9, -412, undefined, 0.12),
    P(-92.4, 1.9, -397.4, undefined, 0.12),
    P(-97.8, 2.8, -377.4, undefined, 0.12),
    P(-92.4, 3.7, -357.4, undefined, 0.12),
    P(-77.8, 4.6, -342.8, undefined, 0.12),
    P(-57.8, 5.6, -337.4, undefined, 0.12),
    P(-37.8, 6.5, -342.8, undefined, 0.12),
    P(-23.1, 7.4, -357.4, undefined, 0.12),
    P(-17.8, 8.4, -377.4, undefined, 0.12),
    P(-23.1, 9.3, -397.4, undefined, 0.12),
    P(-37.8, 10.2, -412, undefined, 0.12),
    P(-57.8, 11.1, -417.4, undefined, 0.12),
    P(-77.8, 12.1, -412, undefined, 0.12),
    // 43: Rampart (high)
    P(-92.4, 13, -397.4, undefined, 0.06),
    // 44: Rampart kink (left)
    P(-110.4, 13, -366.2),
    // 45: Lava bridge 2 (descending, no railings)
    P(-118.4, 12.5, -336.2, 9),
    P(-118.4, 10.2, -304.2, 9),
    // 47: Lower courtyard
    P(-118.4, 7.8, -272.2, 9),
    // 48: Courtyard S: left
    P(-118.4, 6.4, -260.8),
    P(-113.6, 6, -242.8),
    // 50: c3mid
    P(-100.4, 5.6, -229.6),
    // 51: Courtyard S: fast right
    P(-71, 5.1, -212.6),
    P(-52.4, 4.9, -197),
    P(-40.2, 4.6, -175.9),
    // 54: Moat jump run-up
    P(-36, 4.4, -152),
    P(-36, 4.3, -135.3),
    P(-36, 4.2, -118.7),
    // 57: Over the lava moat
    P(-36, 4.1, -102),
    // 58: landing
    P(-36, 2.7, -72),
    // 59: T3 — left onto the start straight
    P(-36, 1.1, -36),
    P(-31.2, 0.7, -18),
    P(-18, 0.4, -4.8),
  ],
  edges: [
    { from: 7, to: 9, side: 'both', kind: 'pit' }, // lava bridge 1 — no railings
    { from: 45.063, to: 47, side: 'both', kind: 'pit' }, // lava bridge 2 — no railings
    { from: 56.82, to: 57.267, side: 'both', kind: 'pit' }, // open lava moat under the jump
  ],
  itemRows: [
    { at: 9.455, count: 5 }, // east gate
    { at: 28, count: 5 }, // keep courtyard, before the spiral
    { at: 43.389, count: 5 }, // rampart top
    { at: 53.6, count: 5 }, // courtyard exit, ahead of the moat jump
  ],
  boostPads: [
    { at: 25.75, d: 0 }, // into the spiral
    { at: 17.739, d: 3 },
    { at: 54.72, d: 0 }, // run-up to the moat jump
  ],
  ramps: [
    { at: 26.749, length: 12, height: 1.6, trick: true }, // drawbridge kicker
    { at: 55.8, length: 16, height: 3, trick: true }, // moat jump
  ],
  coins: [
    { at: 2.727, d: 3.5, count: 5 },
    { at: 7.25, d: 0, count: 8, spacing: 7 }, // centre line of the lava bridge
    { at: 12.067, d: 0, count: 5 },
    { at: 31.865, d: -5.5, count: 6, spacing: 5 }, // inside of the spiral
    { at: 38.549, d: -5.5, count: 6, spacing: 5 },
    { at: 45.375, d: 0, count: 7, spacing: 7 },
    { at: 58.111, d: 0, count: 5 },
  ],
  movers: [
    { kind: 'sweep', at: 15.717, d: -3, amplitude: 4.5, period: 6, phase: 0, radius: 1.5, look: 'lava' }, // lava blob leaping across the channel
    { kind: 'sweep', at: 16.826, d: 0, amplitude: 6, period: 5.5, phase: 2.36, radius: 1.5, look: 'lava' },
    { kind: 'sweep', at: 48.136, d: 3.5, amplitude: 4.5, period: 6, phase: 1.2, radius: 1.5, look: 'lava' }, // blob in the lower courtyard (downhill)
  ],
  landmarks: [
    { kind: 'grandstand', at: 1.697, side: 'right', dist: 26 },
    { kind: 'grandstand', at: 2.424, side: 'left', dist: 26 },
    { kind: 'banner', at: 3.152, side: 'over', dist: 0 },
    { kind: 'volcano', at: 8, side: 'right', dist: 170, scale: 2.4 },
    { kind: 'gate', at: 9.364, side: 'over', dist: 0 },
    { kind: 'lava-fall', at: 16.304, side: 'right', dist: 24 },
    { kind: 'spike', at: 18.955, side: 'left', dist: 22 },
    { kind: 'fortress-tower', at: 26, side: 'right', dist: 30, scale: 0.8 },
    { kind: 'fortress-tower', at: 30.432, side: 'left', dist: 40, scale: 1.6 },
    { kind: 'gate', at: 43.111, side: 'over', dist: 0 },
    { kind: 'chain-bridge', at: 46.094, side: 'over', dist: 0 },
    { kind: 'lava-fall', at: 49.061, side: 'right', dist: 30 },
    { kind: 'spike', at: 51.655, side: 'left', dist: 24 },
    { kind: 'arch', at: 58.333, side: 'over', dist: 0 },
  ],
  music: { bpm: 160, key: 'Cm', mood: 'intense' },
  scenerySeed: 7303,
  parLap: 44,
};
