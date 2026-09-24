import type { TrackDef } from '../types.js';

const P = (x: number, y: number, z: number, w?: number, bank?: number) => ({ p: [x, y, z] as [number, number, number], w, bank });

/**
 * Sprout Cup 4 — Neon City Nights. Figure-8 street circuit on a city grid, walls everywhere.
 * The avenue (start/finish, boost pad in the underpass) runs north under the elevated highway → 90°
 * right onto the neon boulevard (arches, boost pads) → banked 180° on-ramp loop climbing to 9 m → trick
 * ramp off the top of the on-ramp → over the avenue on the highway deck (9 m clearance) → S-bend
 * off-ramp descent → stair-step old-town blocks (90° lefts and rights, 45 m streets between) → harbour
 * street under the rail bridge → last corner onto the avenue.
 * Traffic (a car and a bus) keeps to the slow lane (d = +4) at 14 m/s in race direction; the other lane
 * is always open for overtaking.
 */
export const neonCity: TrackDef = {
  id: 'neon-city',
  name: '네온 시티 나이트',
  nameEn: 'Neon City Nights',
  cup: 'sprout',
  order: 4,
  theme: 'city',
  laps: 3,
  halfWidth: 9.5,
  shoulder: 6,
  defaultEdge: 'wall',
  startAt: 3.34,
  points: [
    P(0, 0, 150, 10.5),  // 0: avenue: start/finish, then under the highway
    P(0, 0, 126.1, 10.5),
    P(0, 0, 102.1, 10.5),
    P(0, 0, 78.2, 10.5),
    P(0, 0, 54.3, 10.5),
    P(0, 0, 30.3, 10.5),
    P(0, 0, 6.4, 10.5),
    P(0, 0, -17.6, 10.5),
    P(0, 0, -41.5, 10.5),
    P(0, 0, -65.4, 10.5),  // 9: turn 1 (90° right)
    P(2.3, 0, -76.9, 10.5),
    P(8.8, 0, -86.6, 10.5),
    P(18.5, 0, -93.2, 10.5),
    P(30, 0, -95.4, 10.5),  // 13: neon boulevard (boost pads)
    P(56.7, 0, -95.4, 10.5),
    P(83.3, 0.1, -95.4, 10.5),
    P(110, 0.1, -95.4, 10.5, 0.06),  // 16: banked 180° on-ramp loop (climbing)
    P(122.2, 0.6, -93, 10.5, 0.06),
    P(132.6, 1.6, -86.1, 10.5, 0.06),
    P(139.6, 3, -75.7, 10.5, 0.06),
    P(142, 4.2, -63.4, 10.5, 0.06),  // 20: on-ramp loop: climb to 9 m
    P(139.6, 5.5, -51.2, 10.5, 0.06),
    P(132.6, 7, -40.8, 10.5, 0.06),
    P(122.2, 8.2, -33.9, 10.5, 0.06),
    P(110, 8.8, -31.4, 10),  // 24: elevated highway (trick ramp at the top of the on-ramp)
    P(85, 8.9, -31.4, 10),
    P(60, 9, -31.4, 10),
    P(35, 9, -31.4, 10),  // 27: overpass deck — crosses 9 m above the avenue
    P(11.7, 9, -31.4, 10),
    P(-11.7, 9, -31.4, 10),
    P(-35, 9, -31.4, 10),  // 30: off-ramp descent
    P(-65, 6, -31.4, 10),  // 31: off-ramp S-bend: left
    P(-85.7, 4.9, -28.7, 10),
    P(-105, 4.1, -20.7, 10),  // 33: off-ramp S-bend: right
    P(-124.3, 3.4, -12.7, 10),
    P(-145, 2.5, -10, 10),  // 35: off-ramp run-out
    P(-180, 0.5, -10, 10.5),  // 36: turn (90° left)
    P(-191.5, 0.3, -7.7, 10.5),
    P(-201.2, 0.1, -1.2, 10.5),
    P(-207.7, 0, 8.5, 10.5),
    P(-210, 0, 20, 9.5),  // 40: old town
    P(-210, 0, 45, 10.5),  // 41: stair-step: left
    P(-207.7, 0, 56.5, 10.5),
    P(-201.2, 0, 66.2, 10.5),
    P(-191.5, 0, 72.7, 10.5),
    P(-180, 0, 75, 9.5),  // 45: stair-step street
    P(-157.5, 0, 75, 9.5),
    P(-135, 0, 75, 10.5),  // 47: stair-step: right
    P(-123.5, 0, 77.3, 10.5),
    P(-113.8, 0, 83.8, 10.5),
    P(-107.3, 0, 93.5, 10.5),
    P(-105, 0, 105, 9.5),  // 51: old-town lane
    P(-105, 0, 127.5, 9.5),
    P(-105, 0, 150, 10.5),  // 53: turn (90° left)
    P(-102.7, 0, 161.5, 10.5),
    P(-96.2, 0, 171.2, 10.5),
    P(-86.5, 0, 177.7, 10.5),
    P(-75, 0, 180, 10.5),  // 57: harbour street
    P(-52.5, 0, 180, 10.5),
    P(-30, 0, 180, 10.5),  // 59: last corner onto the avenue
    P(-18.5, 0, 177.7, 10.5),
    P(-8.8, 0, 171.2, 10.5),
    P(-2.3, 0, 161.5, 10.5),
  ],
  edges: [
    { from: 8.75, to: 13.22, side: 'right', kind: 'offroad', shoulder: 3.5 },
    { from: 15.77, to: 20.48, side: 'right', kind: 'offroad', shoulder: 3.5 },
    { from: 19.52, to: 24.24, side: 'right', kind: 'offroad', shoulder: 3.5 },
    { from: 35.83, to: 40.24, side: 'left', kind: 'offroad', shoulder: 3.5 },
    { from: 40.76, to: 45.27, side: 'left', kind: 'offroad', shoulder: 3.5 },
    { from: 46.73, to: 51.27, side: 'right', kind: 'offroad', shoulder: 3.5 },
    { from: 52.73, to: 57.27, side: 'left', kind: 'offroad', shoulder: 3.5 },
    { from: 58.73, to: 0.25, side: 'left', kind: 'offroad', shoulder: 3.5 },
  ],
  itemRows: [
    { at: 13.56, count: 5 },
    { at: 29.36, count: 4 },
    { at: 40.6, count: 4 },
    { at: 58.33, count: 5 },
  ],
  boostPads: [
    { at: 14.31, d: -3.5 },
    { at: 15.62, d: 3.5 },
    { at: 7.12, d: 3 },
  ],
  ramps: [
    { at: 24.8, length: 14, height: 2.4, trick: true },
  ],
  coins: [
    { at: 14.57, d: 0, count: 6, spacing: 4 },
    { at: 18.39, d: 5, count: 6, spacing: 8 },
    { at: 30.67, d: -4, count: 5, spacing: 5 },
    { at: 41.85, d: -4, count: 5, spacing: 6 },
  ],
  movers: [
    { kind: 'travel', at: 30, d: 4, period: 80.9, phase: 0, radius: 1.5, look: 'car' },
    { kind: 'travel', at: 59.51, d: 4, period: 80.9, phase: 0, radius: 1.9, look: 'bus' },
  ],
  landmarks: [
    { kind: 'neon-arch', at: 46, side: 'over', dist: 0 },
    { kind: 'grandstand', at: 2.51, side: 'right', dist: 22 },
    { kind: 'grandstand', at: 2.51, side: 'left', dist: 22 },
    { kind: 'streetlamp', at: 6.68, side: 'left', dist: 18 },
    { kind: 'building', at: 10.7, side: 'left', dist: 30, scale: 1.3 },
    { kind: 'neon-arch', at: 14.12, side: 'over', dist: 0 },
    { kind: 'neon-arch', at: 15.62, side: 'over', dist: 0 },
    { kind: 'billboard', at: 15.06, side: 'left', dist: 18 },
    { kind: 'billboard', at: 20.16, side: 'left', dist: 20, scale: 1.2 },
    { kind: 'tower', at: 20, side: 'right', dist: 50, scale: 1.5 },
    { kind: 'banner', at: 24.64, side: 'right', dist: 18 },
    { kind: 'building', at: 26.4, side: 'left', dist: 28 },
    { kind: 'billboard', at: 30.33, side: 'right', dist: 18 },
    { kind: 'building', at: 40.4, side: 'right', dist: 26 },
    { kind: 'streetlamp', at: 45.44, side: 'left', dist: 19 },
    { kind: 'bridge', at: 58.78, side: 'over', dist: 0 },
  ],
  music: { bpm: 124, key: 'Am', mood: 'funky' },
  scenerySeed: 4404,
  parLap: 32.7,
};
