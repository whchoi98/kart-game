import type { TrackDef } from '../types.js';

const P = (x: number, y: number, z: number, w?: number, bank?: number) => ({ p: [x, y, z] as [number, number, number], w, bank });

/**
 * Sprout Cup 2 — Palm Beach Boulevard. Clockwise coastal loop, sea to the south (+Z).
 * Seaside promenade (S/F, twin boost pads into turn 1) → left through the harbour gate onto the 85 m
 * pier boardwalk (open water on the sea side, railing on the harbour side) → lighthouse hairpin on the
 * rock platform at the pier head → breakwater back to the beach → fast kink into the dunes where a crab
 * scuttles across → dune climb to a trick ramp off the crest → palm-lined town esses between shop fronts
 * → banked double-apex headland → downhill dip through the cove under the rock arch → second crab on
 * the cove floor → flat-out kink back onto the promenade.
 * AI-friendly geometry: drift corners R26–42, fast kinks R75+ (taken flat, no drift).
 */
export const palmBeach: TrackDef = {
  id: 'palm-beach',
  name: '야자수 해변',
  nameEn: 'Palm Beach Boulevard',
  cup: 'sprout',
  order: 2,
  theme: 'beach',
  laps: 3,
  halfWidth: 10,
  shoulder: 9,
  defaultEdge: 'offroad',
  startAt: 2.89,
  points: [
    P(150, 2, 0, 10.5),  // 0: seaside promenade (start/finish)
    P(123.7, 2, 0, 10.5),
    P(97.3, 2, 0, 10.5),
    P(71, 2, 0, 10.5),
    P(44.7, 2, 0, 10.5),
    P(18.3, 2, 0, 10),  // 5: left onto the pier
    P(5.3, 2, 2.6, 10),
    P(-5.7, 2, 10, 10),
    P(-13.1, 2, 21, 10),
    P(-15.7, 2, 34, 10),  // 9: pier boardwalk — open water on the left
    P(-15.7, 2, 55.3, 10),
    P(-15.7, 2, 76.5, 10),
    P(-15.7, 2, 97.8, 10),
    P(-15.7, 2, 119, 10.5),  // 13: lighthouse hairpin
    P(-17.6, 2, 128.9, 10.5),
    P(-23.3, 2, 137.4, 10.5),
    P(-31.7, 2, 143, 10.5),
    P(-41.7, 2, 145, 10.5),
    P(-51.6, 2, 143, 10.5),
    P(-60, 2, 137.4, 10.5),
    P(-65.7, 2, 128.9, 10.5),
    P(-67.7, 2, 119, 11),  // 21: breakwater back to the beach
    P(-67.7, 2, 99, 11),
    P(-67.7, 2, 79, 11),
    P(-67.7, 2, 59),  // 24: kink into the dunes
    P(-63.1, 2, 33.3),
    P(-50.1, 2.1, 10.8),  // 26: through the dunes
    P(-31.1, 2.2, -11.8),  // 27: dune wiggle (left)
    P(-20.1, 2.3, -27.5),
    P(-12, 2.3, -44.9),  // 29: dune wiggle (right)
    P(-3.9, 2.4, -62.3),
    P(7.1, 2.6, -78),  // 31: dune climb
    P(21.5, 5.1, -95.2),
    P(36, 7.5, -112.5),  // 33: dune top — trick ramp
    P(48.9, 7.5, -127.8),  // 34: over the dune
    P(68.1, 6.5, -150.8, 10.5),  // 35: town corner
    P(76.8, 6.5, -158.5, 10.5),
    P(87.3, 6.5, -163.4, 10.5),
    P(98.8, 6.5, -165.1, 9.5),  // 38: palm boulevard
    P(128.8, 6.5, -165.1, 9.5),  // 39: town esses: right
    P(140.2, 6.5, -163.3, 9.5),
    P(150.6, 6.5, -158.2, 9.5),  // 41: town esses: left
    P(160.9, 6.5, -153.1, 9.5),
    P(172.4, 6.5, -151.3, 9.5),
    P(183.8, 6.5, -153.1, 9.5),
    P(194.2, 6.5, -158.2, 9.5),  // 45: town esses: right
    P(204.5, 6.5, -163.3, 9.5),
    P(216, 6.5, -165.1, 10),  // 47: boulevard exit
    P(251, 6.5, -165.1, 10.5, 0.08),  // 48: headland double-apex: first banked right-hander
    P(264.5, 6.5, -162.8, 10.5, 0.08),
    P(276.5, 6.4, -156.4, 10.5, 0.08),
    P(285.9, 6.3, -146.4, 10.5, 0.08),
    P(291.5, 6.2, -133.9, 10),  // 52: headland: short chute between the apexes
    P(298, 5.9, -109.8, 10.5, 0.08),  // 53: headland double-apex: second banked right-hander
    P(299.3, 5.7, -96.2, 10.5, 0.08),
    P(296.2, 5.5, -82.8, 10.5, 0.08),
    P(289, 5.2, -71.2, 10.5, 0.08),
    P(278.4, 5, -62.5, 10.5),  // 57: cove dip under the rock arch
    P(258.2, 3.8, -50.9, 10.5),
    P(238, 1.9, -39.2, 10.5),
    P(217.8, 1, -27.5, 10.5),  // 60: cove floor
    P(202.2, 1, -18.5, 10.5),  // 61: short climb out of the cove
    P(187.5, 2.5, -10, 10.5),  // 62: kink onto the promenade
    P(169.4, 2.2, -2.6, 10.5),
  ],
  edges: [
    { from: 5, to: 9.28, side: 'left', kind: 'offroad', shoulder: 4 },
    { from: 5.37, to: 13, side: 'right', kind: 'wall' },
    { from: 9.28, to: 12.72, side: 'left', kind: 'pit' },
    { from: 12.72, to: 21.5, side: 'left', kind: 'wall' },
    { from: 12.72, to: 21.5, side: 'right', kind: 'offroad', shoulder: 3 },
    { from: 21.5, to: 23, side: 'right', kind: 'wall' },
    { from: 24.76, to: 29.52, side: 'both', kind: 'offroad', shoulder: 6 },
    { from: 38.33, to: 47.43, side: 'both', kind: 'wall' },
    { from: 57.51, to: 58.89, side: 'both', kind: 'wall' },
  ],
  itemRows: [
    { at: 11.12, count: 5 },
    { at: 34.87, count: 5 },
    { at: 48.36, count: 4 },
    { at: 62.41, count: 5 },
  ],
  boostPads: [
    { at: 4.54, d: -4.5 },
    { at: 4.54, d: 4.5 },
    { at: 57.26, d: -3 },
    { at: 47.57, d: -3 },
  ],
  ramps: [
    { at: 33.35, length: 13, height: 2.2, trick: true },
  ],
  coins: [
    { at: 4.18, d: 0, count: 6, spacing: 4 },
    { at: 14.96, d: 5.5, count: 6, spacing: 6 },
    { at: 39.43, d: 0, count: 5, spacing: 5 },
    { at: 49.46, d: -6, count: 6, spacing: 6 },
    { at: 58.29, d: 0, count: 5, spacing: 4 },
  ],
  movers: [
    { kind: 'sweep', at: 24.69, d: 0, amplitude: 13, period: 10, phase: 2.5, radius: 1.3, look: 'crab' },
    { kind: 'sweep', at: 60, d: 0, amplitude: 13, period: 10, phase: 2.5, radius: 1.3, look: 'crab' },
  ],
  landmarks: [
    { kind: 'arch', at: 9.38, side: 'over', dist: 0, scale: 1.1 },
    { kind: 'grandstand', at: 2.66, side: 'right', dist: 26 },
    { kind: 'umbrella', at: 1.52, side: 'left', dist: 27 },
    { kind: 'hut', at: 4.56, side: 'left', dist: 26 },
    { kind: 'pier', at: 10.65, side: 'left', dist: 22 },
    { kind: 'lighthouse', at: 17, side: 'right', dist: 26, scale: 1.3 },
    { kind: 'boat', at: 13.98, side: 'left', dist: 55 },
    { kind: 'boat', at: 22.25, side: 'left', dist: 48, scale: 0.8 },
    { kind: 'palm', at: 24.76, side: 'left', dist: 26 },
    { kind: 'hut', at: 28.04, side: 'right', dist: 27 },
    { kind: 'banner', at: 33.2, side: 'right', dist: 26 },
    { kind: 'hut', at: 38.5, side: 'left', dist: 18 },
    { kind: 'palm', at: 42.72, side: 'right', dist: 17 },
    { kind: 'grandstand', at: 45.86, side: 'left', dist: 24 },
    { kind: 'palm', at: 54.46, side: 'right', dist: 30 },
    { kind: 'rock-arch', at: 58.29, side: 'over', dist: 0, scale: 1.2 },
  ],
  music: { bpm: 128, key: 'F', mood: 'tropical' },
  scenerySeed: 2202,
  parLap: 34.9,
};
