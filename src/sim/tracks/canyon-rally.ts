import type { TrackDef } from '../types.js';

const P = (x: number, y: number, z: number, w?: number, bank?: number) => ({ p: [x, y, z] as [number, number, number], w, bank });

/**
 * Sprout Cup 3 — Red Canyon Rally. Counter-clockwise "M" through a red canyon, 18 m of climb.
 * Canyon-floor start straight → first corner → flat-out slalom through the walled narrow gorge under a
 * rock arch → left out of the gorge and into the notch → steep mesa climb (right-hand guard rail) →
 * summit hairpin at 18 m → big trick-ramp jump over the gully (open deck, chasm on both sides) → fast
 * banked downhill S → the carousel (180° left) → the long west arm where two boulders roll right across
 * the road → final corner with a dirt short-cut band on the inside (take it with the boost pad).
 */
export const canyonRally: TrackDef = {
  id: 'canyon-rally',
  name: '붉은 협곡 랠리',
  nameEn: 'Red Canyon Rally',
  cup: 'sprout',
  order: 3,
  theme: 'canyon',
  laps: 3,
  halfWidth: 10,
  shoulder: 8,
  defaultEdge: 'offroad',
  startAt: 3.58,
  points: [
    P(0, 0, 0, 10.5),  // 0: canyon-floor start straight
    P(22.3, 0, 0, 10.5),
    P(44.7, 0, 0, 10.5),
    P(67, 0, 0, 10.5),
    P(89.3, 0, 0, 10.5),
    P(111.7, 0, 0, 10.5),
    P(134, 0, 0, 10.5),
    P(156.3, 0, 0, 10.5),  // 7: first corner
    P(170.1, 0, -2.7, 10.5),
    P(181.8, 0, -10.5, 10.5),
    P(189.6, 0, -22.2, 10.5),
    P(192.3, 0, -36, 10.5),  // 11: into the gorge
    P(192.3, 0, -42, 9),  // 12: narrow walled gorge: flat-out slalom, left
    P(186.9, 0.1, -70.1, 9),  // 13: gorge slalom: right (under the rock arch)
    P(181.4, 0.4, -98.2, 9),
    P(186.9, 0.8, -126.3, 9),  // 15: gorge slalom: left
    P(192.3, 1.4, -154.4),  // 16: gorge exit
    P(192.3, 1.6, -164.4, 10.5),  // 17: left out of the gorge
    P(189.6, 1.8, -178.2, 10.5),
    P(181.8, 1.9, -189.8, 10.5),
    P(170.1, 2, -197.6, 10.5),
    P(156.3, 2.2, -200.4),  // 21: turn into the notch
    P(141.8, 2.8, -197.5),
    P(129.4, 4, -189.3),
    P(121.2, 5.5, -176.9),
    P(118.3, 7, -162.4),  // 25: mesa climb
    P(118.3, 9.9, -141.4),
    P(118.3, 13.5, -120.4),
    P(118.3, 16.7, -99.4),
    P(118.3, 18, -78.4, 10.5),  // 29: summit hairpin
    P(116.2, 18, -67.7, 10.5),
    P(110.1, 18, -58.6, 10.5),
    P(101, 17.9, -52.5, 10.5),
    P(90.3, 17.9, -50.4, 10.5),
    P(79.6, 17.9, -52.5, 10.5),
    P(70.5, 17.8, -58.6, 10.5),
    P(64.4, 17.8, -67.7, 10.5),
    P(62.3, 17.7, -78.4),  // 37: trick ramp over the gully
    P(62.3, 17.4, -103.4),
    P(62.3, 16.8, -128.4, 10, -0.1),  // 39: fast downhill S (banked)
    P(59.2, 15.2, -150.4, 10, -0.1),
    P(50.2, 13, -170.8, 10, 0.1),  // 41: downhill S exit
    P(41.1, 11, -191.1, 10, 0.1),
    P(38, 9, -213.2),  // 43: S exit
    P(38, 8, -227.2),  // 44: the carousel (180° left)
    P(35.1, 7.5, -241.7),
    P(26.9, 7.2, -254),
    P(14.5, 6.8, -262.3),
    P(0, 6.5, -265.2),  // 48: carousel exit onto the west arm
    P(-14.5, 6.1, -262.3),
    P(-26.9, 5.7, -254),
    P(-35.1, 5.4, -241.7),
    P(-38, 5, -227.2),  // 52: west arm: boulder run (gentle descent)
    P(-38, 4.4, -203.5),
    P(-38, 3.8, -179.9),
    P(-38, 3.1, -156.2),
    P(-38, 2.5, -132.6),
    P(-38, 1.9, -108.9),
    P(-38, 1.3, -85.3),
    P(-38, 0.9, -61.6),
    P(-38, 0.5, -38, 10.5),  // 60: final corner — dirt short-cut band on the inside
    P(-35.1, 0.3, -23.5, 10.5),
    P(-26.9, 0.2, -11.1, 10.5),
    P(-14.5, 0, -2.9, 10.5),
  ],
  edges: [
    { from: 12.07, to: 15.49, side: 'left', kind: 'wall' },
    { from: 12.07, to: 16.6, side: 'right', kind: 'wall' },
    { from: 23.01, to: 28.9, side: 'right', kind: 'wall' },
    { from: 29, to: 37.68, side: 'left', kind: 'wall' },
    { from: 29, to: 37.68, side: 'right', kind: 'offroad', shoulder: 6 },
    { from: 38.56, to: 41.9, side: 'right', kind: 'wall' },
    { from: 37.68, to: 38.56, side: 'both', kind: 'pit' },
  ],
  surfaces: [
    { from: 60.27, to: 63.73, dFrom: -11, dTo: -7, kind: 'dirt' },
  ],
  itemRows: [
    { at: 12.52, count: 5 },
    { at: 34.64, count: 5 },
    { at: 46.01, count: 4 },
    { at: 53.69, count: 5 },
  ],
  boostPads: [
    { at: 6.27, d: 3.5 },
    { at: 25.95, d: -3.5 },
    { at: 60.6, d: -5.5 },
  ],
  ramps: [
    { at: 37.16, length: 15, height: 3, trick: true },
  ],
  coins: [
    { at: 13.17, d: 0, count: 6, spacing: 5 },
    { at: 31.27, d: 5, count: 6, spacing: 6 },
    { at: 39.45, d: -3, count: 5, spacing: 6 },
    { at: 60.8, d: -9, count: 5, spacing: 6 },
    { at: 4.48, d: -4, count: 5, spacing: 4 },
  ],
  movers: [
    { kind: 'sweep', at: 55.55, d: 0, amplitude: 12, period: 12, phase: 0.5, radius: 1.6, look: 'boulder' },
    { kind: 'sweep', at: 58.09, d: 0, amplitude: 12, period: 12, phase: 5.5, radius: 1.6, look: 'boulder' },
  ],
  landmarks: [
    { kind: 'arch', at: 28.52, side: 'over', dist: 0, scale: 1.1 },
    { kind: 'grandstand', at: 2.69, side: 'right', dist: 26 },
    { kind: 'banner', at: 4.93, side: 'left', dist: 25 },
    { kind: 'windmill-pump', at: 9.48, side: 'right', dist: 30 },
    { kind: 'cactus', at: 9.12, side: 'left', dist: 25 },
    { kind: 'rock-arch', at: 13.69, side: 'over', dist: 0, scale: 1.2 },
    { kind: 'mesa', at: 21.34, side: 'right', dist: 70, scale: 1.4 },
    { kind: 'cactus', at: 27.86, side: 'left', dist: 25 },
    { kind: 'wagon', at: 33, side: 'left', dist: 20 },
    { kind: 'banner', at: 37.08, side: 'left', dist: 18 },
    { kind: 'mesa', at: 39.22, side: 'left', dist: 50 },
    { kind: 'bridge', at: 52.85, side: 'over', dist: 0 },
    { kind: 'cactus', at: 54.96, side: 'right', dist: 25 },
    { kind: 'windmill-pump', at: 62.01, side: 'left', dist: 28 },
    { kind: 'mesa', at: 56.65, side: 'right', dist: 90, scale: 1.2 },
  ],
  music: { bpm: 140, key: 'Em', mood: 'western' },
  scenerySeed: 3303,
  parLap: 33.4,
};
