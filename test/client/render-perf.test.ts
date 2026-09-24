/**
 * Render-cost optimisations must not change what is drawn:
 *  - rigid-merge: the one skinned mesh puts every vertex exactly where the original part mesh had it
 *    (and collapses parts that are hidden);
 *  - instance-culling: only instances inside the frustum are kept, with their own matrices/colours,
 *    shadow twins only exist inside the shadow pass, and dispose() restores the full set;
 *  - scene-optimize: tiling keeps every triangle, and the order-independent passes become single-pass.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { QUALITY_PRESETS } from '../../src/client/render/contracts.js';
import { attachInstanceCulling } from '../../src/client/render/instance-culling.js';
import { optimizeScene } from '../../src/client/render/scene-optimize.js';

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
beforeAll(async () => {
  installCanvasStub();
  kartModel = await import('../../src/client/render/kart-model.js');
});

describe('rigid-merge (kart parts as one skinned draw)', () => {
  it('draws every merged vertex where its original part was, and collapses hidden parts', () => {
    const v = kartModel.createKartVisual('kiki', QUALITY_PRESETS.high);
    const k = kartModel.createDisplayKartState('kiki');
    k.steerVisual = 0.6; k.speed = 20; k.driftDir = 1;
    for (let f = 0; f < 12; f++) v.update(k, { x: 120, y: 4, z: -80, yaw: 0.7 }, 1 / 60, { lookBack: f > 6, throttle: true, time: f / 60 });
    v.root.updateMatrixWorld(true);
    let skinned: THREE.SkinnedMesh | null = null;
    v.root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && o.name === 'rigid-merge') skinned = o as THREE.SkinnedMesh; });
    expect(skinned).not.toBeNull();
    const sm = skinned! as THREE.SkinnedMesh;
    const bones = sm.skeleton.bones as unknown as THREE.Mesh[];
    expect(bones.length).toBeGreaterThanOrEqual(4);
    const idx = sm.geometry.attributes.skinIndex!;
    const pos = new THREE.Vector3(), ref = new THREE.Vector3();
    let base = 0, checked = 0;
    for (let b = 0; b < bones.length; b++) {
      const part = bones[b]!;
      const pp = part.geometry.attributes.position!;
      const count = part.geometry.index ? pp.count : pp.count; // merged indexed geometry keeps vertex order per part
      for (let i = 0; i < count; i += Math.max(1, Math.floor(count / 25))) {
        expect(idx.getX(base + i)).toBe(b);
        sm.getVertexPosition(base + i, pos).applyMatrix4(sm.matrixWorld);
        ref.fromBufferAttribute(pp, i).applyMatrix4(part.matrixWorld);
        expect(pos.distanceTo(ref)).toBeLessThan(1e-4);
        checked++;
      }
      base += count;
      // the original part no longer draws itself
      expect((part.material as THREE.Material).visible).toBe(false);
    }
    expect(checked).toBeGreaterThan(50);
    // hiding a part (rocket shell hides the body) collapses its bone to a degenerate matrix
    bones[0]!.visible = false;
    sm.skeleton.update();
    const m = sm.skeleton.boneMatrices!;
    expect(Array.from(m.subarray(0, 16)).every(x => x === 0)).toBe(true);
    expect(Array.from(m.subarray(16, 32)).some(x => x !== 0)).toBe(true);
    v.dispose();
  });
});

function scatterMesh(n: number, color: boolean): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), n);
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    im.setMatrixAt(i, m.makeTranslation(-500 + (1000 * i) / (n - 1), 0, 0));
    if (color) im.setColorAt(i, new THREE.Color(i / n, 0, 1 - i / n));
  }
  im.castShadow = true;
  im.computeBoundingSphere();
  return im;
}

describe('instance-culling', () => {
  it('keeps exactly the instances in the view frustum, restores everything on dispose', () => {
    const scene = new THREE.Scene();
    const im = scatterMesh(101, true);
    scene.add(im);
    scene.updateMatrixWorld(true);
    const ic = attachInstanceCulling(scene);
    expect(ic.size).toBe(1);
    expect(im.castShadow).toBe(false); // its shadow twin casts instead
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 2000);
    cam.position.set(200, 0, 60);
    cam.lookAt(200, 0, 0); // 60° vfov at 16:9 from 60 m: sees x ≈ 200 ± 62 m
    cam.updateMatrixWorld();
    ic.prepareView(cam);
    expect(im.count).toBeGreaterThan(3);
    expect(im.count).toBeLessThan(20);
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), c = new THREE.Color();
    for (let j = 0; j < im.count; j++) {
      im.getMatrixAt(j, m);
      p.setFromMatrixPosition(m);
      expect(Math.abs(p.x - 200)).toBeLessThan(64); // half-width + instance sphere
      const i = Math.round(((p.x + 500) / 1000) * 100);
      im.getColorAt(j, c);
      expect(c.r).toBeCloseTo(i / 101, 5); // colour travels with its instance
    }
    // moving the camera re-culls
    cam.position.set(-300, 0, 60); cam.lookAt(-300, 0, 0); cam.updateMatrixWorld();
    ic.prepareView(cam);
    for (let j = 0; j < im.count; j++) { im.getMatrixAt(j, m); expect(p.setFromMatrixPosition(m).x).toBeLessThan(-230); }
    expect(im.count).toBeGreaterThan(3);
    ic.dispose();
    expect(im.count).toBe(101);
    expect(im.castShadow).toBe(true);
    im.getMatrixAt(100, m);
    expect(p.setFromMatrixPosition(m).x).toBeCloseTo(500, 5);
  });

  it('fills the shadow twin only with instances inside the light frustum, and only during the shadow pass', () => {
    const scene = new THREE.Scene();
    const im = scatterMesh(201, false);
    scene.add(im);
    const sun = new THREE.DirectionalLight();
    sun.castShadow = true;
    const sc = sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 320; sc.updateProjectionMatrix();
    sun.position.set(64, 128, 48); sun.target.position.set(0, 0, 0);
    scene.add(sun, sun.target);
    scene.updateMatrixWorld(true);
    const ic = attachInstanceCulling(scene);
    const twin = scene.children.find(o => o.name.endsWith(':shadow')) as THREE.InstancedMesh;
    expect(twin).toBeDefined();
    expect(twin.visible).toBe(false);
    ic.prepareShadow(sun);
    expect(twin.visible).toBe(true);
    expect(twin.count).toBeGreaterThan(10);
    expect(twin.count).toBeLessThan(60);
    const m = new THREE.Matrix4(), p = new THREE.Vector3();
    for (let j = 0; j < twin.count; j++) { twin.getMatrixAt(j, m); expect(Math.abs(p.setFromMatrixPosition(m).x)).toBeLessThan(120); }
    ic.restoreShadow();
    expect(twin.visible).toBe(false);
    ic.dispose();
    expect(scene.children.includes(twin)).toBe(false);
  });

  it('lets go of meshes whose owner rewrites their instances', () => {
    const scene = new THREE.Scene();
    const im = scatterMesh(40, false);
    scene.add(im);
    scene.updateMatrixWorld(true);
    const ic = attachInstanceCulling(scene);
    im.instanceMatrix.needsUpdate = true; // owner animation
    const cam = new THREE.PerspectiveCamera(60, 1, 0.5, 2000);
    cam.position.set(0, 0, 50); cam.updateMatrixWorld();
    ic.prepareView(cam);
    expect(ic.size).toBe(0);
    expect(im.count).toBe(40);
    expect(im.castShadow).toBe(true);
  });

  it('hands back the full, original instance order when the owner only re-tints after culling', () => {
    const scene = new THREE.Scene();
    const im = scatterMesh(101, true);
    scene.add(im);
    scene.updateMatrixWorld(true);
    const ic = attachInstanceCulling(scene);
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 2000);
    cam.position.set(200, 0, 60); cam.lookAt(200, 0, 0); cam.updateMatrixWorld();
    ic.prepareView(cam); // buffers now compacted
    expect(im.count).toBeLessThan(20);
    im.setColorAt(3, new THREE.Color(1, 1, 1)); // owner animation by ORIGINAL index
    im.instanceColor!.needsUpdate = true;
    ic.prepareView(cam);
    expect(ic.size).toBe(0);
    expect(im.count).toBe(101);
    const m = new THREE.Matrix4(), p = new THREE.Vector3();
    for (const i of [0, 3, 50, 100]) {
      im.getMatrixAt(i, m);
      expect(p.setFromMatrixPosition(m).x).toBeCloseTo(-500 + (1000 * i) / 100, 4);
    }
  });
});

describe('resource hygiene', () => {
  it('Glows samples the caller-owned texture (no undisposed clone per race)', async () => {
    const { Glows } = await import('../../src/client/render/themes/props-a.js');
    const tex = new THREE.Texture();
    const g = new Glows(4, tex);
    const mat = g.mesh.material as THREE.ShaderMaterial;
    expect(mat.uniforms.map!.value).toBe(tex);
    expect(mat.uniforms.fogNear).toBeDefined();
    g.dispose();
  });
});

describe('scene-optimize', () => {
  it('tiles a huge static mesh without losing a triangle and hides the original from cameras', () => {
    const scene = new THREE.Scene();
    const geo = new THREE.PlaneGeometry(1200, 900, 150, 120).rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    scene.add(mesh);
    const opt = optimizeScene(scene);
    expect(opt.report.tiled).toBe(1);
    expect(mesh.layers.isEnabled(0)).toBe(false);
    const tiles = mesh.children as THREE.Mesh[];
    expect(tiles.length).toBe(opt.report.tiles);
    expect(tiles.length).toBeGreaterThan(4);
    const tris = tiles.reduce((n, t) => n + t.geometry.index!.count / 3, 0);
    expect(tris).toBe(geo.index!.count / 3);
    for (const t of tiles) { expect(t.material).toBe(mesh.material); expect(t.receiveShadow).toBe(true); expect(t.layers.isEnabled(0)).toBe(true); }
    opt.dispose();
  });

  it('gives InstancedMeshes a live twin of a material they share with plain meshes', () => {
    const scene = new THREE.Scene();
    const mat = new THREE.MeshStandardMaterial({ color: '#336699', roughness: 0.4 });
    const plain = new THREE.Mesh(new THREE.BoxGeometry(), mat);
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(), mat, 3);
    const glass = new THREE.MeshStandardMaterial({ transparent: true, side: THREE.DoubleSide });
    const plainGlass = new THREE.Mesh(new THREE.BoxGeometry(), glass), instGlass = new THREE.InstancedMesh(new THREE.BoxGeometry(), glass, 2);
    scene.add(plain, inst, plainGlass, instGlass);
    const opt = optimizeScene(scene);
    expect(opt.report.twinned).toBe(1);
    expect(plain.material).toBe(mat);
    const twin = inst.material as THREE.MeshStandardMaterial;
    expect(twin).not.toBe(mat);
    expect(instGlass.material).toBe(glass); // three flips side/needsUpdate on these while drawing: left alone
    // live: the owner animates the source, the twin follows (values, objects, version)
    mat.roughness = 0.9; mat.color.set('#ff0000'); mat.needsUpdate = true;
    expect(twin.roughness).toBe(0.9);
    expect(twin.color.getHexString()).toBe('ff0000');
    expect(twin.version).toBe(mat.version);
    // own three.js identity: its own dispose event, fired with the source's
    let twinDisposed = 0;
    twin.addEventListener('dispose', () => { twinDisposed++; });
    expect((twin as unknown as { _listeners: unknown })._listeners).not.toBe((mat as unknown as { _listeners: unknown })._listeners);
    mat.dispose();
    expect(twinDisposed).toBe(1);
    opt.dispose();
  });

  it('makes additive double-sided passes single-pass and leaves normal-blended ones alone', () => {
    const scene = new THREE.Scene();
    const add = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const glass = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), add), new THREE.Mesh(new THREE.BoxGeometry(), glass));
    const opt = optimizeScene(scene);
    expect(add.forceSinglePass).toBe(true);
    expect(glass.forceSinglePass).toBe(false);
    expect(opt.report.singlePass).toBe(1);
  });
});
