/**
 * Dev preview for render/track-mesh.ts.
 *   /dev/track.html?track=<id>&theme=<theme>&quality=high|medium|low&mirror=1&view=<name>&hud=0
 * track may also be 'test-figure8' (synthetic layout with bridge, overpass, walls, zones, ramps).
 * Exposes window.__ready, __views, __show(view,time), __stats, __breakdown, __disposeTest and __validate for the QA script.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { buildTrack, getBuiltTrack } from '../../sim/track-builder.js';
import { getTrackDef } from '../../sim/tracks/index.js';
import type { BuiltTrack, ThemeId, TrackDef } from '../../sim/types.js';
import { QUALITY_PRESETS, type EnvironmentSettings, type ResolvedQuality } from '../render/contracts.js';
import { THEME_PALETTES } from '../render/theme-palette.js';
import { buildTerrain } from '../render/terrain.js';
import { buildTrackMesh, type TrackMesh } from '../render/track-mesh.js';

/** QA hooks. Kept off the global Window type so they never clash with other dev pages' declarations. */
interface PreviewHooks {
  __ready?: boolean;
  __error?: string;
  __views?: string[];
  __show?: (view: string, time?: number) => Promise<Record<string, number | string>>;
  __stats?: Record<string, unknown>;
  __breakdown?: Array<[string, number]>;
  __disposeTest?: () => unknown;
  __validate?: () => unknown;
}
const W = window as unknown as PreviewHooks;

const P = (x: number, y: number, z: number, w?: number, bank?: number) => ({ p: [x, y, z] as [number, number, number], w, bank });

/** Synthetic QA layout: figure-8 with an overpass bridge, pit edges, walls, zones and both ramp kinds. */
const TEST_FIGURE8: TrackDef = {
  id: 'test-figure8', name: '테스트', nameEn: 'Test Figure 8', cup: 'sprout', order: 9, theme: 'volcano', laps: 3,
  halfWidth: 9, shoulder: 8, defaultEdge: 'offroad', startAt: 0.35,
  points: [
    P(0, 0, -60), P(0, 0, 30), P(25, 0.5, 85, 9.5), P(85, 2, 100), P(135, 5, 60, 9, 0.05), P(125, 8, 5),
    P(60, 10.5, 0), P(0, 11, 0, 8.5), P(-60, 10.5, 0), P(-125, 7, -15), P(-130, 4, -80, 9, 0.05), P(-75, 1, -115), P(-20, 0, -105),
  ],
  edges: [
    { from: 5.6, to: 8.6, side: 'both', kind: 'pit' },
    { from: 2.1, to: 2.9, side: 'both', kind: 'wall' },
    { from: 9.3, to: 10.2, side: 'left', kind: 'pit' },
  ],
  surfaces: [
    { from: 3.1, to: 3.8, kind: 'ice' },
    { from: 10.4, to: 10.9, dFrom: -9, dTo: 0, kind: 'mud' },
    { from: 11.2, to: 11.8, dFrom: 2, dTo: 9, kind: 'dirt' },
  ],
  boostPads: [{ at: 4.3, d: 3 }, { at: 12.3, d: -3 }],
  ramps: [{ at: 1.25, length: 12, height: 2, trick: true }, { at: 10.95, length: 10, height: 1.4 }],
  landmarks: [
    { kind: 'grandstand', at: 0.2, side: 'left', dist: 24 },
    { kind: 'grandstand', at: 0.55, side: 'right', dist: 24, scale: 0.8 },
    { kind: 'arch', at: 2.5, side: 'over', dist: 0 },
    { kind: 'banner', at: 4.6, side: 'left', dist: 0 },
    { kind: 'banner', at: 9.0, side: 'over', dist: 0 },
    // side banners beside pit edges (bridge / one-sided pit): must stand on an outrigger, not float
    { kind: 'banner', at: 7.0, side: 'right', dist: 20 },
    { kind: 'banner', at: 9.7, side: 'left', dist: 18 },
    { kind: 'windmill', at: 3.6, side: 'left', dist: 46 },
  ],
  music: { bpm: 150, key: 'C', mood: 'bright' }, scenerySeed: 42, parLap: 40,
};

/** Copies of the theme scenery EnvironmentSettings (render/themes/*.ts) so the preview is lit like the game
 *  without depending on the (concurrently edited) scenery modules. */
const ENV: Record<ThemeId, EnvironmentSettings> = {
  meadow: { skyTop: '#3a8ef0', skyHorizon: '#c4e8ff', skyBottom: '#8fcf6e', fogColor: '#cbe7fb', fogNear: 160, fogFar: 1050,
    sunColor: '#fff2d9', sunIntensity: 2.7, sunDir: [0.42, 0.78, 0.46], hemiSky: '#d2ecff', hemiGround: '#6aa84a', hemiIntensity: 1.05,
    exposure: 1.0, night: false, bloomStrength: 0.22 },
  beach: { skyTop: '#2b93e6', skyHorizon: '#bdf0ff', skyBottom: '#f2d49b', fogColor: '#d3f1fb', fogNear: 170, fogFar: 1150,
    sunColor: '#fff0cc', sunIntensity: 2.45, sunDir: [0.5, 0.66, -0.56], hemiSky: '#c4ecff', hemiGround: '#d9b98a', hemiIntensity: 0.9,
    exposure: 0.96, night: false, bloomStrength: 0.26 },
  canyon: { skyTop: '#4d86d1', skyHorizon: '#ffc58c', skyBottom: '#d9895b', fogColor: '#f1b98c', fogNear: 150, fogFar: 980,
    sunColor: '#ffc27d', sunIntensity: 2.7, sunDir: [0.74, 0.36, 0.48], hemiSky: '#ffd8b0', hemiGround: '#a8583a', hemiIntensity: 0.85,
    exposure: 1.0, night: false, bloomStrength: 0.3 },
  city: { skyTop: '#07082a', skyHorizon: '#3b1f6e', skyBottom: '#120d24', fogColor: '#231946', fogNear: 110, fogFar: 880,
    sunColor: '#a9b8ff', sunIntensity: 0.9, sunDir: [-0.38, 0.62, -0.68], hemiSky: '#5b4bb8', hemiGround: '#1c1233', hemiIntensity: 0.7,
    exposure: 1.12, night: true, bloomStrength: 0.9 },
  snow: { skyTop: '#2c7be0', skyHorizon: '#cfeaff', skyBottom: '#eef6fb', fogColor: '#d9eefc', fogNear: 170, fogFar: 1050,
    sunColor: '#fff4e2', sunIntensity: 2.7, sunDir: [0.45, 0.62, -0.64], hemiSky: '#d7ecff', hemiGround: '#9fb9d4', hemiIntensity: 1.05,
    exposure: 0.98, night: false, bloomStrength: 0.3 },
  jungle: { skyTop: '#3a93d2', skyHorizon: '#d4eed2', skyBottom: '#a8cdb0', fogColor: '#b9dcc2', fogNear: 80, fogFar: 700,
    sunColor: '#fff0c4', sunIntensity: 2.5, sunDir: [-0.38, 0.7, 0.6], hemiSky: '#d6f2d8', hemiGround: '#3d5f2c', hemiIntensity: 1.0,
    exposure: 1.05, night: false, bloomStrength: 0.35 },
  volcano: { skyTop: '#16060d', skyHorizon: '#8c2c12', skyBottom: '#3a120a', fogColor: '#4a1a10', fogNear: 90, fogFar: 760,
    sunColor: '#ffa06a', sunIntensity: 2.1, sunDir: [0.3, 0.55, -0.78], hemiSky: '#ff9a64', hemiGround: '#4a1c10', hemiIntensity: 1.05,
    exposure: 1.12, night: true, bloomStrength: 1.0 },
  galaxy: { skyTop: '#04021a', skyHorizon: '#2a1060', skyBottom: '#08031e', fogColor: '#170c40', fogNear: 260, fogFar: 1400,
    sunColor: '#dcd8ff', sunIntensity: 1.7, sunDir: [0.35, 0.72, 0.25], hemiSky: '#8a7cff', hemiGround: '#24104a', hemiIntensity: 0.95,
    exposure: 1.1, night: true, bloomStrength: 1.1 },
};

const qs = new URLSearchParams(location.search);
const trackId = qs.get('track') ?? 'sunny-meadow';
const mirror = qs.get('mirror') === '1';
const level = (qs.get('quality') ?? 'high') as ResolvedQuality;
const hud = document.getElementById('hud')!;
if (qs.get('hud') === '0') hud.classList.add('hidden');

function loadTrack(): BuiltTrack {
  const themeOverride = qs.get('theme') as ThemeId | null;
  if (trackId === 'test-figure8') {
    return buildTrack({ ...TEST_FIGURE8, theme: themeOverride ?? TEST_FIGURE8.theme }, { mirror });
  }
  if (themeOverride) return buildTrack({ ...getTrackDef(trackId), theme: themeOverride }, { mirror });
  return getBuiltTrack(trackId, mirror);
}

function skyDome(top: string, horizon: string, bottom: string): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1800, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(top) }, horizon: { value: new THREE.Color(horizon) }, bottom: { value: new THREE.Color(bottom) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; varying vec3 vP;
      void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(horizon, top, pow(clamp(h,0.0,1.0), 0.6)) : mix(horizon, bottom, clamp(-h*4.0,0.0,1.0));
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  });
  return new THREE.Mesh(geo, mat);
}

async function main(): Promise<void> {
  const track = loadTrack();
  const theme = track.def.theme;
  const pal = THEME_PALETTES[theme];
  const env = ENV[theme];
  const quality = { ...QUALITY_PRESETS[level], shadowMapSize: 2048 };

  const container = document.getElementById('app')!;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = env.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(env.fogColor, env.fogNear, env.fogFar);
  scene.add(skyDome(env.skyTop, env.skyHorizon, env.skyBottom));

  const hemi = new THREE.HemisphereLight(env.hemiSky, env.hemiGround, env.hemiIntensity);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(env.sunColor, env.sunIntensity);
  sun.castShadow = quality.shadows;
  sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -110; sc.right = 110; sc.top = 110; sc.bottom = -110; sc.near = 1; sc.far = 600;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  const terrain = buildTerrain(track, { ground: pal.ground, groundAlt: pal.groundAlt, pitColor: pal.pitColor, seed: track.def.scenerySeed });
  scene.add(terrain.mesh);
  // the galaxy theme has no visible ground (open space)
  if (pal.pit === 'void' && theme === 'galaxy') terrain.mesh.visible = false;
  // simple pit floor so bridges read correctly
  let minY = Infinity;
  for (let i = 0; i < track.n; i++) minY = Math.min(minY, track.py[i]!);
  if (pal.pit !== 'chasm') {
    const pitMat = new THREE.MeshStandardMaterial({
      color: pal.pitColor, roughness: pal.pit === 'water' ? 0.15 : 0.8, metalness: pal.pit === 'water' ? 0.2 : 0,
      emissive: pal.pit === 'lava' ? pal.pitColor : '#000000', emissiveIntensity: pal.pit === 'lava' ? 1.2 : 0,
      transparent: pal.pit === 'water', opacity: 0.92,
    });
    const pitPlane = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), pitMat);
    pitPlane.rotation.x = -Math.PI / 2;
    pitPlane.position.y = minY - (pal.pit === 'void' ? 60 : 12);
    pitPlane.visible = pal.pit !== 'void';
    scene.add(pitPlane);
  }

  const t0 = performance.now();
  const mesh: TrackMesh = buildTrackMesh(track, theme, quality);
  const buildMs = performance.now() - t0;
  scene.add(mesh.group);
  // debug: ?hide=name1,name2 hides track sub-meshes by name (without the 'track:' prefix)
  const hidden = new Set((qs.get('hide') ?? '').split(',').filter(Boolean).map(n => `track:${n}`));
  if (hidden.size) mesh.group.traverse(o => { if (hidden.has(o.name)) o.visible = false; });
  if (qs.get('noterrain') === '1') terrain.mesh.visible = false;
  const breakdown: Array<[string, number]> = [];
  mesh.group.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    const tri = (g.index ? g.index.count : g.attributes.position!.count) / 3 * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
    breakdown.push([m.name, Math.round(tri)]);
  });
  breakdown.sort((a, b) => b[1] - a[1]);
  W.__breakdown = breakdown;
  // geometry sanity: non-finite attributes / instance matrices / bounds, per sub-mesh
  W.__validate = () => {
    const bad: string[] = [];
    let meshes = 0;
    mesh.group.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      meshes++;
      const g = m.geometry;
      for (const name of ['position', 'normal', 'uv', 'color'] as const) {
        const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
        if (!a) { if (name !== 'color') bad.push(`${m.name}: missing ${name}`); continue; }
        const arr = a.array as ArrayLike<number>;
        for (let k = 0; k < arr.length; k++) if (!Number.isFinite(arr[k]!)) { bad.push(`${m.name}: non-finite ${name}`); break; }
      }
      if (g.index) {
        const cnt = g.attributes.position!.count;
        const idx = g.index.array;
        for (let k = 0; k < idx.length; k++) if (idx[k]! >= cnt) { bad.push(`${m.name}: index out of range`); break; }
      }
      g.computeBoundingSphere();
      if (!g.boundingSphere || !Number.isFinite(g.boundingSphere.radius)) bad.push(`${m.name}: bad bounds`);
      const im = m as THREE.InstancedMesh;
      if (im.isInstancedMesh) {
        const arr = im.instanceMatrix.array;
        for (let k = 0; k < im.count * 16; k++) if (!Number.isFinite(arr[k]!)) { bad.push(`${m.name}: non-finite instance matrix`); break; }
      }
    });
    return { meshes, bad };
  };

  const camera = new THREE.PerspectiveCamera(70, container.clientWidth / container.clientHeight, 0.1, 2500);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(container.clientWidth, container.clientHeight), env.bloomStrength, 0.5, 0.82);
  if (quality.bloom) composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ── views ──
  const fwd = (i: number) => { const l = Math.hypot(track.tx[i]!, track.tz[i]!) || 1; return [track.tx[i]! / l, track.tz[i]! / l] as const; };
  const pose = (s: number, d: number, up: number) => {
    const L = track.length;
    const ss = ((s % L) + L) % L;
    const i = Math.floor(ss / track.spacing) % track.n;
    const x = track.px[i]! + track.rx[i]! * d, z = track.pz[i]! + track.rz[i]! * d;
    const y = track.py[i]! + track.ry[i]! * d + track.rampH[i]! + up;
    return new THREE.Vector3(x, y, z);
  };
  const kartEye = (s: number, d: number, lookAhead = 22, lookUp = 1.0) => ({
    pos: pose(s - 2.5, d, 1.6), look: pose(s + lookAhead, d * 0.6, lookUp), fov: 70,
  });
  type View = { pos: THREE.Vector3; look: THREE.Vector3; fov: number; lights?: 3 | 2 | 1 | 0 | null };
  const views = new Map<string, View>();
  const g0 = track.grid[0]!;
  views.set('start', { ...kartEye(g0.s, g0.d, 30, 3.5), lights: 2 });
  views.set('startGo', { ...kartEye(g0.s + 3, -g0.d * 0.2, 30, 3.5), lights: 0 });
  // curb: strongest corner
  let best = 0, bi = 0;
  for (let i = 0; i < track.n; i++) if (Math.abs(track.curvature[i]!) > best && track.edgeR[i] !== 2 && track.edgeL[i] !== 2) { best = Math.abs(track.curvature[i]!); bi = i; }
  const side = track.curvature[bi]! > 0 ? 1 : -1;
  views.set('curb', kartEye(bi * track.spacing - 20, side * track.hw[bi]! * 0.45, 20));
  if (track.ramps.length) {
    const r = track.ramps[0]!;
    views.set('ramp', kartEye(r.s0 - 16, 1.5, 22, 1.2));
    views.set('rampSide', { pos: pose(r.s0 + 4, track.hw[Math.floor(r.s0 / track.spacing) % track.n]! + 9, 3.5), look: pose(r.s0 + 7, 0, 1), fov: 60 });
  }
  if (track.ramps.length > 1) { const r = track.ramps[1]!; views.set('ramp2', kartEye(r.s0 - 16, -1.5, 22, 1.2)); }
  if (track.boostPads.length) {
    const b = track.boostPads[0]!;
    views.set('boost', kartEye(b.s - 10, b.d * 0.7, 14, 0));
    views.set('boostTop', { pos: pose(b.s - 6, b.d, 4.5), look: pose(b.s + 1, b.d, 0), fov: 60 });
  }
  // bridge / pit
  let pitI = -1;
  for (let i = 0; i < track.n; i++) if (track.edgeL[i] === 2 && track.edgeR[i] === 2) { pitI = i; break; }
  if (pitI < 0) for (let i = 0; i < track.n; i++) if (track.edgeL[i] === 2 || track.edgeR[i] === 2) { pitI = i; break; }
  if (pitI >= 0) {
    const s = (pitI + 25) * track.spacing;
    const sd = track.edgeR[(pitI + 25) % track.n] === 2 ? 1 : -1;
    views.set('pitEdge', kartEye(s - 12, sd * 4, 25, 0.5));
    views.set('bridge', { pos: pose(s, sd * 38, -9), look: pose(s + 12, 0, -4), fov: 60 });
  }
  for (const kind of ['ice', 'mud', 'dirt'] as const) {
    const z = track.surfaces.find(q => q.kind === kind);
    if (!z) continue;
    const zi = Math.floor(z.s0 / track.spacing) % track.n;
    const hw = track.hw[zi]!;
    const dc = (Math.max(-hw, z.d0) + Math.min(hw, z.d1)) / 2;
    views.set(kind, { pos: pose(z.s0 - 7, dc * 0.8, 2.2), look: pose(z.s0 + 8, dc, 0), fov: 65 });
  }
  // elevated section: the sample with the largest height over another section within 45 m (terrain hugs the lower one)
  {
    let bestH = 4, ei = -1, ej = -1;
    for (let i = 0; i < track.n; i += 3) {
      for (let j = 0; j < track.n; j += 3) {
        const dl = Math.abs(i - j), loop = Math.min(dl, track.n - dl) * track.spacing;
        if (loop < 80) continue;
        const dx = track.px[i]! - track.px[j]!, dz = track.pz[i]! - track.pz[j]!;
        if (dx * dx + dz * dz > 70 * 70) continue;
        const h = track.py[i]! - track.py[j]!;
        if (h > bestH) { bestH = h; ei = i; ej = j; }
      }
    }
    if (ei >= 0) {
      const up = pose(ei * track.spacing, 0, 0);
      const lowEye = pose(ej * track.spacing, 0, 1.6);
      views.set('elevLow', { pos: lowEye, look: up, fov: 70 });
      const [efx, efz] = fwd(ei);
      const side = new THREE.Vector3(-efz, 0, efx);
      views.set('elevSide', { pos: up.clone().addScaledVector(side, 42).add(new THREE.Vector3(efx * -20, 6 - bestH * 0.4, efz * -20)), look: up.clone().add(new THREE.Vector3(0, -bestH * 0.4, 0)), fov: 60 });
    }
  }
  const stand = track.landmarks.find(l => l.kind === 'grandstand');
  if (stand) {
    views.set('stand', kartEye(stand.s - 14, (stand.side === 'left' ? 1 : -1) * 4, 30, 3));
    const sd = stand.side === 'left' ? -1 : 1;
    const si = Math.floor(stand.s / track.spacing) % track.n;
    views.set('standClose', { pos: pose(stand.s - 12, -sd * 2, 2.2), look: pose(stand.s + 2, sd * (stand.dist + 2), 4.5), fov: 60 });
    void si;
  }
  const arch = track.landmarks.find(l => l.kind === 'arch');
  if (arch) views.set('arch', kartEye(arch.s - 34, 0, 34, 4));
  // over-road banner (prefer one spanning a pit section: its legs must stand on outriggers)
  {
    const overs = track.landmarks.filter(l => l.kind === 'banner' && l.side === 'over');
    const ob = overs.find(l => { const i = Math.floor(l.s / track.spacing) % track.n; return track.edgeL[i] === 2 || track.edgeR[i] === 2; }) ?? overs[0];
    if (ob) {
      const i = Math.floor(ob.s / track.spacing) % track.n;
      views.set('overBanner', kartEye(ob.s - 26, 0, 26, 4));
      views.set('overBannerOut', { pos: pose(ob.s - 16, track.hw[i]! + 18, -2), look: pose(ob.s, 0, 2), fov: 60 });
    }
  }
  // side banner (prefer one beside a pit edge: it must sit on an outrigger)
  {
    const sideBanners = track.landmarks.filter(l => l.kind === 'banner' && l.side !== 'over');
    const onPit = (l: (typeof sideBanners)[number]) => {
      const i = Math.floor(l.s / track.spacing) % track.n;
      return (l.side === 'left' ? track.edgeL[i] : track.edgeR[i]) === 2;
    };
    const sb = sideBanners.find(onPit) ?? sideBanners[0];
    if (sb) {
      const sd = sb.side === 'left' ? -1 : 1;
      views.set('sideBanner', kartEye(sb.s - 22, sd * 2, 22, 1.5));
      const i = Math.floor(sb.s / track.spacing) % track.n;
      views.set('sideBannerOut', { pos: pose(sb.s - 14, sd * (track.hw[i]! + 16), -3), look: pose(sb.s, sd * (track.hw[i]! + 2), 0.5), fov: 60 });
    }
  }
  // aerial over the start area and over the whole track
  let cx = 0, cz = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < track.n; i++) { cx += track.px[i]!; cz += track.pz[i]!; minX = Math.min(minX, track.px[i]!); maxX = Math.max(maxX, track.px[i]!); minZ = Math.min(minZ, track.pz[i]!); maxZ = Math.max(maxZ, track.pz[i]!); }
  cx /= track.n; cz /= track.n;
  const ext = Math.max(maxX - minX, maxZ - minZ);
  views.set('aerial', { pos: new THREE.Vector3(cx + ext * 0.15, ext * 0.75, cz + ext * 0.72), look: new THREE.Vector3(cx, 0, cz), fov: 55 });
  const sI = Math.floor(track.startS / track.spacing);
  const [sfx, sfz] = fwd(sI);
  views.set('startAerial', {
    pos: new THREE.Vector3(track.px[sI]! - sfx * 45 + track.rx[sI]! * 30, track.py[sI]! + 26, track.pz[sI]! - sfz * 45 + track.rz[sI]! * 30),
    look: new THREE.Vector3(track.px[sI]!, track.py[sI]! + 2, track.pz[sI]!), fov: 55,
  });
  W.__views = [...views.keys()];

  const renderView = (name: string, time: number) => {
    const v = views.get(name) ?? views.get('start')!;
    camera.position.copy(v.pos);
    camera.fov = v.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(v.look);
    const sd = new THREE.Vector3(...env.sunDir).normalize();
    sun.position.copy(v.look).addScaledVector(sd, 250);
    sun.target.position.copy(v.look);
    sun.target.updateMatrixWorld();
    mesh.setStartLights(v.lights === undefined ? null : v.lights);
    mesh.update(1 / 60, time);
    renderer.info.reset();
    renderer.info.autoReset = false;
    if (quality.bloom) composer.render(); else renderer.render(scene, camera);
    const info = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    renderer.info.autoReset = true;
    const stats = {
      view: name, calls: info.calls, triangles: info.triangles,
      trackDrawCalls: mesh.stats.drawCalls, trackTriangles: mesh.stats.triangles, trackInstances: mesh.stats.instances,
      buildMs: Math.round(buildMs), theme, track: trackId,
      timings: JSON.stringify(mesh.stats.timings ?? {}),
    };
    W.__stats = stats;
    hud.textContent = Object.entries(stats).map(([k, val]) => `${k}: ${val}`).join('\n');
    return stats;
  };

  W.__disposeTest = () => {
    renderView('aerial', 1);
    const before = { ...renderer.info.memory, programs: renderer.info.programs?.length ?? 0 };
    mesh.dispose();
    renderView('aerial', 1);
    const after = { ...renderer.info.memory, programs: renderer.info.programs?.length ?? 0 };
    return { before, after, groupParent: mesh.group.parent ? 'attached' : 'detached' };
  };

  W.__show = async (name: string, time = 1.3) => {
    renderView(name, time);
    await new Promise(r => requestAnimationFrame(() => r(null)));
    return renderView(name, time);
  };

  const initial = qs.get('view') ?? 'start';
  renderView(initial, 1.3);
  console.log('[track-preview]', JSON.stringify(W.__stats));
  W.__ready = true;

  if (qs.get('animate') === '1') {
    const clock = new THREE.Timer();
    const loop = () => { clock.update(); renderView(initial, clock.getElapsed()); requestAnimationFrame(loop); };
    loop();
  }
}

main().catch(err => {
  console.error(err);
  W.__error = String(err && (err as Error).stack || err);
  W.__ready = true;
});
