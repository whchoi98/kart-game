import type { TrackDef } from '../types.js';

const P = (x: number, y: number, z: number, w?: number, bank?: number) => ({ p: [x, y, z] as [number, number, number], w, bank });

/**
 * Thunder Cup 1 — Frost Peak Pass.
 * A mountain pass: out of the village and up two narrow, snowbank-walled switchbacks,
 * along a railing-less cliff ledge to the summit ski jump, through the rock tunnel and
 * down one long banked sweeper where snowballs roll across, to the icy chicane on the
 * frozen lake. Elevation 0 → 25 m. Ice lies on the outside of corners (the clean line is
 * the inside). Overtaking: village straight, switchback leg 1, the sweeper.
 */
export const frostPeak: TrackDef = {
  id: 'frost-peak',
  name: '눈꽃 봉우리',
  nameEn: 'Frost Peak Pass',
  cup: 'thunder',
  order: 1,
  theme: 'snow',
  laps: 3,
  halfWidth: 9.5,
  shoulder: 8,
  defaultEdge: 'offroad',
  startAt: 2.4,
  points: [
    // 0: Village straight (start/finish)
    P(0, 0, 0),
    P(35, 0, 0),
    P(70, 0, 0),
    P(105, 0, 0),
    // 4: T1 — right-hander out of the village
    P(140, 0, 0, undefined, 0.035),
    P(165, 0, 6.7, undefined, 0.07),
    P(183.3, 0, 25, undefined, 0.07),
    // 7: link1
    P(190, 0, 50, undefined, 0.035),
    // 8: T2 — right onto the first switchback leg
    P(190, 0.6, 80, undefined, 0.025),
    P(185.4, 1.2, 97, undefined, 0.05),
    P(173, 1.9, 109.4, undefined, 0.05),
    // 11: Switchback leg 1 (snowbank walls, climbing west)
    P(156, 2.5, 114, 9, 0.025),
    P(117.7, 4.3, 114, 9),
    P(79.5, 6.1, 114, 9),
    P(41.2, 7.9, 114, 9),
    P(3, 9.7, 114, 9),
    // 16: Hairpin 1 (left)
    P(-35.3, 11.5, 114, 9),
    P(-47.3, 11.8, 117.2),
    P(-56.1, 12.2, 126),
    P(-59.3, 12.5, 138),
    P(-56.1, 12.8, 150),
    P(-47.3, 13.2, 158.8),
    // 22: Switchback leg 2
    P(-35.3, 13.5, 162, 9),
    P(-4.6, 15.5, 162, 9),
    P(26, 17.5, 162, 9),
    // 25: Hairpin 2 (right, icy outside)
    P(56.7, 19.5, 162, 9),
    P(68.7, 19.8, 165.2),
    P(77.5, 20.2, 174),
    P(80.7, 20.5, 186),
    P(77.5, 20.8, 198),
    P(68.7, 21.2, 206.8),
    // 31: Ridge ledge (cliff on the left)
    P(56.7, 21.5, 210),
    P(23.4, 22.7, 210),
    P(-10, 23.8, 210),
    // 34: Summit crest — ski jump
    P(-43.3, 25, 210),
    P(-69.3, 24.6, 210),
    // 36: Landing slope
    P(-95.3, 24.2, 210),
    P(-131.3, 22.4, 210),
    // 38: T3 — right toward the tunnel
    P(-167.3, 20.6, 210, undefined, 0.03),
    P(-192.7, 19.8, 204.4, undefined, 0.06),
    P(-213.3, 19, 188.6, undefined, 0.06),
    // 41: Rock tunnel
    P(-225.3, 18.2, 165.5, 9, 0.03),
    P(-232.9, 16.1, 136.9, 9),
    // 43: Long descending right sweeper (snowballs)
    P(-240.6, 14, 108.3, 9, 0.05),
    P(-243.1, 12, 77, undefined, 0.1),
    P(-234.2, 10, 47, undefined, 0.1),
    P(-215.1, 8, 22.1, undefined, 0.1),
    P(-188.4, 6, 5.7, undefined, 0.1),
    // 48: lake
    P(-157.5, 4, 0, undefined, 0.05),
    // 49: Frozen-lake chicane: left
    P(-123.5, 2, 0),
    P(-109.7, 1.7, -3.4),
    // 51: lakeMid1
    P(-99, 1.4, -12.8),
    // 52: Frozen-lake chicane: right
    P(-86.3, 1.1, -30.8),
    P(-75.6, 1, -40.2),
    P(-61.8, 0.9, -43.6),
    P(-47.9, 0.7, -40.2),
    // 56: lakeMid2
    P(-37.2, 0.6, -30.8),
    // 57: Frozen-lake chicane: left
    P(-24.6, 0.3, -12.8),
    P(-13.9, 0.2, -3.4),
  ],
  edges: [
    { from: 9.685, to: 31.18, side: 'both', kind: 'wall' }, // switchbacks: snowbank walls
    { from: 31.18, to: 37.667, side: 'right', kind: 'wall' }, // rock face above the ledge
    { from: 31.36, to: 33.82, side: 'left', kind: 'pit' }, // cliff ledge — no railing
    { from: 33.82, to: 37.667, side: 'left', kind: 'wall' }, // snowbanks around the ski jump
    { from: 41.135, to: 43.508, side: 'both', kind: 'wall' }, // rock tunnel
  ],
  surfaces: [
    { from: 25.477, to: 30.57, dFrom: -9.5, dTo: -3.2, kind: 'ice' }, // icy outside of hairpin 2
    { from: 48.176, to: 48.882, dFrom: -3.2, dTo: 3.2, kind: 'ice' }, // frozen puddle mid-road
    { from: 49.139, to: 50.945, dFrom: 4.2, dTo: 9.5, kind: 'ice' }, // icy outside (left bend)
    { from: 52.417, to: 55.611, dFrom: -9.5, dTo: -4.2, kind: 'ice' }, // icy outside (right bend)
    { from: 57.139, to: 58.945, dFrom: 4.2, dTo: 9.5, kind: 'ice' }, // icy outside (left bend)
  ],
  itemRows: [
    { at: 11.314, count: 5 }, // switchback leg 1
    { at: 23.5, count: 4 }, // switchback leg 2 (narrow: 4 boxes)
    { at: 37.778, count: 5 }, // ski-jump landing slope
    { at: 51.5, count: 4 }, // frozen lake, between the chicane bends
  ],
  boostPads: [
    { at: 22.261, d: -2.5 }, // hairpin 1 exit
    { at: 34.538, d: 2.5 }, // run-up to the ski jump (wall side)
    { at: 47.061, d: 4 }, // late apex of the sweeper
  ],
  ramps: [
    { at: 13.718, length: 11, height: 1.5 }, // snowdrift kicker
    { at: 35.231, length: 16, height: 2.6, trick: true }, // summit ski jump
  ],
  coins: [
    { at: 2.971, d: 4, count: 5 },
    { at: 12.307, d: -4, count: 6 },
    { at: 32.2, d: -6, count: 6 }, // along the cliff edge
    { at: 41.337, d: 0, count: 6, spacing: 4 },
    { at: 45.475, d: 5.5, count: 5, spacing: 4 },
  ],
  movers: [
    { kind: 'sweep', at: 44.65, d: -4.5, amplitude: 3.5, period: 8, phase: 0, radius: 1.5, look: 'snowball' }, // rolls along the outside of the sweeper
    { kind: 'sweep', at: 46.046, d: 0, amplitude: 6, period: 9.5, phase: 4.71, radius: 1.5, look: 'snowball' }, // rolls right across the road
  ],
  landmarks: [
    { kind: 'grandstand', at: 2.057, side: 'left', dist: 26 },
    { kind: 'grandstand', at: 2.686, side: 'right', dist: 26 },
    { kind: 'banner', at: 3.486, side: 'over', dist: 0 },
    { kind: 'cabin', at: 7.6, side: 'left', dist: 32 },
    { kind: 'cabin', at: 1.143, side: 'right', dist: 34, scale: 0.9 },
    { kind: 'ski-lift', at: 22.815, side: 'over', dist: 0, scale: 1.2 },
    { kind: 'pine', at: 19.024, side: 'right', dist: 36, scale: 1.5 },
    { kind: 'snowman', at: 31.6, side: 'right', dist: 18 },
    { kind: 'banner', at: 35.154, side: 'over', dist: 0 },
    { kind: 'tunnel', at: 41.81, side: 'over', dist: 0, scale: 1.2 },
    { kind: 'pine', at: 44.904, side: 'right', dist: 40, scale: 1.6 },
    { kind: 'snowman', at: 48.588, side: 'left', dist: 28 },
    { kind: 'ice-arch', at: 53.945, side: 'over', dist: 0 },
  ],
  music: { bpm: 132, key: 'D', mood: 'chill' },
  scenerySeed: 5101,
  parLap: 44,
};
