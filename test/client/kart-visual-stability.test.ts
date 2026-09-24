/**
 * Kart visuals must stay glued together at any frame rate. Regression: the chassis suspension
 * spring was integrated with one explicit step per frame, which diverges above dt ≈ 0.082 s — at
 * ≲ 12 fps (software GL, busy laptops) body + driver flew off to 1e20 m and only the wheels were
 * left on screen.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { KartState } from '../../src/sim/types.js';
import { QUALITY_PRESETS } from '../../src/client/render/contracts.js';

/** Minimal DOM: a canvas whose 2D context swallows every call (textures are never uploaded here). */
function installCanvasStub(): void {
  const g = globalThis as unknown as { document?: unknown };
  if (g.document) return;
  const noop = (): unknown => ctx;
  const ctx: unknown = new Proxy({}, {
    get: (_t, p) => (p === 'canvas' ? {} : p === 'measureText' ? () => ({ width: 10 }) : noop),
    set: () => true,
  });
  g.document = {
    createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener() { /* */ } }),
  };
}

type Internals = {
  chassis: THREE.Group; scaler: THREE.Group; root: THREE.Object3D;
  bodyMesh: THREE.Mesh; driver: { root: THREE.Object3D };
};

let createKartVisual: typeof import('../../src/client/render/kart-model.js').createKartVisual;
let createDisplayKartState: typeof import('../../src/client/render/kart-model.js').createDisplayKartState;

beforeAll(async () => {
  installCanvasStub();
  ({ createKartVisual, createDisplayKartState } = await import('../../src/client/render/kart-model.js'));
});

/** Runs `frames` updates; `settled(f)` marks frames where every spring should have come to rest. */
function drive(dt: number, frames: number, mutate: (k: KartState, f: number) => void, settled: (f: number) => boolean) {
  const v = createKartVisual('bolt', QUALITY_PRESETS.low);
  const k = createDisplayKartState('bolt');
  const pose = { x: 0, y: 0, z: 0, yaw: 0 };
  const it = v as unknown as Internals;
  let restY = 0, restScale = 0;
  for (let f = 0; f < frames; f++) {
    mutate(k, f);
    k.speed = 25;
    v.update(k, pose, dt, { lookBack: false, throttle: true, time: f * dt });
    expect(Number.isFinite(it.chassis.position.y)).toBe(true);
    if (settled(f)) {
      restY = Math.max(restY, Math.abs(it.chassis.position.y));
      restScale = Math.max(restScale, Math.abs(it.scaler.scale.y - 1), Math.abs(it.scaler.scale.x - 1));
    }
  }
  const body = new THREE.Vector3();
  it.root.updateMatrixWorld(true);
  it.bodyMesh.getWorldPosition(body);
  const out = { restY, restScale, bodyDist: body.distanceTo(it.root.position) };
  v.dispose();
  return out;
}

describe('kart visual springs at low frame rates', () => {
  for (const dt of [1 / 60, 1 / 12, 0.1]) {
    it(`chassis suspension settles after every landing (dt=${dt.toFixed(3)})`, () => {
      // airborne 0.4 s, grounded 1.6 s, repeat — every landing kicks the suspension; by the last
      // 0.4 s on the ground only the engine rumble (< 2 cm) may remain
      const phase = (f: number) => (f * dt) % 2;
      const r = drive(dt, Math.round(30 / dt), (k, f) => { k.grounded = phase(f) > 0.4; }, f => f * dt > 2 && phase(f) > 1.6);
      expect(r.restY).toBeLessThan(0.02);
      expect(r.bodyDist).toBeLessThan(1);
    });
    it(`squash / shrink scale springs settle (dt=${dt.toFixed(3)})`, () => {
      // squash hit at t ≡ 0 (mod 5), hops at t ≡ 2 — at rest in [3.5, 5)
      const phase = (f: number) => (f * dt) % 5;
      const r = drive(dt, Math.round(25 / dt), (k, f) => {
        const t = phase(f);
        if (t < dt) k.spinTime = 1.6; else k.spinTime = Math.max(0, k.spinTime - dt);
        k.hopTime = t > 2 && t < 2.2 ? 0.2 : 0;
      }, f => f * dt > 5 && phase(f) > 3.5);
      expect(r.restScale).toBeLessThan(0.02);
    });
  }
});
