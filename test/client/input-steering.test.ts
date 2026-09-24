import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STICK, KEY_STEER_RETURN, KEY_STEER_RISE, RepeatGate, digitalSteerTarget, mergeSteer,
  rampSteer, shapeAxis, stickDirection, touchSteer,
} from '../../src/client/input/steering.js';

const TICK = 1 / 60;

function runRamp(start: number, target: number, seconds: number, dt = TICK): number {
  let v = start;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) v = rampSteer(v, target, dt);
  return v;
}

describe('keyboard steering ramp', () => {
  it('reaches full lock in about 0.1 s', () => {
    expect(runRamp(0, 1, 0.05)).toBeGreaterThan(0.4);
    expect(runRamp(0, 1, 0.05)).toBeLessThan(0.6);
    expect(runRamp(0, 1, 0.1)).toBeCloseTo(1, 5);
    expect(runRamp(0, -1, 0.1)).toBeCloseTo(-1, 5);
  });

  it('returns to centre faster than it rises', () => {
    const released = runRamp(1, 0, 0.05);
    expect(released).toBe(0);
    expect(KEY_STEER_RETURN).toBeGreaterThan(KEY_STEER_RISE);
  });

  it('crosses through centre using the return rate first', () => {
    // From full right to full left: 0.045 s back to 0, then 0.1 s to −1.
    const mid = runRamp(1, -1, 0.05);
    expect(mid).toBeLessThan(0);
    expect(mid).toBeGreaterThan(-0.2);
    expect(runRamp(1, -1, 0.16)).toBeCloseTo(-1, 5);
  });

  it('is independent of the step size (frame-rate independent)', () => {
    const coarse = runRamp(0, 1, 0.05, 1 / 60);
    const fine = runRamp(0, 1, 0.05, 1 / 240);
    expect(coarse).toBeCloseTo(fine, 6);
    const coarseCross = runRamp(0.8, -1, 0.1, 1 / 20);
    const fineCross = runRamp(0.8, -1, 0.1, 1 / 200);
    expect(coarseCross).toBeCloseTo(fineCross, 6);
  });

  it('never overshoots the target and ignores non-positive dt', () => {
    expect(rampSteer(0.2, 0.5, 10)).toBe(0.5);
    expect(rampSteer(0.9, 0.5, 10)).toBe(0.5);
    expect(rampSteer(0.3, 1, 0)).toBe(0.3);
    expect(rampSteer(0.3, 1, -1)).toBe(0.3);
    expect(rampSteer(0.3, 1, Number.NaN)).toBe(0.3);
  });

  it('last pressed direction wins', () => {
    expect(digitalSteerTarget(true, false, 1, 0)).toBe(-1);
    expect(digitalSteerTarget(false, true, 0, 1)).toBe(1);
    expect(digitalSteerTarget(true, true, 1, 2)).toBe(1);
    expect(digitalSteerTarget(true, true, 3, 2)).toBe(-1);
    expect(digitalSteerTarget(false, false, 0, 0)).toBe(0);
  });
});

describe('analog stick response', () => {
  it('applies the deadzone', () => {
    expect(shapeAxis(0)).toBe(0);
    expect(shapeAxis(DEFAULT_STICK.deadzone * 0.99)).toBe(0);
    expect(shapeAxis(-DEFAULT_STICK.deadzone)).toBe(0);
  });

  it('is monotonic, odd-symmetric and saturates at the outer radius', () => {
    let prev = 0;
    for (let v = 0; v <= 1.0001; v += 0.02) {
      const s = shapeAxis(v);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(shapeAxis(-v)).toBeCloseTo(-s, 10);
      prev = s;
    }
    expect(shapeAxis(DEFAULT_STICK.outer)).toBeCloseTo(1, 10);
    expect(shapeAxis(1)).toBe(1);
  });

  it('gives finer control near the centre than a linear map', () => {
    const halfway = (DEFAULT_STICK.deadzone + DEFAULT_STICK.outer) / 2;
    expect(shapeAxis(halfway)).toBeLessThan(0.5);
    expect(shapeAxis(halfway)).toBeGreaterThan(0.2);
  });

  it('treats garbage as zero', () => {
    expect(shapeAxis(Number.NaN)).toBe(0);
    expect(shapeAxis(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('merges sources by magnitude', () => {
    expect(mergeSteer(0.2, -0.5)).toBe(-0.5);
    expect(mergeSteer(0.7, -0.5)).toBe(0.7);
    expect(mergeSteer(0, 0)).toBe(0);
  });

  it('shapes touch drag distance', () => {
    expect(touchSteer(0, 80)).toBe(0);
    expect(touchSteer(4, 80)).toBe(0);
    expect(touchSteer(80, 80)).toBeCloseTo(1, 10);
    expect(touchSteer(-200, 80)).toBeCloseTo(-1, 10);
    expect(touchSteer(40, 80)).toBeGreaterThan(0.3);
    expect(touchSteer(40, 0)).toBe(0);
  });

  it('uses hysteresis for stick menu directions', () => {
    expect(stickDirection(0.5, false)).toBe(false);
    expect(stickDirection(0.6, false)).toBe(true);
    expect(stickDirection(0.4, true)).toBe(true);
    expect(stickDirection(0.3, true)).toBe(false);
  });
});

describe('menu repeat gate', () => {
  it('fires on press, after the delay, then at the repeat interval', () => {
    const g = new RepeatGate(400, 100, 50, 3);
    expect(g.update(true, 0)).toBe(true);
    expect(g.update(true, 100)).toBe(false);
    expect(g.update(true, 399)).toBe(false);
    expect(g.update(true, 400)).toBe(true);
    expect(g.update(true, 450)).toBe(false);
    expect(g.update(true, 500)).toBe(true);
    expect(g.update(true, 600)).toBe(true);
    // After 3 repeats it speeds up to 50 ms.
    expect(g.update(true, 650)).toBe(true);
    expect(g.update(true, 700)).toBe(true);
  });

  it('re-arms after release', () => {
    const g = new RepeatGate(400, 100);
    expect(g.update(true, 0)).toBe(true);
    expect(g.update(false, 10)).toBe(false);
    expect(g.update(true, 20)).toBe(true);
    expect(g.update(true, 30)).toBe(false);
  });
});
