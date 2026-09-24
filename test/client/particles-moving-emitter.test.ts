/**
 * Boost exhaust licks are emitted from a kart doing 30–45 m/s. Plain world-space particles are left
 * behind (a dotted trail of blobs 1–5 m behind the nozzles); emitMoving() must carry the emitter's
 * velocity so the licks stay on the kart while their own jet/drag still acts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { QUALITY_PRESETS } from '../../src/client/render/contracts.js';

function installCanvasStub(): void {
  const g = globalThis as unknown as { document?: unknown };
  if (g.document) return;
  const noop = (): unknown => ctx;
  const ctx: unknown = new Proxy({}, {
    get: (_t, p) => (p === 'canvas' ? {} : p === 'measureText' ? () => ({ width: 10 }) : p === 'createImageData' ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : noop),
    set: () => true,
  });
  g.document = { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener() { /* */ } }) };
}

let createParticleSystem: typeof import('../../src/client/render/particles.js').createParticleSystem;
beforeAll(async () => {
  installCanvasStub();
  ({ createParticleSystem } = await import('../../src/client/render/particles.js'));
});

/** Mean x of the live additive particles (boostFlame's glow licks live on the additive layer). */
function meanX(ps: ReturnType<typeof createParticleSystem>): { n: number; x: number } {
  const pts = (ps.object as THREE.Group).children.find(c => c.name === 'particles-add') as THREE.Points;
  const n = pts.geometry.drawRange.count;
  const arr = pts.geometry.attributes.position!.array as Float32Array;
  let sx = 0;
  for (let i = 0; i < n; i++) sx += arr[i * 3]!;
  return { n, x: n ? sx / n : NaN };
}

describe('particle emitters riding a moving kart', () => {
  it('emitMoving keeps boost licks with a 40 m/s kart; plain emit leaves them behind', () => {
    const cam = new THREE.PerspectiveCamera();
    const moving = createParticleSystem(QUALITY_PRESETS.high);
    const still = createParticleSystem(QUALITY_PRESETS.high);
    // kart drives +X at 40 m/s; exhaust points back (−X)
    moving.emitMoving('boostFlame', 0, 0.7, 0, 40, 0, 0, { count: 6, dirX: -1, dirY: 0.3, dirZ: 0 });
    still.emit('boostFlame', 0, 0.7, 0, { count: 6, dirX: -1, dirY: 0.3, dirZ: 0 });
    for (let i = 0; i < 4; i++) { moving.update(1 / 60, cam); still.update(1 / 60, cam); }
    const t = 4 / 60, kartX = 40 * t;
    const m = meanX(moving), s = meanX(still);
    expect(m.n).toBeGreaterThan(0);
    expect(s.n).toBeGreaterThan(0);
    // carried along: within ~0.6 m behind the nozzle (own jet + drag), not ~2.7 m behind like a world-space lick
    expect(kartX - m.x).toBeLessThan(0.6);
    expect(kartX - m.x).toBeGreaterThan(0);
    expect(kartX - s.x).toBeGreaterThan(2.4);
    moving.dispose(); still.dispose();
  });

  it('non-finite emitter velocity is ignored', () => {
    const cam = new THREE.PerspectiveCamera();
    const ps = createParticleSystem(QUALITY_PRESETS.low);
    ps.emitMoving('boostFlame', 0, 0, 0, Number.NaN, Infinity, 0, { count: 4 });
    ps.update(1 / 60, cam);
    const m = meanX(ps);
    expect(Number.isFinite(m.x)).toBe(true);
    ps.dispose();
  });
});
