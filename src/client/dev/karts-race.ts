/**
 * Dev-only QA harness: a real RaceWorld with 8 CPU karts rendered through the real pipeline,
 * scenery and track mesh, so kart/item visuals are exercised by genuine KartState data.
 *   /dev/karts.html?race=<trackId>&follow=<i>&t=<seconds>&chaos=1&q=high
 * Exposes on window:
 *   __advance(s)                 — step sim + visuals at 60 Hz for s seconds
 *   __seek(state, maxS)          — advance until some kart shows `state`; follows it; returns index or -1
 *   __nanCheck(frames)           — step `frames` frames checking every visual matrix for NaN/Infinity
 *   __coverage                   — frames observed per visual state
 */
import * as THREE from 'three';
import { RaceWorld } from '../../sim/race.js';
import { CHARACTERS } from '../../sim/characters.js';
import { ITEMS, ITEM_IDS } from '../../sim/item-defs.js';
import type { ItemId, KartState, RaceConfig } from '../../sim/types.js';
import type { KartPose, KartVisual, ResolvedQuality } from '../render/contracts.js';
import { createRenderPipeline } from '../render/renderer.js';
import { getSceneryBuilder } from '../render/themes/index.js';
import { buildTrackMesh } from '../render/track-mesh.js';
import { createCameraRig } from '../render/camera.js';
import { createKartVisual } from '../render/kart-model.js';
import { createPickupVisuals, createProjectileVisuals } from '../render/item-models.js';

type Pred = (k: KartState) => boolean;
const STATES: Record<string, Pred> = {
  drift1: k => k.driftDir !== 0 && k.driftLevel === 1,
  drift2: k => k.driftDir !== 0 && k.driftLevel === 2,
  drift3: k => k.driftDir !== 0 && k.driftLevel === 3,
  boost: k => k.boostTime > 0,
  mini3: k => k.boostTime > 0 && k.boostKind === 'mini3',
  spin: k => k.spinTime > 0 && k.spinTime <= 1.05,
  squash: k => k.spinTime > 1.05,
  tumble: k => k.tumbleTime > 0,
  shrink: k => k.shrinkTime > 0,
  star: k => k.starTime > 0,
  autopilot: k => k.autopilotTime > 0,
  respawn: k => k.respawnTime > 0,
  trick: k => k.trickTime > 0,
  hop: k => k.hopTime > 0,
  air: k => !k.grounded,
  stall: k => k.stallTime > 0,
  invuln: k => k.invulnTime > 0,
  orbit: k => k.held.some(h => h.slot > 0 && h.kind !== 'banana'),
  trail: k => k.held.some(h => h.slot === 0),
  banana3: k => k.held.length > 1 && k.held[0]!.kind === 'banana',
  finished: k => k.finished,
};

export function startRacePreview(app: HTMLElement, hud: HTMLElement, qs: URLSearchParams): void {
  const level = (qs.get('q') ?? 'high') as ResolvedQuality;
  const trackId = qs.get('race') || 'sunny-meadow';
  const chaos = qs.get('chaos') === '1';
  let follow = Number(qs.get('follow') ?? '0');
  const pipeline = createRenderPipeline(app, level);
  const renderer = pipeline.renderer;
  const q = pipeline.quality;
  const config: RaceConfig = {
    trackId, mode: 'vs', cc: 150, cpuLevel: 'hard', mirror: false,
    racers: CHARACTERS.map(c => ({ charId: c.id, human: -1 })), items: true, seed: Number(qs.get('seed') ?? '7'),
  };
  const world = new RaceWorld(config);
  const track = world.track;
  const scene = new THREE.Scene();
  const scenery = getSceneryBuilder(track.def.theme)({ scene, track, quality: q, renderer });
  pipeline.applyEnvironment(scene, scenery.environment);
  const trackMesh = buildTrackMesh(track, track.def.theme, q);
  scene.add(trackMesh.group);
  const visuals: KartVisual[] = world.karts.map(k => { const v = createKartVisual(k.charId, q); scene.add(v.root); return v; });
  const pickups = createPickupVisuals(world.itemBoxes.length, world.coins.length, q);
  scene.add(pickups.group);
  const projectiles = createProjectileVisuals(q);
  scene.add(projectiles.group);
  const rig = createCameraRig();
  const poses: KartPose[] = world.karts.map(k => ({ x: k.x, y: k.y, z: k.z, yaw: k.yaw }));
  const coverage: Record<string, number> = {};
  const focus = new THREE.Vector3();
  let time = 0;
  let rng = 12345;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };

  const step = (dt: number, render: boolean) => {
    time += dt;
    world.step([]);
    world.drainEvents();
    if (chaos && world.phase === 'racing' && Math.floor(time * 60) % 90 === 0) {
      for (const k of world.karts) {
        if (k.item || k.respawnTime > 0 || k.finished) continue;
        const id = ITEM_IDS[Math.floor(rand() * ITEM_IDS.length)] as ItemId;
        k.item = id; k.itemUses = ITEMS[id].uses; k.rouletteTime = 0;
      }
    }
    for (let i = 0; i < world.karts.length; i++) {
      const k = world.karts[i]!;
      const p = poses[i]!;
      p.x = k.x; p.y = k.y; p.z = k.z; p.yaw = k.yaw;
      visuals[i]!.update(k, p, dt, { lookBack: false, throttle: true, time });
      for (const [name, pred] of Object.entries(STATES)) if (pred(k)) coverage[name] = (coverage[name] ?? 0) + 1;
    }
    pickups.update(world.itemBoxes, world.coins, dt, time);
    projectiles.update(world.projectiles, dt, time);
    scenery.update(dt, time, rig.camera);
    trackMesh.update(dt, time);
    if (render) camFollow(dt);
  };
  const camFollow = (dt: number) => {
    const k = world.karts[follow] ?? world.karts[0]!;
    visuals[follow]!.focus(focus);
    rig.follow({
      pose: poses[follow]!, focus, speed: k.speed, maxSpeed: k.maxSpeed, boosting: k.boostTime > 0 || k.autopilotTime > 0,
      driftAngle: k.driftAngle, airborne: !k.grounded, lookBack: false, distance: (qs.get('dist') as 'near' | 'normal' | 'far') ?? 'normal',
    }, dt, track);
  };

  const w = window as unknown as Record<string, unknown>;
  w.__world = world;
  w.__visuals = visuals;
  w.__projVisuals = projectiles;
  w.__pickupVisuals = pickups;
  w.__advance = (s: number) => { for (let i = 0; i < Math.round(s * 60); i++) step(1 / 60, false); rig.reset(); camFollow(1 / 60); };
  w.__coverage = coverage;
  w.__setFollow = (i: number) => { follow = i; rig.reset(); camFollow(1 / 60); };
  w.__seek = (state: string, maxS: number) => {
    const pred = STATES[state];
    if (!pred) return -1;
    for (let i = 0; i < Math.round(maxS * 60); i++) {
      step(1 / 60, false);
      const idx = world.karts.findIndex(pred);
      if (idx >= 0) { follow = idx; rig.reset(); camFollow(1 / 60); return idx; }
    }
    return -1;
  };
  const bad: string[] = [];
  const checkObj = (o: THREE.Object3D, tag: string) => {
    o.updateMatrixWorld(true);
    o.traverse(c => {
      const e = c.matrixWorld.elements;
      for (let j = 0; j < 16; j++) if (!Number.isFinite(e[j]!)) { if (bad.length < 20) bad.push(`${tag}:${c.name || c.type}`); return; }
      const im = c as THREE.InstancedMesh;
      if (im.isInstancedMesh) {
        const a = im.instanceMatrix.array;
        for (let j = 0; j < im.count * 16; j++) if (!Number.isFinite(a[j]!)) { if (bad.length < 20) bad.push(`${tag}:inst:${c.name || c.type}`); return; }
      }
    });
  };
  w.__nanCheck = (frames: number) => {
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) {
      step(1 / 60, false);
      if (f % 6 === 0) {
        visuals.forEach((v, i) => checkObj(v.root, `kart${i}`));
        checkObj(pickups.group, 'pickups');
        checkObj(projectiles.group, 'proj');
        for (const v of visuals) { v.focus(focus); if (!Number.isFinite(focus.x + focus.y + focus.z)) bad.push('focus'); }
      }
    }
    return { bad, ms: (performance.now() - t0) / frames, phase: world.phase, tick: world.tick };
  };
  w.__kartCalls = () => {
    // per-kart visible draw calls / triangles
    return visuals.map((v, i) => {
      let calls = 0, tris = 0;
      v.root.traverseVisible(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh && !(o as THREE.Points).isPoints) return;
        const g = m.geometry;
        const n = g.index ? g.index.count / 3 : g.attributes.position!.count / 3;
        const inst = (m as unknown as THREE.InstancedMesh).isInstancedMesh ? (m as unknown as THREE.InstancedMesh).count : 1;
        calls++; tris += (m as unknown as THREE.Points).isPoints ? 0 : n * inst;
      });
      return `${world.karts[i]!.charId}:${calls}c/${Math.round(tris)}t`;
    }).join(' ');
  };

  // warm-up: pre-simulate
  const preT = Number(qs.get('t') ?? '6');
  for (let i = 0; i < Math.round(preT * 60); i++) step(1 / 60, false);
  rig.reset();
  camFollow(1 / 60);

  let last = performance.now();
  let frames = 0;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dt = qs.has('freeze') ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    if (dt > 0) step(dt, true); else camFollow(0);
    const size = pipeline.resize();
    rig.setAspect(size.width / Math.max(1, size.height));
    const k = world.karts[follow]!;
    pipeline.setShadowFocus(k.x, k.y, k.z);
    pipeline.render(scene, [{ camera: rig.camera, viewport: { x: 0, y: 0, w: size.width, h: size.height }, speedLines: 0, inkAmount: 0 }], dt);
    frames++;
    const info = renderer.info;
    w.__stats = { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures, follow, phase: world.phase };
    hud.textContent = `${trackId} follow ${follow} (${k.charId})  calls ${info.render.calls}  tris ${info.render.triangles}`;
    if (frames === 3) w.__ready = true;
  };
  requestAnimationFrame(loop);
}
