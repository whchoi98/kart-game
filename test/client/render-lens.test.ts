/**
 * Camera-proximity handling in the render modules:
 *  - lensFade(): the shared 0..1 curve (continuous, gone at `gone`, untouched from `start`);
 *  - a real kart visual's setLensFade() pushes its near-fade band out (the whole kart screen-doors away)
 *    and fades its contact shadow / exhaust with it, and is a no-op without the near fade;
 *  - pickups (item boxes, coins) shrink away right at a viewer's lens, and only there.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { QUALITY_PRESETS } from '../../src/client/render/contracts.js';
import { lensFade } from '../../src/client/render/camera.js';

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

let kartModel: typeof import('../../src/client/render/kart-model.js');
let items: typeof import('../../src/client/render/item-models.js');
let materials: typeof import('../../src/client/render/kart-materials.js');
beforeAll(async () => {
  installCanvasStub();
  kartModel = await import('../../src/client/render/kart-model.js');
  items = await import('../../src/client/render/item-models.js');
  materials = await import('../../src/client/render/kart-materials.js');
});

describe('lensFade()', () => {
  it('is 0 from `start` out, 1 at `gone` and closer, monotonic and smooth in between', () => {
    expect(lensFade(10, 1.9, 3.2)).toBe(0);
    expect(lensFade(3.2, 1.9, 3.2)).toBe(0);
    expect(lensFade(1.9, 1.9, 3.2)).toBe(1);
    expect(lensFade(0, 1.9, 3.2)).toBe(1);
    expect(lensFade(2.55, 1.9, 3.2)).toBeCloseTo(0.5, 6);
    expect(lensFade(Number.NaN, 1.9, 3.2)).toBe(0);
    let last = 0;
    for (let d = 3.3; d >= 1.8; d -= 0.01) {
      const a = lensFade(d, 1.9, 3.2);
      expect(a).toBeGreaterThanOrEqual(last);
      expect(a - last).toBeLessThan(0.02); // no jump anywhere along an approach
      last = a;
    }
  });
});

describe('KartVisual.setLensFade (real kart model)', () => {
  it('shifts the near-fade band out with the amount, fades shadow + exhaust, and restores exactly', () => {
    const v = kartModel.createKartVisual('taro', QUALITY_PRESETS.high);
    const k = kartModel.createDisplayKartState('taro');
    v.update(k, { x: 0, y: 0, z: 0, yaw: 0 }, 1 / 60, { lookBack: false, throttle: true, time: 0 });
    const internals = v as unknown as { paintMat: THREE.Material; shadowMat: THREE.MeshBasicMaterial; flameMat: THREE.Material; heldGroup: THREE.Object3D };
    const band = materials.paintUniforms(internals.paintMat)!.uNearFade.value;
    // without the race near fade (showroom) it does nothing
    v.setLensFade(1);
    expect(band.toArray()).toEqual([0, 0]);
    expect(v.lensFade).toBe(0);

    v.setNearFade(true);
    const base = band.toArray();
    expect(base[1]).toBeGreaterThan(base[0]!);
    const shadow = internals.shadowMat.opacity;
    expect(shadow).toBeGreaterThan(0);
    v.setLensFade(1);
    // fully faded: every fragment of a kart within ~2 m of the lens sits inside the dither band's "gone" side
    expect(band.x).toBeGreaterThan(3.5);
    expect(band.y - band.x).toBeCloseTo(base[1]! - base[0]!, 6);
    expect(internals.shadowMat.opacity).toBe(0);
    expect(internals.flameMat.opacity).toBe(0);
    expect(internals.heldGroup.visible).toBe(false);
    v.setLensFade(0.5);
    expect(internals.shadowMat.opacity).toBeCloseTo(shadow * 0.5, 6);
    expect(internals.heldGroup.visible).toBe(true);
    // the next frame's update keeps the per-view fade applied to the new contact-shadow opacity
    v.update(k, { x: 0, y: 0, z: 0, yaw: 0 }, 1 / 60, { lookBack: false, throttle: true, time: 1 / 60 });
    expect(internals.shadowMat.opacity).toBeCloseTo(shadow * 0.5, 6);
    v.setLensFade(0);
    expect(band.toArray()).toEqual(base);
    expect(internals.shadowMat.opacity).toBeCloseTo(shadow, 6);
    expect(internals.flameMat.opacity).toBe(1);
    v.dispose();
  });
});

describe('pickups at the lens', () => {
  const camAt = (x: number, y: number, z: number, lookZ: number) => {
    const c = new THREE.PerspectiveCamera(70, 16 / 9, 0.25, 2400);
    c.position.set(x, y, z);
    c.lookAt(x, y - 0.3, lookZ);
    c.updateMatrixWorld();
    return c;
  };
  const scales = (m: THREE.InstancedMesh) => {
    const out: number[] = [];
    const mat = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    for (let i = 0; i < m.count; i++) { m.getMatrixAt(i, mat); mat.decompose(p, q, s); out.push(+s.x.toFixed(4)); }
    return out;
  };

  it('a box / coin right at a camera shrinks away (smoothly), ones further on are untouched', () => {
    const pv = items.createPickupVisuals(2, 1, QUALITY_PRESETS.low);
    const [, , shell, , coins] = pv.group.children as THREE.InstancedMesh[];
    const boxes = [{ x: 0, y: 1, z: 0, active: true }, { x: 0, y: 1, z: 25, active: true }];
    const coinList = [{ x: 0.1, y: 1.3, z: -0.3, active: true }];
    // lens 1 m from box 0 and the coin: both gone, box 1 far ahead drawn at full size
    pv.setViewers([camAt(0, 1.6, -0.8, 30)]);
    pv.update(boxes, coinList, 1 / 60, 0);
    expect(shell.count).toBe(1);
    expect(scales(shell)).toEqual([1]);
    expect(coins.count).toBe(0);
    // lens between gone and start: box 0 drawn, partly shrunk
    pv.setViewers([camAt(0, 1.8, -2.8, 30)]);
    pv.update(boxes, coinList, 1 / 60, 0);
    expect(shell.count).toBe(2);
    const sc = scales(shell);
    expect(sc[0]).toBeGreaterThan(0.05);
    expect(sc[0]).toBeLessThan(0.95);
    expect(sc[1]).toBe(1);
    // no viewers (showroom-style use): nothing shrinks
    pv.setViewers([]);
    pv.update(boxes, coinList, 1 / 60, 0);
    expect(scales(shell)).toEqual([1, 1]);
    expect(coins.count).toBe(1);
    // split screen: near EITHER lens is enough
    pv.setViewers([camAt(0, 1.6, 40, 80), camAt(0, 1.6, -0.8, 30)]);
    pv.update(boxes, coinList, 1 / 60, 0);
    expect(scales(shell)).toEqual([1]);
    pv.dispose();
  });

  it('the fade distances keep anything a kart can still collect untouched', () => {
    // a chase camera is ≥ 5 m behind its kart and karts collect boxes within 2.1 m, coins within 1.7 m:
    // a pickup the kart can still reach (beside / ahead of it) is never inside the shrink radius
    expect(items.BOX_LENS_START).toBeLessThanOrEqual(5 - 0.8);
    expect(items.COIN_LENS_START).toBeLessThanOrEqual(5 - 1.7);
    expect(items.BOX_LENS_GONE).toBeLessThan(items.BOX_LENS_START);
    expect(items.COIN_LENS_GONE).toBeLessThan(items.COIN_LENS_START);
  });
});
