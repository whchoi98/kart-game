/**
 * Dev preview for kart/driver/item assets and the showroom.
 *   /dev/karts.html                      → 8 karts line-up + state row + items
 *   ?view=lineup|states|items|close|back|all
 *   ?char=pip&view=close                 → close-up of one driver (front 3/4)
 *   ?mode=title|garage|podium            → showroom modes
 *   ?q=low|medium|high                   → quality preset
 *   ?t=seconds                           → pre-simulate this much time before signalling ready
 *   ?race=<trackId>[&follow=i&chaos=1]  → real RaceWorld (8 CPUs) through the real pipeline (see karts-race.ts)
 *   ?pipe=real                           → asset/showroom preview through the real RenderPipeline (bloom)
 */
import * as THREE from 'three';
import { CHARACTERS } from '../../sim/characters.js';
import type { CharacterId, KartState, ProjectileKind } from '../../sim/types.js';
import type { KartVisual, ResolvedQuality } from '../render/contracts.js';
import { createDisplayKartState, createKartVisual } from '../render/kart-model.js';
import { createPickupVisuals, createProjectileVisuals } from '../render/item-models.js';
import { createShowroom } from '../render/showroom.js';
import { buildTestStage, createStandInPipeline } from './karts-stage.js';
import { startRacePreview } from './karts-race.js';
import { createRenderPipeline } from '../render/renderer.js';

/** Test hooks (kept off the global Window type so other dev pages can declare their own). */
const W = window as unknown as { __ready?: boolean; __stats?: Record<string, unknown>; __advance?: (s: number) => void };

const qs = new URLSearchParams(location.search);
const level = (qs.get('q') ?? 'high') as ResolvedQuality;
const view = qs.get('view') ?? 'all';
const mode = qs.get('mode') as 'title' | 'garage' | 'podium' | null;
const charParam = (qs.get('char') ?? 'pip') as CharacterId;
const preT = Number(qs.get('t') ?? '1.5');
const app = document.getElementById('app')!;
const hud = document.getElementById('hud')!;
function assetPreview(): void {
  // ?pipe=real renders through the game's RenderPipeline (bloom, exposure governor) instead of the stand-in
  const pipeline = qs.get('pipe') === 'real' ? createRenderPipeline(app, level) : createStandInPipeline(app, level);
  const renderer = pipeline.renderer;

  let frame: (dt: number, time: number) => void;
  let getCam: () => THREE.PerspectiveCamera;
  let getScene: () => THREE.Scene;

  if (mode) {
    const room = createShowroom(pipeline);
    const chars = mode === 'garage' ? [charParam] : mode === 'podium' ? (qs.get('chars')?.split(',') as CharacterId[] ?? ['mochi', 'bruno', 'kiki']) : CHARACTERS.map(c => c.id);
    room.show(mode, chars);
    frame = (dt, time) => room.update(dt, time);
    getCam = () => room.camera;
    getScene = () => room.scene;
    (window as unknown as { __room: unknown }).__room = room;
    /** Leak check: build a second showroom through every mode, render it, dispose it. */
    (window as unknown as { __roomCycle: () => unknown }).__roomCycle = () => {
      const r2 = createShowroom(pipeline);
      const mem = () => ({ geo: renderer.info.memory.geometries, tex: renderer.info.memory.textures });
      const before = mem();
      for (const [m, c] of [['title', []], ['garage', ['rex']], ['garage', ['hana']], ['podium', ['mochi', 'bruno', 'kiki']]] as const) {
        r2.show(m, [...c]);
        for (let i = 0; i < 3; i++) { r2.update(1 / 60, i / 60); renderer.render(r2.scene, r2.camera); }
      }
      const during = mem();
      r2.dispose();
      renderer.render(new THREE.Scene(), r2.camera);
      return { before, during, after: mem() };
    };
  } else {
    const scene = new THREE.Scene();
    buildTestStage(scene, pipeline.quality.shadows);
    const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 500);
    getCam = () => camera; getScene = () => scene;

    interface Entry { v: KartVisual; k: KartState; x: number; z: number; yaw: number; anim?: (k: KartState, t: number) => void; lookBack?: boolean; throttle?: boolean; ghost?: boolean }
    const entries: Entry[] = [];
    const add = (id: CharacterId, x: number, z: number, yaw: number, anim?: Entry['anim'], extra: Partial<Entry> = {}) => {
      const v = createKartVisual(id, pipeline.quality);
      scene.add(v.root);
      const k = createDisplayKartState(id, entries.length);
      k.x = x; k.z = z; k.yaw = yaw;
      k.lastSafe = { x, y: 0, z, yaw, i: 0, progress: 0 };
      entries.push({ v, k, x, z, yaw, anim, ...extra });
      return entries[entries.length - 1]!;
    };
    // row 1: line-up
    CHARACTERS.forEach((c, i) => add(c.id, (i - 3.5) * 2.7, 0, 0.35 * Math.sin(i * 1.7)));
    const rowsOnly1 = qs.get('rows') === '1';
    const S = (i: number) => (i - 3.5) * 3.2;
    const zS = -7, zT = -14;
    // row 2: states
    if (!rowsOnly1) {
    add('kiki', S(0), zS, 0, (k, t) => { k.driftDir = 1; k.driftLevel = 3; k.driftAngle = -0.42; k.steerVisual = 0.8; k.speed = 24; k.grounded = true; void t; });
    add('rex', S(1), zS, 0, (k) => { k.boostTime = 0.8; k.boostKind = 'mini3'; k.speed = 30; });
    add('hana', S(2), zS, 0, (k) => { k.starTime = 5; k.speed = 30; k.boostTime = 0.5; k.boostKind = 'nitro'; });
    add('mochi', S(3), zS, 0, (k) => { k.shrinkTime = 5; k.speed = 18; });
    add('bolt', S(4), zS, 0, (k) => { k.autopilotTime = 4; k.speed = 44; });
    add('bruno', S(5), zS, 0, (k) => { k.respawnTime = 0.62; });
    add('taro', S(6), zS, 0, (k, t) => { const c = t % 2.2; k.tumbleTime = c < 1.45 ? 1.45 - c : 0; k.grounded = c > 1.45; });
    add('pip', S(7), zS, 0, (k) => {
      k.held = [{ kind: 'orb', slot: 1 }, { kind: 'orb', slot: 2 }, { kind: 'orb', slot: 3 }]; k.speed = 12;
    });
    // row 3: more states
    add('pip', S(0), zT, 0, (k, t) => { const c = t % 1.6; k.spinTime = c < 1.05 ? 1.05 - c : 0; });
    add('bruno', S(1), zT, 0, (k, t) => { const c = t % 2.4; k.spinTime = c < 1.6 ? 1.6 - c : 0; k.shrinkTime = 3; });
    add('mochi', S(2), zT, 0, (k) => { k.held = [{ kind: 'banana', slot: 0 }, { kind: 'banana', slot: 1 }, { kind: 'banana', slot: 2 }]; k.speed = 10; });
    add('rex', S(3), zT, 0, (k) => { k.held = [{ kind: 'rocket', slot: 1 }, { kind: 'rocket', slot: 2 }, { kind: 'rocket', slot: 3 }]; });
    add('taro', S(4), zT, 0, (k) => { k.stallTime = 1; });
    add('kiki', S(5), zT, 0, (k) => { k.driftDir = -1; k.driftLevel = 1; k.driftAngle = 0.38; k.steerVisual = -0.9; k.speed = 22; });
    add('hana', S(6), zT, 0, (k) => { k.driftDir = 1; k.driftLevel = 2; k.driftAngle = -0.38; k.steerVisual = 0.9; k.speed = 22; k.boostTime = 0.4; k.boostKind = 'mini1'; });
    add('bolt', S(7), zT, 0, (k, t) => { const c = t % 1.2; k.trickTime = c < 0.55 ? 0.55 - c : 0; k.grounded = c > 0.55; }, { lookBack: false });
    // row 4: ghost, look-back, rabbit at speed, held single rocket / orb
    const zU = -21;
    add('mochi', S(0), zU, 0, (k) => { k.speed = 28; k.steerVisual = 0.3; });
    add('kiki', S(1), zU, 0, (k) => { k.speed = 20; }, { lookBack: true });
    add('hana', S(2), zU, 0, (k) => { k.speed = 20; k.held = [{ kind: 'rocket', slot: 0 }]; });
    add('pip', S(3), zU, 0, (k) => { k.speed = 20; k.held = [{ kind: 'orb', slot: 0 }]; });
    add('rex', S(4), zU, 0, (k) => { k.speed = 20; k.invulnTime = 1; });
    const ghost = add('bolt', S(5), zU, 0, (k) => { k.speed = 20; });
    ghost.ghost = true;
    add('taro', S(6), zU, 0, (k) => { k.speed = 20; k.held = [{ kind: 'banana', slot: 0 }]; });
    add('bruno', S(7), zU, 0, (k, t) => { const c = t % 1.4; k.hopTime = c < 0.3 ? 0.3 - c : 0; k.grounded = c > 0.3; k.y = c < 0.3 ? Math.sin(c / 0.3 * Math.PI) * 0.3 : 0; });
    }

    // items
    const boxes = [-6, -3, 0, 3, 6].map(x => ({ x, y: 1.05, z: 22, active: true }));
    const coins = Array.from({ length: 8 }, (_, i) => ({ x: -5.25 + i * 1.5, y: 0.8, z: 25, active: true }));
    const pick = createPickupVisuals(boxes.length, coins.length, pipeline.quality);
    scene.add(pick.group);
    const proj = createProjectileVisuals(pipeline.quality);
    scene.add(proj.group);
    const projectiles: Array<{ id: number; kind: ProjectileKind; x: number; y: number; z: number; vx: number; vz: number; state: string }> = [
      { id: 1, kind: 'banana', x: -6, y: 0.35, z: 28, vx: 0, vz: 0, state: 'rest' },
      { id: 2, kind: 'banana', x: -4.8, y: 0.35, z: 28.8, vx: 0, vz: 0, state: 'rest' },
      { id: 3, kind: 'orb', x: -2, y: 0.5, z: 28, vx: 10, vz: 10, state: 'fly' },
      { id: 4, kind: 'rocket', x: 1.5, y: 0.5, z: 28, vx: 30, vz: 12, state: 'fly' },
      { id: 5, kind: 'skybomb', x: 5, y: 1.4, z: 28, vx: 20, vz: 8, state: 'cruise' },
    ];

    const views: Record<string, [THREE.Vector3, THREE.Vector3, number]> = {
      all: [new THREE.Vector3(12, 16, 40), new THREE.Vector3(0, 0.4, 4), 42],
      lineup: [new THREE.Vector3(0, 3.6, 13.5), new THREE.Vector3(0, 0.8, 0), 40],
      states: [new THREE.Vector3(0, 5.2, 4.5), new THREE.Vector3(0, 1.0, zS), 46],
      states2: [new THREE.Vector3(0, 5.2, -2.5), new THREE.Vector3(0, 1.0, zT), 46],
      items: [new THREE.Vector3(0, 3.2, 35.5), new THREE.Vector3(0, 0.8, 25), 42],
      itemsClose: [new THREE.Vector3(-3.2, 2.2, 32.5), new THREE.Vector3(-3.2, 0.5, 28), 40],
      statesBack: [new THREE.Vector3(3, 4.2, -16.5), new THREE.Vector3(0, 0.8, zS), 50],
      states2Back: [new THREE.Vector3(3, 4.2, -23.5), new THREE.Vector3(0, 0.8, zT), 50],
      row4: [new THREE.Vector3(3, 4.6, -30.5), new THREE.Vector3(0, 0.8, -21), 48],
      race: [new THREE.Vector3(0, 9, 30), new THREE.Vector3(0, 0.5, 8), 50],
    };
    const setView = () => {
      if (view === 'chase' || view === 'front') {
        const e = entries[Number(qs.get('idx') ?? '8')]!;
        const back = view === 'chase';
        camera.position.set(e.x + (back ? 1.4 : 1.6), back ? 2.1 : 1.3, e.z + (back ? -4.6 : 4.2));
        camera.fov = 40;
        camera.lookAt(e.x, 0.6, e.z);
      } else if (view === 'face') {
        const i = CHARACTERS.findIndex(c => c.id === charParam);
        const e = entries[i]!;
        const dir = new THREE.Vector3(0.5, 0.25, 1.9).applyAxisAngle(new THREE.Vector3(0, 1, 0), e.yaw);
        camera.position.set(e.x, 1.15, e.z).add(dir);
        camera.fov = 30;
        camera.lookAt(e.x, 1.08, e.z - 0.2);
      } else if (view === 'close' || view === 'back' || view === 'side' || view === 'top') {
        const i = CHARACTERS.findIndex(c => c.id === charParam);
        const e = entries[i]!;
        const p = new THREE.Vector3(e.x, 0.9, e.z);
        const dir = view === 'close' ? new THREE.Vector3(1.6, 0.9, 3.6) : view === 'back' ? new THREE.Vector3(-0.8, 1.9, -5.2) : view === 'side' ? new THREE.Vector3(4.6, 0.9, 0.3) : new THREE.Vector3(0.1, 5.5, 0.6);
        dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), e.yaw);
        camera.position.copy(p).add(dir);
        camera.fov = 34;
        camera.lookAt(p.x, view === 'close' ? 0.85 : 0.7, p.z);
      } else {
        const [pos, tgt, fov] = views[view] ?? views.all!;
        camera.position.copy(pos); camera.fov = fov; camera.lookAt(tgt);
      }
      camera.updateProjectionMatrix();
    };
    setView();

    frame = (dt, time) => {
      for (const e of entries) {
        const k = e.k;
        k.x = e.x; k.z = e.z; k.yaw = e.yaw;
        e.anim?.(k, time);
        k.steerVisual = e.anim ? k.steerVisual : Math.sin(time * 0.9 + e.x) * 0.5;
        e.v.update(k, { x: k.x, y: k.y, z: k.z, yaw: k.yaw }, dt, { lookBack: !!e.lookBack, throttle: e.throttle ?? view === 'face', time, ghost: !!e.ghost });
      }
      for (const p of projectiles) if (p.kind !== 'banana') { /* keep in place (preview) */ }
      pick.update(boxes, coins, dt, time);
      proj.update(projectiles, dt, time);
    };
    (window as unknown as { __entries: unknown }).__entries = entries;
    // CPU cost of KartVisual.update for all entries (ms per frame)
    (window as unknown as { __bench: (n: number) => number }).__bench = (n: number) => {
      const t0 = performance.now();
      for (let f = 0; f < n; f++) {
        const time = f / 60;
        for (const e of entries) { e.anim?.(e.k, time); e.v.update(e.k, { x: e.x, y: e.k.y, z: e.z, yaw: e.yaw }, 1 / 60, { lookBack: false, throttle: true, time }); }
        pick.update(boxes, coins, 1 / 60, time);
        proj.update(projectiles, 1 / 60, time);
      }
      return (performance.now() - t0) / n;
    };
    // per-kart budget report: draw calls (visible meshes) + triangles for the first 8 karts
    (window as unknown as { __parts: () => unknown }).__parts = () => entries.slice(0, 8).map(e => {
      let calls = 0, tris = 0;
      e.v.root.traverseVisible(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh && !(o as THREE.Points).isPoints) return;
        const g = m.geometry;
        const n = g.index ? g.index.count / 3 : g.attributes.position!.count / 3;
        const inst = (m as unknown as THREE.InstancedMesh).isInstancedMesh ? (m as unknown as THREE.InstancedMesh).count : 1;
        calls++; tris += (m as unknown as THREE.Points).isPoints ? 0 : n * inst;
      });
      return `${e.k.charId}:${calls}c/${Math.round(tris)}t`;
    }).join(' ');
  }

  /** Leak check: build a full race set in a separate scene, render, dispose, render again. */
  (window as unknown as { __disposeTest: () => unknown }).__disposeTest = () => {
    const sc = new THREE.Scene();
    sc.add(new THREE.HemisphereLight('#ffffff', '#444444', 1));
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    cam.position.set(0, 5, 14); cam.lookAt(0, 0, 0);
    renderer.info.reset();
    renderer.render(sc, cam);
    const before = { geo: renderer.info.memory.geometries, tex: renderer.info.memory.textures };
    const vs = CHARACTERS.map(c => createKartVisual(c.id, pipeline.quality));
    const pk = createPickupVisuals(4, 4, pipeline.quality);
    const pr = createProjectileVisuals(pipeline.quality);
    vs.forEach((v, i) => { sc.add(v.root); const k = createDisplayKartState(v.charId, i); k.x = i * 2.5 - 9; k.held = [{ kind: 'orb', slot: 1 }]; k.autopilotTime = i === 0 ? 2 : 0; k.respawnTime = i === 1 ? 0.8 : 0; k.driftDir = 1; k.driftLevel = 2; v.update(k, { x: k.x, y: 0, z: 0, yaw: 0 }, 1 / 60, { lookBack: false, throttle: true, time: 0 }); });
    sc.add(pk.group, pr.group);
    pk.update([{ x: 0, y: 1, z: 2, active: true }], [{ x: 1, y: 1, z: 2, active: true }], 1 / 60, 0);
    pr.update([{ id: 1, kind: 'banana', x: 0, y: 0.3, z: 4, vx: 0, vz: 0, state: 'rest' }, { id: 2, kind: 'skybomb', x: 2, y: 3, z: 4, vx: 1, vz: 0, state: 'cruise' }], 1 / 60, 0);
    renderer.render(sc, cam);
    const during = { geo: renderer.info.memory.geometries, tex: renderer.info.memory.textures };
    vs.forEach(v => v.dispose()); pk.dispose(); pr.dispose();
    renderer.render(sc, cam);
    const after = { geo: renderer.info.memory.geometries, tex: renderer.info.memory.textures };
    return { before, during, after };
  };

  let time = 0;
  const step = (dt: number) => {
    time += dt;
    frame(dt, time);
  };
  // pre-simulate at 60 Hz for deterministic screenshots
  for (let i = 0; i < Math.round(preT * 60); i++) step(1 / 60);

  let last = performance.now();
  let frames = 0;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dt = qs.has('freeze') ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    const size = pipeline.resize();
    const cam = getCam();
    cam.aspect = size.width / Math.max(1, size.height);
    cam.updateProjectionMatrix();
    pipeline.render(getScene(), [{ camera: cam, viewport: { x: 0, y: 0, w: size.width, h: size.height }, speedLines: 0, inkAmount: 0 }], dt);
    const info = renderer.info;
    frames++;
    W.__stats = {
      parts: (window as unknown as { __parts?: () => unknown }).__parts?.(), calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length ?? 0 };
    hud.textContent = `calls ${info.render.calls}  tris ${info.render.triangles}  geo ${info.memory.geometries}  tex ${info.memory.textures}`;
    if (frames === 3) W.__ready = true;
  };
  requestAnimationFrame(loop);
  W.__advance = (s: number) => { for (let i = 0; i < Math.round(s * 60); i++) step(1 / 60); };
}

if (qs.has('race')) startRacePreview(app, hud, qs);
else assetPreview();
