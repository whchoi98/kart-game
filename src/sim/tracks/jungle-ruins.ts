import type { TrackDef } from '../types.js';

const P = (x: number, y: number, z: number, w?: number, bank?: number) => ({ p: [x, y, z] as [number, number, number], w, bank });

/**
 * Thunder Cup 2 — Jungle Ruins.
 * A winding run through temple ruins: jump off the top step of the temple plaza,
 * drop into the gorge and cross the railing-less rope bridge beside the waterfall,
 * dodge logs rolling down the ruins avenue, swing round the long hairpin by the falls,
 * climb beside them and flick through the fast mud-flat esses (mud lies off the racing
 * line) back to the village.
 */
export const jungleRuins: TrackDef = {
  id: 'jungle-ruins',
  name: '정글 유적',
  nameEn: 'Jungle Ruins',
  cup: 'thunder',
  order: 2,
  theme: 'jungle',
  laps: 3,
  halfWidth: 9.5,
  shoulder: 8,
  defaultEdge: 'offroad',
  startAt: 1.745,
  points: [
    // 0: Village clearing (start/finish)
    P(0, 3, 0),
    P(36.7, 2.8, 0),
    P(73.3, 2.6, 0),
    // 3: T1 — left into the jungle
    P(110, 2.3, 0),
    P(127, 2.2, -4.6),
    P(139.4, 2.1, -17),
    // 6: jungle1
    P(144, 2, -34),
    // 7: Right sweeper to the temple
    P(144, 1.8, -64, undefined, 0.03),
    P(149.7, 1.7, -92.7, undefined, 0.06),
    // 9: Temple plaza — trick ramp off the top step
    P(166, 1.5, -117, undefined, 0.03),
    P(185.1, 1.3, -136.1),
    // 11: Down the temple steps into the gorge
    P(204.2, 1.2, -155.2),
    // 12: T3 — right to the river
    P(233.8, -3.2, -184.9),
    P(246.9, -3.4, -192.8),
    P(262, -3.6, -193.8),
    P(276, -3.8, -187.7),
    // 16: bank
    P(285.5, -4, -175.8),
    // 17: Rope bridge over the river (no railings)
    P(293.9, -4.1, -157.7, 10),
    P(305.8, -4.2, -132.3, 10),
    // 19: bridgeExit
    P(317.6, -4.4, -106.9, 10),
    // 20: T4 — left into the ruins
    P(326, -4.5, -88.8),
    P(334.6, -4.5, -78),
    P(347.2, -4.6, -72.1),
    // 23: Ruins avenue (rolling logs)
    P(361, -4.7, -72.5),
    P(379.7, -4.8, -77.5),
    P(398.4, -4.9, -82.5),
    // 26: T5 — long right hairpin by the falls. Kept to a gentle ~4% grade: a steep climb
    // inside a tight corner makes karts skip off the inside of the road.
    P(417, -5.1, -87.5),
    P(432.6, -4.5, -87.5),
    P(446, -3.9, -79.8),
    P(453.8, -3.3, -66.3),
    P(453.8, -2.7, -50.8),
    // 31: Falls run — the real climb, on the (almost) straight exit beside the falls
    P(446, -1.8, -37.3),
    // 32: Snake: fast left kink (crest)
    P(416.3, 2.2, -7.6),
    P(401.1, 3.3, 15.1),
    // 34: snakeMid
    P(395.8, 4, 41.9),
    // 35: Snake: right
    P(395.8, 4.3, 71.9),
    P(391.7, 4.35, 88),
    P(380.5, 4.4, 100.3),
    // 38: Mud flats — fast esses between mud pools (flat out, mud on the outside of each bend)
    P(364.8, 4.45, 105.7),
    P(326.8, 4.45, 107.5),
    P(289.5, 4.4, 99.5),
    P(251.5, 4.35, 106.5),
    P(213.5, 4.3, 121.5),
    P(175.1, 4.25, 127.5),
    // 44: Mud flats kink (left)
    P(137.1, 4.2, 125.7),
    P(118, 4.2, 129.7),
    // 46: mudMid
    P(100.5, 4.15, 138.3),
    // 47: Mud flats kink (right)
    P(72, 4.15, 156.8),
    P(54.5, 4.1, 165.3),
    // 49: mud2
    P(35.4, 4.1, 169.4),
    // 50: T6 — right
    P(5.5, 4, 172),
    P(-11.8, 3.9, 168.9),
    P(-25.3, 3.8, 157.6),
    // 53: return
    P(-31.3, 3.7, 141.1),
    P(-34.2, 3.6, 108.6),
    P(-37, 3.4, 76),
    // 56: T7 — right onto the start straight
    P(-39.8, 3.3, 43.5),
    P(-37.9, 3.2, 27.1),
    P(-29.5, 3.1, 13),
    P(-16.1, 3.1, 3.4),
  ],
  edges: [
    { from: 11.19, to: 13.953, side: 'both', kind: 'wall' }, // temple stair walls
    { from: 16.2, to: 17, side: 'both', kind: 'wall' }, // bridge abutment
    { from: 17, to: 19, side: 'both', kind: 'pit' }, // rope bridge — no railings
    { from: 19, to: 19.8, side: 'both', kind: 'wall' }, // bridge abutment
    { from: 23, to: 26, side: 'both', kind: 'wall' }, // ruin walls along the avenue
  ],
  surfaces: [
    { from: 3.786, to: 6.333, dFrom: 5.6, dTo: 9.5, kind: 'mud' }, // T1 exit puddle (outside)
    { from: 31.19, to: 31.952, dFrom: 5.2, dTo: 9.5, kind: 'mud' }, // splash zone by the falls
    { from: 39.85, to: 40.55, dFrom: 5.4, dTo: 9.5, kind: 'mud' }, // mud pool on the outside of the esses' left bend
    { from: 44.307, to: 46.882, dFrom: 4.8, dTo: 9.5, kind: 'mud' }, // mud flats, outside of the kink
    { from: 46.294, to: 48.739, dFrom: -9.5, dTo: -4.8, kind: 'mud' }, // mud flats, outside of the kink
    { from: 50.899, to: 52.809, dFrom: -9.5, dTo: -5.5, kind: 'mud' }, // T6 outside
  ],
  itemRows: [
    { at: 8.019, count: 5 },
    { at: 19.3, count: 4 },
    { at: 34.333, count: 5 },
    { at: 53.429, count: 5 },
  ],
  boostPads: [
    { at: 9.519, d: 0 }, // run-up to the temple jump
    { at: 31.476, d: -2.5 },
    { at: 49.333, d: 2.5 },
  ],
  ramps: [
    { at: 10.407, length: 14, height: 2.2, trick: true }, // off the top step of the temple
    { at: 46.118, length: 10, height: 1.2 }, // root hump
  ],
  coins: [
    { at: 2.345, d: -4, count: 5 },
    { at: 6.2, d: 3.5, count: 5 },
    { at: 17.286, d: 0, count: 8, spacing: 5 }, // centre of the rope bridge
    { at: 23.31, d: 5, count: 5 },
    { at: 36.19, d: 4, count: 5 },
    { at: 39.05, d: -6, count: 5 },
  ],
  movers: [
    { kind: 'sweep', at: 24.034, d: 4, amplitude: 3.8, period: 10, phase: 3.93, radius: 1.5, look: 'log' }, // log rolling across the ruins avenue (left lane stays clear)
    { kind: 'sweep', at: 38.7, d: -5.5, amplitude: 3.5, period: 8, phase: 2.2, radius: 1.5, look: 'log' }, // log rolling along the left of the flats (racing line sets up on the right for the esses)
    { kind: 'sweep', at: 53.919, d: -5, amplitude: 3, period: 7, phase: 1, radius: 1.4, look: 'tiki' }, // tiki idol shuffling on the outside
  ],
  landmarks: [
    { kind: 'grandstand', at: 1.418, side: 'left', dist: 26 },
    { kind: 'grandstand', at: 2.073, side: 'right', dist: 26 },
    { kind: 'banner', at: 2.673, side: 'over', dist: 0 },
    { kind: 'jungle-tree', at: 4.46, side: 'right', dist: 40, scale: 1.4 },
    { kind: 'totem', at: 6.667, side: 'left', dist: 24 },
    { kind: 'temple', at: 10.111, side: 'left', dist: 44, scale: 1.3 },
    { kind: 'ruins-arch', at: 9.148, side: 'over', dist: 0 },
    { kind: 'rope-bridge', at: 18, side: 'over', dist: 0 },
    { kind: 'waterfall', at: 17.786, side: 'left', dist: 48, scale: 1.4 },
    { kind: 'ruins-arch', at: 23.517, side: 'over', dist: 0 },
    { kind: 'waterfall', at: 28.546, side: 'left', dist: 44 },
    { kind: 'totem', at: 34.4, side: 'right', dist: 26 },
    { kind: 'jungle-tree', at: 46.471, side: 'right', dist: 36, scale: 1.3 },
    { kind: 'temple', at: 49.667, side: 'left', dist: 40, scale: 0.8 },
  ],
  music: { bpm: 136, key: 'Gm', mood: 'adventure' },
  scenerySeed: 6202,
  parLap: 43,
};
