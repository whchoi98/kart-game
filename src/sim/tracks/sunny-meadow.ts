import type { TrackDef } from '../types.js';

const S = 1.25; // authoring scale
const P = (x: number, y: number, z: number, w?: number, bank?: number) => ({ p: [x * S, y, z * S] as [number, number, number], w, bank });

/** Sprout Cup 1 — gentle right-hand loop, a chicane, sheep wandering across the meadow straights, trick ramp over the hill. */
export const sunnyMeadow: TrackDef = {
  id: 'sunny-meadow',
  name: '햇살 초원 서킷',
  nameEn: 'Sunny Meadow Circuit',
  cup: 'sprout',
  order: 1,
  theme: 'meadow',
  laps: 3,
  halfWidth: 9.5,
  shoulder: 9,
  defaultEdge: 'offroad',
  startAt: 0.45,
  points: [
    P(0, 0.5, -75),
    P(0, 0, 40),
    P(-12, 0.5, 95, 10),
    P(-55, 1.5, 125, 10, 0.06),
    P(-120, 4, 130),
    P(-170, 6, 110, 9.5, 0.05),
    P(-195, 6, 60),
    P(-180, 5, 15, 9),
    P(-205, 4, -35, 9),
    P(-195, 3, -90),
    P(-150, 2, -125, 10, 0.05),
    P(-90, 5, -135),
    P(-45, 7, -130),
    P(-13, 3, -117, 10, 0.06),
  ],
  edges: [
    { from: 11.35, to: 12.55, side: 'both', kind: 'wall' },
  ],
  itemRows: [
    { at: 1.55, count: 5 },
    { at: 6.45, count: 4 },
    { at: 10.35, count: 5 },
  ],
  boostPads: [
    { at: 4.25, d: 3.5 },
    { at: 9.45, d: -3 },
  ],
  ramps: [
    { at: 11.55, length: 13, height: 2.1, trick: true },
  ],
  coins: [
    { at: 0.85, d: -4.5, count: 5 },
    { at: 3.4, d: 4, count: 5 },
    { at: 7.35, d: 0, count: 4, spacing: 4 },
    { at: 12.75, d: 3, count: 5 },
  ],
  movers: [
    { kind: 'sweep', at: 5.45, d: -1.5, amplitude: 4.6, period: 7.5, phase: 0, radius: 1.4, look: 'sheep' },
    { kind: 'sweep', at: 8.6, d: 1.5, amplitude: 4.4, period: 6.5, phase: 2.1, radius: 1.4, look: 'sheep' },
  ],
  landmarks: [
    { kind: 'grandstand', at: 0.4, side: 'left', dist: 24 },
    { kind: 'grandstand', at: 0.7, side: 'right', dist: 24 },
    { kind: 'windmill', at: 3.6, side: 'left', dist: 46, scale: 1.2 },
    { kind: 'windmill', at: 4.6, side: 'right', dist: 52 },
    { kind: 'barn', at: 7.9, side: 'left', dist: 40 },
    { kind: 'balloon', at: 5.5, side: 'over', dist: 0, scale: 1.4 },
    { kind: 'arch', at: 12.1, side: 'over', dist: 0 },
    { kind: 'balloon', at: 10.5, side: 'over', dist: 0 },
  ],
  music: { bpm: 150, key: 'C', mood: 'bright' },
  scenerySeed: 1101,
  parLap: 36,
};
