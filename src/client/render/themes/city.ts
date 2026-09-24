/**
 * Neon City Nights scenery — a night city grid: lit-window towers and a skyline ring, neon signs
 * and billboards for ORIGINAL fictional brands, street lamps with halos and light pools on the
 * wet streets, blinking aviation lights, elevated overpasses with under-glow, a Ferris wheel,
 * sweeping searchlights and toy-like cars and buses.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { EnvironmentSettings, SceneryContext, SceneryHandle } from '../contracts.js';
import { THEME_PALETTES } from '../theme-palette.js';
import { buildTerrain, scatter } from '../terrain.js';
import {
  Bag, Batch, Glows, Materials, Reserve, Rng, addInstanced, blob, buildFarGround, canvasTex, clearOf, combine, frameAt,
  genericMoverGeo, gradientY, isTrackMeshKind, jitter, landmarkPlace, makeGenericRig, makeRig, noise2, normKind, part, pitRuns,
  pitStrip, qcount, radialTexture, recolorTerrain, runMinY, trackExtent, trs, updateGeneric, type MoverRig, type Xf, pitZone, reserveTrackFurniture, withCorridorGuard, activeCorridorGuard, xfMatrix,
} from './props-a.js';

const PAL = THEME_PALETTES.city;
const MOON: [number, number, number] = [-0.38, 0.62, -0.68];

export const CITY_ENV: EnvironmentSettings = {
  skyTop: '#07082a', skyHorizon: '#3b1f6e', skyBottom: '#120d24',
  fogColor: '#231946', fogNear: 110, fogFar: 880,
  sunColor: '#a9b8ff', sunIntensity: 0.9, sunDir: MOON,
  hemiSky: '#5b4bb8', hemiGround: '#1c1233', hemiIntensity: 0.7,
  exposure: 1.12, night: true, bloomStrength: 0.9,
};

const NEON = ['#ff2e88', '#2de2e6', '#f7f06d', '#9b5cff', '#ff8a3d', '#4dff9a'];
const BLOCK = 56;           // city block pitch (m)
const STREET = 12;          // street width (m)
const WIN_W = 4, WIN_H = 3.5, CELLS = 8;

// ───────────────────────────── Canvas textures ─────────────────────────────

function facadeTextures(seed: number, style: 0 | 1 | 2): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const rng = new Rng(seed);
  const S = 512, c = S / CELLS;
  const lit: Array<string | null> = [];
  for (let k = 0; k < CELLS * CELLS; k++) lit.push(rng.chance(style === 2 ? 0.42 : 0.32) ? rng.pick(['#ffd28a', '#ffc46b', '#bfe6ff', '#ffe9c4', '#ff9ad8', '#9fd8ff']) : null);
  const winRect = (i: number, j: number): [number, number, number, number] => {
    if (style === 0) return [i * c + c * 0.26, j * c + c * 0.3, c * 0.48, c * 0.44];
    if (style === 1) return [i * c + c * 0.04, j * c + c * 0.36, c * 0.92, c * 0.3];
    return [i * c + c * 0.16, j * c + c * 0.14, c * 0.68, c * 0.7];
  };
  const map = canvasTex(S, S, g => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
    for (let j = 0; j < CELLS; j++) for (let i = 0; i < CELLS; i++) {
      const [x, y, w, h] = winRect(i, j);
      g.fillStyle = '#1b2033'; g.fillRect(x - 2, y - 2, w + 4, h + 4);
      g.fillStyle = '#2a3150'; g.fillRect(x, y, w, h);
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x, y, w, 3);
    }
    if (style !== 2) for (let j = 0; j < CELLS; j++) { g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, j * c + c - 4, S, 4); }
  }, { repeat: true });
  const emissive = canvasTex(S, S, g => {
    g.fillStyle = '#000000'; g.fillRect(0, 0, S, S);
    for (let j = 0; j < CELLS; j++) for (let i = 0; i < CELLS; i++) {
      const col = lit[j * CELLS + i];
      if (!col) continue;
      const [x, y, w, h] = winRect(i, j);
      const grd = g.createLinearGradient(0, y, 0, y + h);
      grd.addColorStop(0, col); grd.addColorStop(1, 'rgba(40,30,20,1)');
      g.fillStyle = grd; g.fillRect(x, y, w, h);
      if (rng.chance(0.3)) { g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(x, y, w, h * rng.range(0.2, 0.6)); }
    }
  }, { repeat: true });
  return { map, emissive };
}

/** Street grid tile (one block pitch): asphalt streets with markings, kerbs, sidewalks, plaza paving. */
function blockTexture(): THREE.CanvasTexture {
  return canvasTex(1024, 1024, (g, S) => {
    const m = S / BLOCK;
    const st = STREET * m, sw = 3 * m;
    g.fillStyle = '#6b7090'; g.fillRect(0, 0, S, S);
    // plaza paving
    g.strokeStyle = 'rgba(20,20,40,0.35)'; g.lineWidth = 2;
    for (let p = st + sw; p < S; p += 2.5 * m) { g.beginPath(); g.moveTo(p, st + sw); g.lineTo(p, S); g.stroke(); g.beginPath(); g.moveTo(st + sw, p); g.lineTo(S, p); g.stroke(); }
    // sidewalks
    g.fillStyle = '#8a8fab';
    g.fillRect(st, st, S - st, sw); g.fillRect(st, st, sw, S - st);
    g.fillStyle = '#b9bdd4'; g.fillRect(st, st, S - st, 0.35 * m); g.fillRect(st, st, 0.35 * m, S - st);
    // streets
    g.fillStyle = '#2b2f40'; g.fillRect(0, 0, S, st); g.fillRect(0, 0, st, S);
    // asphalt/paving grain: a small deterministic noise tile overlaid as a pattern (no canvas readback)
    const tile = document.createElement('canvas');
    tile.width = tile.height = 128;
    const tg = tile.getContext('2d')!;
    const img = tg.createImageData(128, 128);
    const nr = new Rng(0x9a11);
    for (let i = 0; i < img.data.length; i += 4) { const v = 128 + (nr.next() - 0.5) * 30; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    tg.putImageData(img, 0, 0);
    g.save();
    g.globalCompositeOperation = 'overlay';
    g.globalAlpha = 0.55;
    g.fillStyle = g.createPattern(tile, 'repeat')!;
    g.fillRect(0, 0, S, S);
    g.restore();
    // lane dashes
    g.fillStyle = '#f7f06d';
    for (let p = st; p < S; p += 6 * m) { g.fillRect(p + m, st / 2 - 0.15 * m, 3 * m, 0.3 * m); g.fillRect(st / 2 - 0.15 * m, p + m, 0.3 * m, 3 * m); }
    // crosswalks at the intersection
    g.fillStyle = '#e8e8f0';
    for (let k = 0; k < 6; k++) {
      g.fillRect(st + 0.6 * m, 0.8 * m + k * 1.8 * m, 2.2 * m, 1.0 * m);
      g.fillRect(0.8 * m + k * 1.8 * m, st + 0.6 * m, 1.0 * m, 2.2 * m);
    }
  }, { repeat: true, anisotropy: 8 });
}

/** Roughness map with glossy puddles (G channel; low = shiny). */
function puddleTexture(seed: number): THREE.CanvasTexture {
  const rng = new Rng(seed);
  return canvasTex(512, 512, (g, S) => {
    g.fillStyle = 'rgb(200,200,200)'; g.fillRect(0, 0, S, S);
    // irregular puddles: clusters of soft overlapping blobs (no ring edges)
    for (let k = 0; k < 20; k++) {
      const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(16, 46);
      for (let j = 0; j < 5; j++) {
        const bx = x + rng.range(-1, 1) * r, by = y + rng.range(-0.6, 0.6) * r, br = r * rng.range(0.45, 0.9);
        const grd = g.createRadialGradient(bx, by, 0, bx, by, br);
        grd.addColorStop(0, 'rgba(30,30,30,0.95)'); grd.addColorStop(0.55, 'rgba(45,45,45,0.8)'); grd.addColorStop(1, 'rgba(45,45,45,0)');
        g.fillStyle = grd;
        g.fillRect(bx - br, by - br, br * 2, br * 2);
      }
    }
  }, { repeat: true, srgb: false });
}

/**
 * Tiny procedural night-city environment (sky gradient, a ring of HDR neon panels and warm window
 * bands) prefiltered with PMREM, so glossy puddles and glass pick up coloured reflections.
 */
function cityEnvironment(renderer: THREE.WebGLRenderer, seed: number): THREE.WebGLRenderTarget {
  const rng = new Rng(seed);
  const envScene = new THREE.Scene();
  const disposables: Array<{ dispose(): void }> = [];
  const skyGeo = new THREE.SphereGeometry(60, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uTop: { value: new THREE.Color(CITY_ENV.skyTop) }, uHor: { value: new THREE.Color(CITY_ENV.skyHorizon).multiplyScalar(1.3) }, uLow: { value: new THREE.Color('#1a1030') } },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uTop; uniform vec3 uHor; uniform vec3 uLow; varying vec3 vD; void main(){ float y = vD.y; vec3 c = y > 0.0 ? mix(uHor, uTop, pow(y, 0.45)) : mix(uHor, uLow, pow(-y, 0.4)); gl_FragColor = vec4(c, 1.0); }',
  });
  disposables.push(skyGeo, skyMat);
  envScene.add(new THREE.Mesh(skyGeo, skyMat));
  const panel = new THREE.PlaneGeometry(1, 1);
  disposables.push(panel);
  const addPanel = (a: number, y: number, w: number, h: number, color: THREE.Color, r = 40) => {
    const m = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    disposables.push(m);
    const mesh = new THREE.Mesh(panel, m);
    mesh.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    mesh.scale.set(w, h, 1);
    mesh.lookAt(0, y, 0);
    envScene.add(mesh);
  };
  for (let k = 0; k < 26; k++) addPanel((k / 26) * Math.PI * 2 + rng.range(-0.08, 0.08), rng.range(1.5, 9), rng.range(3, 7), rng.range(0.6, 2.2), new THREE.Color(rng.pick(NEON)).multiplyScalar(rng.range(2.2, 4)));
  for (let k = 0; k < 40; k++) addPanel(rng.range(0, Math.PI * 2), rng.range(3, 22), rng.range(1, 3), rng.range(0.4, 1), new THREE.Color(rng.pick(['#ffc46b', '#ffe9c4', '#9fd8ff'])).multiplyScalar(rng.range(0.8, 1.6)), 46);
  for (let k = 0; k < 8; k++) addPanel(rng.range(0, Math.PI * 2), 0.5, rng.range(8, 16), 0.5, new THREE.Color('#ffb870').multiplyScalar(2.5), 30);
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(envScene, 0.02, 0.1, 100, { size: 128 });
  pm.dispose();
  for (const d of disposables) d.dispose();
  return rt;
}

/**
 * The prefiltered environment depends only on (renderer, seed), and building it compiles PMREM's
 * shaders synchronously — the bulk of a neon-city scene build (perf lens: ~89 % of the constructor on
 * a cold start). It is therefore built once per renderer and seed and shared by later races (owned by
 * this cache: scenery must not dispose it). A lost GL context drops the cache (render targets lose
 * their contents), so the next race rebuilds it.
 */
const envCache = new WeakMap<THREE.WebGLRenderer, Map<number, THREE.WebGLRenderTarget>>();
function sharedCityEnvironment(renderer: THREE.WebGLRenderer, seed: number): THREE.WebGLRenderTarget {
  let bySeed = envCache.get(renderer);
  if (!bySeed) {
    const map = bySeed = new Map();
    envCache.set(renderer, map);
    renderer.domElement.addEventListener?.('webglcontextlost', () => {
      for (const rt of map.values()) rt.dispose();
      map.clear();
    });
  }
  let rt = bySeed.get(seed);
  if (!rt) { rt = cityEnvironment(renderer, seed); bySeed.set(seed, rt); }
  return rt;
}

interface Brand { name: string; sub?: string; a: string; b: string; icon?: 'bolt' | 'star' | 'bowl' | 'heart' | 'play' | 'cup' }
const BRANDS: Brand[] = [
  { name: 'ZAPPY COLA', sub: 'fizz your lap', a: '#ff2e88', b: '#ffffff', icon: 'bolt' },
  { name: 'MOCHI MART', sub: 'OPEN 24H', a: '#2de2e6', b: '#ff7eb6', icon: 'heart' },
  { name: '터보 라멘', sub: 'TURBO RAMEN', a: '#ff8a3d', b: '#fff2a8', icon: 'bowl' },
  { name: 'PIXEL ARCADE', sub: 'insert coin', a: '#9b5cff', b: '#4dff9a', icon: 'play' },
  { name: 'STARLITE', sub: 'HOTEL · SKY BAR', a: '#5fa8ff', b: '#f7f06d', icon: 'star' },
  { name: '별빛 분식', sub: 'STARLIGHT SNACKS', a: '#2de2e6', b: '#ff2e88', icon: 'cup' },
  { name: 'NOVA BURGER', sub: 'double boost', a: '#f7f06d', b: '#ff4d4d', icon: 'star' },
  { name: 'ORBIT CINEMA', sub: 'now showing', a: '#ff4fd8', b: '#5ce1ff', icon: 'play' },
];

function signAtlas(): THREE.CanvasTexture {
  return canvasTex(1024, 1024, (g, S) => {
    g.fillStyle = '#000000'; g.fillRect(0, 0, S, S);
    const cw = S / 2, ch = S / 4;
    BRANDS.forEach((br, k) => {
      const x0 = (k % 2) * cw, y0 = Math.floor(k / 2) * ch;
      g.save();
      g.translate(x0, y0);
      const pad = 14;
      g.fillStyle = '#0d0b1e';
      roundRect(g, pad, pad, cw - pad * 2, ch - pad * 2, 26); g.fill();
      g.lineWidth = 7; g.strokeStyle = br.a; g.shadowColor = br.a; g.shadowBlur = 22;
      roundRect(g, pad + 8, pad + 8, cw - pad * 2 - 16, ch - pad * 2 - 16, 20); g.stroke();
      const hasIcon = !!br.icon;
      const tx = hasIcon ? cw * 0.58 : cw / 2;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `900 ${br.name.length > 9 ? 58 : 70}px 'Black Han Sans', 'Jua', 'Noto Sans KR', 'Arial Black', Impact, sans-serif`;
      g.fillStyle = '#ffffff'; g.shadowColor = br.a; g.shadowBlur = 28;
      g.fillText(br.name, tx, ch * 0.44, cw * (hasIcon ? 0.66 : 0.84));
      g.shadowBlur = 16;
      g.fillStyle = br.b; g.shadowColor = br.b;
      g.font = `700 30px 'Jua', 'Noto Sans KR', Arial, sans-serif`;
      if (br.sub) g.fillText(br.sub, tx, ch * 0.73, cw * 0.62);
      if (hasIcon) drawIcon(g, br.icon!, cw * 0.17, ch * 0.5, 62, br.b, br.a);
      g.restore();
    });
  }, { anisotropy: 8 });
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}

function drawIcon(g: CanvasRenderingContext2D, icon: NonNullable<Brand['icon']>, x: number, y: number, s: number, fill: string, glow: string): void {
  g.save();
  g.translate(x, y);
  g.fillStyle = fill; g.strokeStyle = fill; g.shadowColor = glow; g.shadowBlur = 24; g.lineWidth = 8; g.lineJoin = 'round';
  g.beginPath();
  if (icon === 'bolt') { g.moveTo(0.1 * s, -0.7 * s); g.lineTo(-0.4 * s, 0.1 * s); g.lineTo(0, 0.1 * s); g.lineTo(-0.15 * s, 0.7 * s); g.lineTo(0.45 * s, -0.15 * s); g.lineTo(0.05 * s, -0.15 * s); g.closePath(); g.fill(); }
  else if (icon === 'star') { for (let k = 0; k < 10; k++) { const r = k % 2 ? 0.3 * s : 0.7 * s, a = -Math.PI / 2 + (k / 10) * Math.PI * 2; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); g.fill(); }
  else if (icon === 'heart') { g.moveTo(0, 0.55 * s); g.bezierCurveTo(-0.9 * s, -0.1 * s, -0.4 * s, -0.8 * s, 0, -0.3 * s); g.bezierCurveTo(0.4 * s, -0.8 * s, 0.9 * s, -0.1 * s, 0, 0.55 * s); g.fill(); }
  else if (icon === 'bowl') { g.arc(0, 0, 0.6 * s, 0, Math.PI); g.closePath(); g.fill(); g.beginPath(); for (let k = -1; k <= 1; k++) { g.moveTo(k * 0.25 * s, -0.15 * s); g.quadraticCurveTo(k * 0.25 * s + 0.15 * s, -0.45 * s, k * 0.25 * s, -0.7 * s); } g.stroke(); }
  else if (icon === 'play') { g.moveTo(-0.35 * s, -0.55 * s); g.lineTo(0.55 * s, 0); g.lineTo(-0.35 * s, 0.55 * s); g.closePath(); g.fill(); }
  else { g.moveTo(-0.4 * s, -0.5 * s); g.lineTo(0.4 * s, -0.5 * s); g.lineTo(0.28 * s, 0.6 * s); g.lineTo(-0.28 * s, 0.6 * s); g.closePath(); g.fill(); g.fillRect(-0.05 * s, -0.8 * s, 0.1 * s, 0.35 * s); }
  g.restore();
}

// ───────────────────────────── Geometry templates ─────────────────────────────

/** Box building with world-scaled window UVs (roof/floor faces map to a wall texel). */
function buildingBox(w: number, h: number, d: number, rng: Rng): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const ou = Math.floor(rng.range(0, CELLS)) / CELLS, ov = Math.floor(rng.range(0, CELLS)) / CELLS;
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      if (f === 2 || f === 3) { uv.setXY(i, 0.003, 0.003); continue; }
      const span = f < 2 ? d : w;
      uv.setXY(i, ou + uv.getX(i) * span / (WIN_W * CELLS), ov + uv.getY(i) * h / (WIN_H * CELLS));
    }
  }
  g.translate(0, h / 2, 0);
  return g;
}

export function carGeo(body: string): { body: THREE.BufferGeometry; lights: THREE.BufferGeometry } {
  const p: THREE.BufferGeometry[] = [];
  const shell = new RoundedBoxGeometry(2.1, 0.9, 4.2, 3, 0.32);
  p.push(part(shell, body, 0, 0.85, 0));
  const cab = new RoundedBoxGeometry(1.8, 0.8, 2.2, 3, 0.3);
  p.push(part(cab, body, 0, 1.55, -0.25));
  const glass = new RoundedBoxGeometry(1.84, 0.56, 2.0, 2, 0.22);
  p.push(part(glass, '#1d2a4a', 0, 1.6, -0.25));
  p.push(part(new THREE.BoxGeometry(2.14, 0.12, 4.0), '#e8e8f0', 0, 0.62, 0));
  for (const [x, z] of [[1, 1.35], [-1, 1.35], [1, -1.35], [-1, -1.35]]) {
    p.push(part(new THREE.CylinderGeometry(0.42, 0.42, 0.32, 12), '#1a1a22', x! * 0.98, 0.42, z!, 0, 0, Math.PI / 2));
    p.push(part(new THREE.CylinderGeometry(0.2, 0.2, 0.34, 8), '#c9ccd8', x! * 0.99, 0.42, z!, 0, 0, Math.PI / 2));
  }
  const l: THREE.BufferGeometry[] = [];
  for (const x of [-0.65, 0.65]) {
    l.push(part(new THREE.SphereGeometry(0.2, 8, 6), '#fff6d8', x, 0.95, 2.08, 0, 0, 0, 1, 0.8, 0.4));
    l.push(part(new THREE.BoxGeometry(0.5, 0.18, 0.08), '#ff3355', x, 1.0, -2.1));
  }
  return { body: combine(p), lights: combine(l) };
}

export function busGeo(body: string): { body: THREE.BufferGeometry; lights: THREE.BufferGeometry } {
  const p: THREE.BufferGeometry[] = [];
  const dark = '#1b1d29';
  p.push(part(new RoundedBoxGeometry(2.6, 2.7, 8.6, 3, 0.45), body, 0, 1.8, 0));
  p.push(part(new THREE.BoxGeometry(2.64, 0.32, 8.3), '#ffffff', 0, 1.12, 0));
  p.push(part(new RoundedBoxGeometry(2.25, 0.32, 6.8, 2, 0.12), '#f4f4f4', 0, 3.2, -0.3));
  p.push(part(new RoundedBoxGeometry(1.4, 0.45, 1.6, 2, 0.15), '#d9dce6', 0, 3.5, -1.8));
  // front: dark windscreen frame, grille, bumper, mirrors; rear bumper
  p.push(part(new THREE.BoxGeometry(2.36, 1.32, 0.12), dark, 0, 2.3, 4.29));
  p.push(part(new THREE.BoxGeometry(1.5, 0.34, 0.08), '#3a3f55', 0, 1.02, 4.31));
  p.push(part(new RoundedBoxGeometry(2.72, 0.42, 0.36, 2, 0.12), '#2a2d3a', 0, 0.62, 4.3));
  p.push(part(new RoundedBoxGeometry(2.72, 0.42, 0.36, 2, 0.12), '#2a2d3a', 0, 0.62, -4.3));
  for (const sx of [-1, 1]) p.push(part(new THREE.BoxGeometry(0.12, 0.42, 0.2), dark, sx * 1.42, 2.55, 4.05));
  for (const [x, z] of [[1, 2.9], [-1, 2.9], [1, -2.9], [-1, -2.9]]) {
    p.push(part(new THREE.CylinderGeometry(0.55, 0.55, 0.4, 14), '#1a1a22', x! * 1.2, 0.55, z!, 0, 0, Math.PI / 2));
    p.push(part(new THREE.CylinderGeometry(0.26, 0.26, 0.42, 8), '#c9ccd8', x! * 1.21, 0.55, z!, 0, 0, Math.PI / 2));
  }
  const l: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) for (let k = 0; k < 5; k++) l.push(part(new THREE.BoxGeometry(0.06, 0.85, 1.12), k % 2 ? '#a08a64' : '#b59a6a', sx * 1.31, 2.3, -3.2 + k * 1.3));
  l.push(part(new THREE.BoxGeometry(2.12, 1.08, 0.06), '#33506e', 0, 2.3, 4.36));
  l.push(part(new THREE.BoxGeometry(1.5, 0.28, 0.08), '#d8c050', 0, 3.2, 4.33));
  for (const x of [-0.95, 0.95]) { l.push(part(new THREE.SphereGeometry(0.2, 8, 6), '#fff6d8', x, 1.05, 4.36, 0, 0, 0, 1, 0.8, 0.4)); l.push(part(new THREE.BoxGeometry(0.4, 0.3, 0.08), '#ff3355', x, 1.15, -4.32)); }
  return { body: combine(p), lights: combine(l) };
}

function lampGeo(): THREE.BufferGeometry {
  return combine([
    part(new THREE.CylinderGeometry(0.28, 0.34, 0.5, 8), '#2a2d3a', 0, 0.25, 0),
    part(new THREE.CylinderGeometry(0.1, 0.13, 7, 8), '#3a3f55', 0, 3.5, 0),
    part(new THREE.BoxGeometry(0.14, 0.14, 2.3), '#3a3f55', 0, 7.0, 1.05),
    part(new THREE.BoxGeometry(0.55, 0.22, 0.9), '#2a2d3a', 0, 6.95, 2.2),
    part(new THREE.BoxGeometry(0.45, 0.06, 0.75), '#fff0cf', 0, 6.82, 2.2),
  ]);
}

function cityTreeGeo(): THREE.BufferGeometry {
  const planter = part(new THREE.CylinderGeometry(0.9, 0.8, 0.6, 10), '#4a4f66', 0, 0.3, 0);
  const trunk = part(new THREE.CylinderGeometry(0.14, 0.2, 2.2, 6), '#5a3d2b', 0, 1.6, 0);
  const b = [[1.5, 0, 3.4, 0], [1.1, 0.8, 3.9, 0.3], [1.0, -0.7, 3.8, -0.3]].map(([r, x, y, z]) => { const g = jitter(blob(r!, 9, 6, 0.5), 0.08, 3); g.translate(x!, y!, z!); return g; });
  const fol = gradientY(combine(b), '#1d5a3a', '#3f9a5a');
  return combine([planter, trunk, fol]);
}

const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const TOY = ['#ff4d6d', '#ffd23f', '#2de2e6', '#9b5cff', '#ff8a3d', '#4dff9a', '#f4f4f8', '#5fa8ff'];
const WALLS = ['#3a3f5c', '#4b3f6b', '#2f4a66', '#5a4a7a', '#39506b', '#6b4a6b', '#2b2f45', '#44506e'];

// ───────────────────────────── Builder ─────────────────────────────

/** Scenery build runs with the drivable-corridor guard active (no static prop stands where karts drive). */
export function buildScenery(ctx: SceneryContext): SceneryHandle {
  return withCorridorGuard(ctx, () => buildCityScenery(ctx));
}

function buildCityScenery(ctx: SceneryContext): SceneryHandle {
  const { scene, track, quality } = ctx;
  const q = quality.scenery;
  const bag = new Bag();
  const mats = new Materials(bag);
  const root = bag.add(scene, new THREE.Group());
  root.name = 'scenery-city';
  const seed = track.def.scenerySeed + 404;
  const rng = new Rng(seed);
  const ext = trackExtent(track);
  // a deeper drop than the default 30 m so the glowing void grid (top − 36) lies above the pit floor
  const terrain = buildTerrain(track, { ground: PAL.ground, groundAlt: PAL.groundAlt, pitColor: PAL.pitColor, hills: 1.5, seed, pitDepth: 48 });
  terrain.mesh.receiveShadow = true;
  bag.add(root, terrain.mesh);
  bag.track(terrain);
  const H = (x: number, z: number) => terrain.heightAt(x, z);
  const m4 = new THREE.Matrix4();
  const reserve = new Reserve();
  const inPit = pitZone(track);
  reserve.block(inPit);
  reserveTrackFurniture(track, reserve);
  const faceTrack = (x: number, z: number) => { const n = terrain.nearestTrack(x, z); return Math.atan2(track.px[n.i]! - x, track.pz[n.i]! - z); };
  const glowTex = bag.track(radialTexture(128, 0.12));
  const glows = bag.track(new Glows(1600, glowTex));
  bag.add(root, glows.mesh);

  // ── neon reflections for wet streets and glass ──
  const envRT = sharedCityEnvironment(ctx.renderer, seed + 99); // cached across races: not bag-tracked

  // ── wet street-grid ground ──
  {
    const g = terrain.mesh.geometry;
    const p = g.attributes.position as THREE.BufferAttribute;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / BLOCK; uv[i * 2 + 1] = p.getZ(i) / BLOCK; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const ref = new THREE.Color(PAL.ground);
    const lum0 = ref.r + ref.g + ref.b;
    recolorTerrain(terrain.mesh, (_x, _y, _z, c) => { const k = Math.min(1.05, (c.r + c.g + c.b) / lum0); c.setRGB(0.5 * k, 0.5 * k, 0.56 * k); });
    const mat = terrain.mesh.material as THREE.MeshStandardMaterial;
    mat.map = bag.track(blockTexture());
    mat.roughnessMap = bag.track(puddleTexture(seed));
    mat.roughness = 0.85;
    mat.metalness = 0.18;
    mat.envMap = envRT.texture;
    mat.envMapIntensity = 1.35;
    mat.needsUpdate = true;
  }

  // ── building materials ──
  const facade = ([0, 1, 2] as const).map(st => facadeTextures(seed + st * 17, st));
  facade.forEach(f => { bag.track(f.map); bag.track(f.emissive); });
  const bMat = facade.map(f => bag.track(new THREE.MeshStandardMaterial({ vertexColors: true, map: f.map, emissiveMap: f.emissive, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.95, roughness: 0.42, metalness: 0.2, envMap: envRT.texture, envMapIntensity: 0.45 })));
  const ringMat = facade.map(f => bag.track(new THREE.MeshStandardMaterial({ vertexColors: true, map: f.map, emissiveMap: f.emissive, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.7, roughness: 0.7, fog: false })));
  // merge chunk size: at low / medium the draw-call budget is tighter than the triangle budget, so the
  // (cheap, boxy) city blocks are merged in coarser chunks — same geometry, fewer draws
  const cityChunk = quality.level === 'high' ? 300 : 600;
  const bBatch = bMat.map(m => new Batch(m, { chunk: cityChunk, castShadow: true, receiveShadow: true, uv: true, name: 'city-buildings' }));
  const ringBatch = ringMat.map(m => new Batch(m, { uv: true, name: 'city-skyline' }));
  const stat = new Batch(mats.vc(0.6, { metalness: 0.2 }), { chunk: cityChunk, castShadow: true, receiveShadow: true, name: 'city-static' });
  /**
   * Glossy toy-car paint: neon reflections from the PMREM environment plus a faint self-lit glow in the
   * car's OWN colour (emissive × vertex/instance colour), so bodies stay saturated under the purple night.
   */
  const paintMat = bag.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.1, envMap: envRT.texture, envMapIntensity: 0.9, emissive: new THREE.Color().setScalar(0.2) }));
  paintMat.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= diffuseColor.rgb;');
  };
  paintMat.customProgramCacheKey = () => 'city-toy-paint';
  const neonBatch = new Batch(mats.glow(), { chunk: cityChunk, name: 'city-neon' });
  const atlas = bag.track(signAtlas());
  const signMat = bag.track(new THREE.MeshBasicMaterial({ map: atlas, color: new THREE.Color(1.45, 1.45, 1.45), fog: true }));
  const flickerMat = bag.track(new THREE.MeshBasicMaterial({ map: atlas, color: new THREE.Color(1.45, 1.45, 1.45), fog: true }));
  const signs = new Batch(signMat, { uv: true, name: 'city-signs' });
  const flickerSigns = new Batch(flickerMat, { uv: true, name: 'city-signs-flicker' });
  const aviation: number[] = [];

  const addSign = (x: number, y: number, z: number, yaw: number, w: number, brand: number, flicker = false) => {
    const g = new THREE.PlaneGeometry(w, w / 2);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const cu = (brand % 2) / 2, cv = 1 - (Math.floor(brand / 2) + 1) / 4;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, cu + uv.getX(i) * 0.5, cv + uv.getY(i) * 0.25);
    g.applyMatrix4(trs(x, y, z, 0, yaw, 0, 1, 1, 1, m4));
    (flicker ? flickerSigns : signs).addRaw(g);
  };
  const acUnit = bag.track(combine([part(new THREE.BoxGeometry(2.2, 1.2, 1.6), '#6b7090', 0, 0.6, 0), part(new THREE.CylinderGeometry(0.5, 0.5, 0.15, 10), '#2a2d3a', 0, 1.25, 0)]));
  const tank = bag.track(combine([
    part(new THREE.CylinderGeometry(1.4, 1.4, 2.6, 12), '#6b5a4a', 0, 3.1, 0), part(new THREE.ConeGeometry(1.55, 0.9, 12), '#4a3f35', 0, 4.85, 0),
    ...[[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([a, b]) => part(new THREE.BoxGeometry(0.14, 1.8, 0.14), '#3a3f55', a! * 0.9, 0.9, b! * 0.9)),
  ]));
  const antenna = bag.track(combine([part(new THREE.CylinderGeometry(0.08, 0.16, 9, 6), '#8a8fab', 0, 4.5, 0), part(new THREE.CylinderGeometry(0.5, 0.5, 0.2, 8), '#8a8fab', 0, 3, 0)]));
  const strip = bag.track(part(new THREE.BoxGeometry(1, 0.28, 0.18), '#ffffff'));
  const spire = bag.track(combine([part(new THREE.ConeGeometry(0.72, 1, 4), '#8a8fab', 0, 0.5, 0), part(new THREE.CylinderGeometry(0.03, 0.05, 0.25, 4), '#c9ccd8', 0, 1.1, 0)]));
  const bbPole = bag.track(part(new THREE.CylinderGeometry(0.22, 0.26, 1, 8), '#3a3f55', 0, 0.5, 0));

  const addBuilding = (cx: number, cz: number, w: number, d: number, h: number, nearTrack: boolean) => {
    const style = rng.int(0, 3);
    const y = Math.min(H(cx - w / 2, cz - d / 2), H(cx + w / 2, cz + d / 2), H(cx, cz)) - 0.4;
    const g = buildingBox(w, h + 0.4, d, rng);
    g.translate(cx, y, cz);
    const tint = new THREE.Color(rng.pick(WALLS));
    const col = new Float32Array(g.attributes.position!.count * 3);
    for (let i = 0; i < col.length; i += 3) { col[i] = tint.r; col[i + 1] = tint.g; col[i + 2] = tint.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    bBatch[style]!.addRaw(g);
    const top = y + h + 0.4;
    // shop-front glow strips + roof trim
    const neon = rng.pick(NEON);
    const trim = (tw: number, td: number, ty: number, sh: number, col: THREE.ColorRepresentation, p = 1) => {
      for (const [ox, oz, ry, span] of [[0, td / 2 + 0.1, 0, tw], [0, -td / 2 - 0.1, 0, tw], [tw / 2 + 0.1, 0, Math.PI / 2, td], [-tw / 2 - 0.1, 0, Math.PI / 2, td]] as const) {
        if (rng.chance(p)) neonBatch.add(strip, trs(cx + ox, ty, cz + oz, 0, ry, 0, span, sh, 1, m4), col);
      }
    };
    trim(w * 0.92, d, y + 3.6, 1, neon, 0.7);
    if (h > 20 && rng.chance(0.5)) trim(w, d, top - 0.3, 0.8, rng.pick(NEON), 0.8);
    // stepped crown on towers (setback tier + optional spire), silhouette variety for the skyline
    let roof = top, rw = w, rd = d;
    if (h > 32 && rng.chance(0.6)) {
      rw = w * rng.range(0.55, 0.75); rd = d * rng.range(0.55, 0.75);
      const h2 = Math.max(6, h * rng.range(0.16, 0.32));
      const g2 = buildingBox(rw, h2, rd, rng);
      g2.translate(cx, top, cz);
      const c2 = new Float32Array(g2.attributes.position!.count * 3);
      for (let i = 0; i < c2.length; i += 3) { c2[i] = tint.r; c2[i + 1] = tint.g; c2[i + 2] = tint.b; }
      g2.setAttribute('color', new THREE.BufferAttribute(c2, 3));
      bBatch[style]!.addRaw(g2);
      roof = top + h2;
      trim(rw, rd, roof - 0.3, 0.9, rng.pick(NEON), 0.9);
      if (h > 58 && rng.chance(0.55)) {
        const sh = rng.range(10, 20);
        stat.add(spire, trs(cx, roof, cz, 0, Math.PI / 4, 0, rw * 0.36, sh, rd * 0.36, m4));
        aviation.push(glows.push(cx, roof + sh + 0.6, cz, 3.0, '#ff2a3a', 1.6));
        roof = -Infinity; // spire replaces the antenna
      }
    } else {
      // roof clutter
      const n = rng.int(0, 3);
      for (let k = 0; k < n; k++) stat.add(acUnit, trs(cx + rng.range(-w / 3, w / 3), top, cz + rng.range(-d / 3, d / 3), 0, rng.range(0, 3), 0, 1, 1, 1, m4));
      if (h < 40 && rng.chance(0.25)) stat.add(tank, trs(cx + rng.range(-w / 4, w / 4), top, cz + rng.range(-d / 4, d / 4), 0, 0, 0, 1, 1, 1, m4));
    }
    if (h > 55 && roof > -Infinity) {
      stat.add(antenna, trs(cx, roof, cz, 0, 0, 0, 1, 1, 1, m4));
      aviation.push(glows.push(cx, roof + 9.2, cz, 3.2, '#ff2a3a', 1.6));
      if (rng.chance(0.5)) for (const [sx, sz] of [[1, 1], [-1, -1]]) aviation.push(glows.push(cx + sx! * rw / 2, roof + 0.4, cz + sz! * rd / 2, 2.0, '#ff2a3a', 1.2));
    }
    // rooftop sign on low blocks next to the circuit
    if (nearTrack && h < 30 && rng.chance(0.3)) {
      const yaw = faceTrack(cx, cz);
      const sw = Math.min(Math.min(w, d) * 0.85, 12);
      const sy = top + sw / 4 + 1.4;
      for (const sx of [-1, 1]) stat.add(bbPole, trs(cx + Math.cos(yaw) * sx * sw * 0.3, top, cz - Math.sin(yaw) * sx * sw * 0.3, 0, 0, 0, 0.8, 1.6, 0.8, m4));
      addSign(cx, sy, cz, yaw, sw, rng.int(0, BRANDS.length), rng.chance(0.2));
    }
    // a sign on the face looking at the track
    if (nearTrack && rng.chance(0.55)) {
      const yaw = faceTrack(cx, cz);
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const faceIsX = Math.abs(fx) > Math.abs(fz);
      const span = faceIsX ? d : w;
      const sw = Math.min(span * 0.8, 13);
      const sy = Math.min(y + 6 + sw / 4 + rng.range(0, Math.max(0, h - sw)), top - sw / 4 - 1);
      if (sy > y + 4) {
        const ox = faceIsX ? Math.sign(fx) * (w / 2 + 0.25) : 0, oz = faceIsX ? 0 : Math.sign(fz) * (d / 2 + 0.25);
        const fyaw = faceIsX ? (fx > 0 ? Math.PI / 2 : -Math.PI / 2) : (fz > 0 ? 0 : Math.PI);
        addSign(cx + ox, sy, cz + oz, fyaw, sw, rng.int(0, BRANDS.length), rng.chance(0.25));
      }
    }
  };

  // ── city blocks ──
  const tb = terrain.bounds;
  const tcx = (tb.minX + tb.maxX) / 2, tcz = (tb.minZ + tb.maxZ) / 2;
  const half = Math.min(tb.maxX - tb.minX, tb.maxZ - tb.minZ) / 2;
  const lots: Array<{ x: number; z: number; w: number; d: number; dist: number }> = [];
  const inner = STREET + 3.5;
  for (let bx = Math.floor(tb.minX / BLOCK); bx < Math.ceil(tb.maxX / BLOCK); bx++) {
    for (let bz = Math.floor(tb.minZ / BLOCK); bz < Math.ceil(tb.maxZ / BLOCK); bz++) {
      const x0 = bx * BLOCK + inner, z0 = bz * BLOCK + inner, x1 = (bx + 1) * BLOCK - 1, z1 = (bz + 1) * BLOCK - 1;
      if (x0 < tb.minX + 10 || x1 > tb.maxX - 10 || z0 < tb.minZ + 10 || z1 > tb.maxZ - 10) continue;
      const sub = rng.chance(0.35) ? 1 : 2;
      const lw = (x1 - x0) / sub, ld = (z1 - z0) / sub;
      for (let i = 0; i < sub; i++) for (let j = 0; j < sub; j++) {
        const cx = x0 + lw * (i + 0.5), cz = z0 + ld * (j + 0.5);
        const r = Math.hypot(lw, ld) / 2;
        if (inPit(cx, cz)) continue;
        if (!clearOf(terrain, cx, cz, r, 3)) {
          // try a smaller footprint in the lot centre
          if (!clearOf(terrain, cx, cz, r * 0.5, 3)) continue;
          lots.push({ x: cx, z: cz, w: lw * 0.45, d: ld * 0.45, dist: terrain.nearestTrack(cx, cz).dist });
          continue;
        }
        lots.push({ x: cx, z: cz, w: lw - rng.range(1.5, 4), d: ld - rng.range(1.5, 4), dist: terrain.nearestTrack(cx, cz).dist });
      }
    }
  }
  const keep = Math.max(0.35, q);
  for (const L of lots) {
    if (L.dist > 70 && rng.next() > keep) continue;
    const far = smooth(40, 260, L.dist);
    const h = rng.range(9, 26) + far * rng.range(10, 90) + (rng.chance(0.08) ? 50 : 0);
    addBuilding(L.x, L.z, Math.max(5, L.w), Math.max(5, L.d), h, L.dist < 95);
    reserve.add(L.x, L.z, Math.hypot(L.w, L.d) / 2);
  }

  // ── skyline ring (fog-free silhouettes with lit windows) ──
  for (let row = 0; row < 3; row++) {
    const R = half + 40 + row * 110;
    const count = qcount(90 + row * 30, Math.max(0.5, q));
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + rng.range(-0.01, 0.01);
      const r = R + rng.range(-20, 20);
      const w = rng.range(14, 30), d = rng.range(14, 30), h = rng.range(40, 120) + row * 45 + (rng.chance(0.1) ? 90 : 0);
      const x = tcx + Math.cos(a) * r, z = tcz + Math.sin(a) * r;
      const g = buildingBox(w, h, d, rng);
      g.rotateY(-a);
      g.translate(x, ext.minY - 4, z);
      const tint = new THREE.Color(rng.pick(WALLS)).multiplyScalar(0.55 - row * 0.1);
      const col = new Float32Array(g.attributes.position!.count * 3);
      for (let i = 0; i < col.length; i += 3) { col[i] = tint.r; col[i + 1] = tint.g; col[i + 2] = tint.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      ringBatch[rng.int(0, 3)]!.addRaw(g);
      if (h > 110) aviation.push(glows.push(x, ext.minY - 4 + h + 1.5, z, 7, '#ff2a3a', 1.4));
    }
  }

  // ── street lamps along the race road (halo + light pool on the wet ground) ──
  const lampXf: Xf[] = [], poolXf: Xf[] = [];
  const lampTemplate = lampGeo();
  const lampGuard = activeCorridorGuard();
  const addLamp = (x: number, z: number, yaw: number, color: string, yBase?: number) => {
    const y = yBase ?? H(x, z);
    const xf: Xf = { x, y: y - 0.1, z, ry: yaw };
    // checked here (not only in addInstanced) so a rejected lamp takes its bulb glow and light pool with it
    if (lampGuard && lampGuard.intrudes(lampTemplate, xfMatrix(xf, new THREE.Matrix4()))) return;
    lampXf.push(xf);
    const hx = x + Math.sin(yaw) * 2.2, hz = z + Math.cos(yaw) * 2.2;
    // hot bulb; with bloom the post pass supplies the halo, without it a faint wide sprite hangs just
    // below the lamp head (never a bright disc sliced by the head)
    glows.push(hx, y + 6.5, hz, quality.bloom ? 0.55 : 0.7, color, quality.bloom ? 1.6 : 1.25);
    if (!quality.bloom) glows.push(hx, y + 6.1, hz, 2.2, color, 0.16);
    poolXf.push({ x: hx, y: y + 0.07, z: hz, s: 7.5 });
  };
  for (const side of [-1, 1]) {
    for (let s0 = side > 0 ? 0 : 13; s0 < track.length; s0 += 26) {
      const f = frameAt(track, s0);
      if ((side < 0 ? track.edgeL[f.i] : track.edgeR[f.i]) === 2) continue;
      const wall = side < 0 ? track.wallL[f.i]! : track.wallR[f.i]!;
      let d = side * (wall + 1.8);
      let x = f.x + f.rx * d, z = f.z + f.rz * d;
      // the arm reaches 2.6 m back over the barrier at 6.4 m above the post foot: where the ground drops away (an
      // embankment / viaduct edge) the post stands on the verge top instead, or its head would hang at kart height
      const ye = track.py[f.i]! + track.ry[f.i]! * side * track.hw[f.i]!;
      let yBase: number | undefined;
      if (H(x, z) < ye - 1.2) {
        d = side * (wall + 1.2);
        x = f.x + f.rx * d; z = f.z + f.rz * d;
        yBase = ye - 0.38;
      }
      if (terrain.inCorridor(x, z, 0.6) || !reserve.ok(x, z, 0.5)) continue;
      addLamp(x, z, Math.atan2(-f.rx * side, -f.rz * side), side > 0 ? '#ffc070' : '#ffd9a8', yBase);
    }
  }
  // corner lamps at street intersections
  for (let bx = Math.floor(tb.minX / BLOCK); bx < Math.ceil(tb.maxX / BLOCK); bx++) {
    for (let bz = Math.floor(tb.minZ / BLOCK); bz < Math.ceil(tb.maxZ / BLOCK); bz++) {
      if (rng.next() > 0.55 * Math.max(0.5, q)) continue;
      const x = bx * BLOCK + STREET + 1, z = bz * BLOCK + STREET + 1;
      if (x < tb.minX + 20 || x > tb.maxX - 20 || z < tb.minZ + 20 || z > tb.maxZ - 20) continue;
      if (terrain.inCorridor(x, z, 2) || !reserve.ok(x, z, 0.3)) continue;
      addLamp(x, z, -Math.PI * 0.75, '#ffc070');
    }
  }

  // ── overpasses crossing the race road ──
  const deckMat = mats.vc(0.7, { metalness: 0.1 });
  const overpasses: number[] = [];
  const addOverpass = (s: number) => {
    const f = frameAt(track, s);
    const wall = Math.max(track.wallL[f.i]!, track.wallR[f.i]!);
    // extend each way until another corridor (or 80 m)
    const reach = (side: number) => { let a = wall + 3; while (a < wall + 80) { const x = f.x + f.rx * side * (a + 6), z = f.z + f.rz * side * (a + 6); if (terrain.inCorridor(x, z, 2)) break; a += 4; } return a; };
    const rA = reach(-1), rB = reach(1);
    if (rA < wall + 12 || rB < wall + 12) return false;
    const deckY = f.y + 9.8;
    const len = rA + rB, mid = (rB - rA) / 2;
    const cx = f.x + f.rx * mid, cz = f.z + f.rz * mid;
    const yaw = Math.atan2(f.rx, f.rz);
    const deck = combine([
      part(new THREE.BoxGeometry(13, 1.3, len), '#4a4f66', 0, 0, 0),
      part(new THREE.BoxGeometry(0.5, 1.1, len), '#8a8fab', 6.3, 1.1, 0), part(new THREE.BoxGeometry(0.5, 1.1, len), '#8a8fab', -6.3, 1.1, 0),
      part(new THREE.BoxGeometry(12, 0.05, len), '#2b2f40', 0, 0.68, 0),
    ]);
    deck.applyMatrix4(trs(cx, deckY, cz, 0, yaw, 0, 1, 1, 1, m4));
    stat.addRaw(deck);
    for (const sx of [-1, 1]) {
      neonBatch.add(strip, trs(cx + Math.cos(yaw) * sx * 6.6, deckY - 0.55, cz - Math.sin(yaw) * sx * 6.6, 0, yaw + Math.PI / 2, 0, len, 1.2, 1.4, m4), sx > 0 ? '#ff2e88' : '#2de2e6');
      neonBatch.add(strip, trs(cx + Math.cos(yaw) * sx * 6.6, deckY + 1.75, cz - Math.sin(yaw) * sx * 6.6, 0, yaw + Math.PI / 2, 0, len, 0.6, 1, m4), '#f7f06d');
    }
    // under-deck lighting over the race road: rows of warm fixtures, a soft halo under each and light pools on the
    // asphalt (at night the underpass otherwise reads as a flat black slab across the screen)
    const fx = Math.sin(f.yaw), fz = Math.cos(f.yaw);
    for (let a = -wall - 1; a <= wall + 1.01; a += 4.2) {
      for (const zz of [-4.1, 0, 4.1]) {
        const lx = f.x + f.rx * a + fx * zz, lz = f.z + f.rz * a + fz * zz;
        neonBatch.add(strip, trs(lx, deckY - 0.66, lz, 0, f.yaw, 0, 1.3, 0.35, 5, m4), '#ffe6bf');
        // with bloom a small hot sprite; without it the sprite is sliced by the deck into a beige half-disc, so the
        // emissive fixture and its light pool carry the look alone
        if (quality.bloom) glows.push(lx, deckY - 0.95, lz, 1.1, '#ffd9a8', 0.55);
        if (zz === 0 && Math.abs(a) < wall - 1) poolXf.push({ x: lx, y: f.y + 0.07, z: lz, s: 6.5 });
      }
    }
    for (let a = -rA + 4; a <= rB - 4; a += 16) {
      if (Math.abs(a) < wall + 2.5) continue;
      const px = f.x + f.rx * a, pz = f.z + f.rz * a, gy = H(px, pz);
      const pil = part(new THREE.BoxGeometry(2.2, deckY - gy, 2.2), '#5a5f78', px, (deckY + gy) / 2 - 0.5, pz);
      stat.addRaw(pil);
      reserve.add(px, pz, 3);
    }
    // a big sign hanging on the overpass side facing oncoming karts
    addSign(f.x - Math.sin(f.yaw) * 6.9, deckY + 3.4, f.z - Math.cos(f.yaw) * 6.9, f.yaw + Math.PI, 12, rng.int(0, BRANDS.length));
    overpasses.push(s);
    return true;
  };
  let nOver = 0;

  // ── Ferris wheel ──
  const wheels: Array<{ obj: THREE.Object3D; cx: number; cy: number; cz: number; yaw: number; r: number; first: number; n: number }> = [];
  const addWheel = (x: number, z: number, yaw: number, s: number) => {
    const R = 20 * s, y = H(x, z), cy = y + R + 4;
    const legs = combine([
      part(new THREE.BoxGeometry(0.9, R + 5, 0.9), '#8a8fab', 0, (R + 4) / 2, 3.2, 0.32, 0, 0),
      part(new THREE.BoxGeometry(0.9, R + 5, 0.9), '#8a8fab', 0, (R + 4) / 2, -3.2, -0.32, 0, 0),
      part(new THREE.BoxGeometry(16, 1.2, 10), '#3a3f55', 0, 0.6, 0),
      part(new THREE.BoxGeometry(6, 3, 5), '#ff2e88', 5, 1.5, 0),
    ]);
    legs.applyMatrix4(trs(x, y, z, 0, yaw + Math.PI / 2, 0, s, 1, s, m4));
    stat.addRaw(legs);
    const rim: THREE.BufferGeometry[] = [part(new THREE.TorusGeometry(R, 0.35, 6, 48), '#c9ccd8'), part(new THREE.TorusGeometry(R * 0.97, 0.2, 5, 48), '#c9ccd8', 0, 0, 1.4), part(new THREE.CylinderGeometry(1.2, 1.2, 3, 12), '#8a8fab', 0, 0, 0.7, Math.PI / 2)];
    const n = 16;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      rim.push(part(new THREE.BoxGeometry(0.18, R, 0.18), '#c9ccd8', Math.cos(a) * R / 2, Math.sin(a) * R / 2, 0.7, 0, 0, a - Math.PI / 2));
      rim.push(part(new RoundedBoxGeometry(2.0, 1.8, 1.6, 2, 0.35), TOY[k % TOY.length]!, Math.cos(a) * R, Math.sin(a) * R - 1.4, 0.7));
    }
    const wheel = new THREE.Mesh(combine(rim), mats.vc(0.5, { metalness: 0.2 }));
    wheel.position.set(x, cy, z);
    wheel.rotation.set(0, yaw, 0, 'YXZ');
    wheel.scale.setScalar(1);
    bag.add(root, wheel);
    const first = glows.length;
    for (let k = 0; k < 32; k++) glows.push(x, cy, z, 1.6, NEON[k % NEON.length]!, 1.3);
    wheels.push({ obj: wheel, cx: x, cy, cz: z, yaw, r: R, first, n: 32 });
    reserve.add(x, z, R * 0.6 + 8);
  };

  // ── landmark tower (fallback for unknown kinds) ──
  const addTower = (x: number, z: number, s: number) => {
    if (!clearOf(terrain, x, z, 8 * s, 3)) return;
    const h = 95 * s;
    addBuilding(x, z, 14 * s, 14 * s, h, true);
    const y = H(x, z);
    stat.add(antenna, trs(x, y + h + 0.4, z, 0, 0, 0, 1.6, 2.4, 1.6, m4));
    for (let k = 0; k < 4; k++) neonBatch.add(strip, trs(x, y + h * (0.25 + k * 0.2), z + 7.15 * s, 0, 0, 0, 14 * s, 1.4, 1, m4), NEON[k % NEON.length]);
    aviation.push(glows.push(x, y + h + 22, z, 5, '#ff2a3a', 1.8));
    reserve.add(x, z, 11 * s);
  };

  const archGlow = new Batch(mats.glow(), { name: 'neon-arch' });
  const archBase = bag.track(part(new THREE.BoxGeometry(1.6, 1, 4.2), '#1b1d29', 0, 0.5, 0));
  const addNeonArch = (f: ReturnType<typeof frameAt>) => {
    const wall = Math.max(track.wallL[f.i]!, track.wallR[f.i]!);
    const R = wall + 1.5;
    const yaw = f.yaw;
    const cols = ['#ff2e88', '#2de2e6', '#f7f06d'];
    // flattened hoops, but never lower than 4.9 m over the drivable width (at the barrier line a 0.62 ellipse
    // came down to ~3.9 m over the verge lanes)
    const u = Math.min(0.97, wall / R);
    const vs = Math.max(0.62, (4.9 - 0.2 + 0.22) / (R * Math.sqrt(1 - u * u)));
    for (let r = 0; r < 3; r++) {
      const t = new THREE.TorusGeometry(R + r * 0.9, 0.22, 6, 40, Math.PI);
      t.scale(1, vs, 1);
      t.applyMatrix4(trs(f.x - Math.sin(yaw) * r * 1.4, f.y + 0.2, f.z - Math.cos(yaw) * r * 1.4, 0, yaw + Math.PI / 2 + Math.PI / 2, 0, 1, 1, 1, m4));
      part(t, cols[r]!);
      archGlow.addRaw(t);
    }
    for (const sx of [-1, 1]) {
      const px = f.x + f.rx * sx * (R + 1.2), pz = f.z + f.rz * sx * (R + 1.2);
      stat.add(archBase, trs(px, H(px, pz), pz, 0, yaw, 0, 1, 3.5, 1, m4));
      glows.push(px, f.y + 3.8, pz, 4, cols[(sx + 1) / 2]!, 1.2);
      reserve.add(px, pz, 3);
    }
    addSign(f.x, f.y + R * vs + 1.9, f.z, yaw + Math.PI, 10, rng.int(0, BRANDS.length));
  };
  const bbBack = bag.track(part(new THREE.BoxGeometry(1, 1, 0.3), '#1b1d29'));
  // ── landmarks from the track ──
  let nWheel = 0;
  for (const l of track.landmarks) {
    if (isTrackMeshKind(l.kind)) continue;
    const k = normKind(l.kind);
    const pl = landmarkPlace(track, l, H);
    if (k === 'neonarch' || k === 'gate' || k === 'gateway' || k === 'neongate') { if (pl.side === 'over') addNeonArch(pl.frame); else addBillboard(pl.x, pl.z, pl.yaw, pl.scale); }
    else if (pl.side === 'over' || k === 'overpass' || k === 'highway' || k === 'skybridge' || k === 'bridge') { if (addOverpass(l.s)) nOver++; }
    else if (k === 'streetlamp' || k === 'lamp' || k === 'lamps' || k === 'lamppost') { if (!terrain.inCorridor(pl.x, pl.z, 1)) { addLamp(pl.x, pl.z, pl.yaw, '#ffc070'); addLamp(pl.x + Math.cos(pl.yaw) * 0.01, pl.z, pl.yaw + Math.PI, '#ff9ad8'); } }
    else if (k === 'building' || k === 'shop' || k === 'store' || k === 'apartment') {
      const cl = Math.min(16, (terrain.nearestTrack(pl.x, pl.z).dist - Math.max(track.wallL[pl.frame.i]!, track.wallR[pl.frame.i]!)) * 0.65);
      if (cl > 4 && reserve.ok(pl.x, pl.z, 1)) { addBuilding(pl.x, pl.z, cl * 1.4, cl * 1.4, rng.range(18, 45) * pl.scale, true); reserve.add(pl.x, pl.z, cl); }
    }
    else if (k === 'ferriswheel' || k === 'wheel' || k === 'bigwheel') { if (clearOf(terrain, pl.x, pl.z, 14 * pl.scale, 3)) { addWheel(pl.x, pl.z, pl.yaw, pl.scale); nWheel++; } }
    else if (k === 'billboard' || k === 'sign' || k === 'neon' || k === 'neonsign') addBillboard(pl.x, pl.z, pl.yaw, pl.scale);
    else addTower(pl.x, pl.z, pl.scale);
  }
  function addBillboard(x: number, z: number, yaw: number, s: number): void {
    if (terrain.inCorridor(x, z, 3) || !reserve.ok(x, z, 3)) return;
    const y = H(x, z), w = 11 * s, hh = 7 * s;
    const cx = Math.cos(yaw), cz = -Math.sin(yaw);
    for (const sx of [-1, 1]) stat.add(bbPole, trs(x + cx * sx * w * 0.33, y, z + cz * sx * w * 0.33, 0, 0, 0, 1, hh + w / 4, 1, m4));
    stat.add(bbBack, trs(x - Math.sin(yaw) * 0.25, y + hh + w / 4, z - Math.cos(yaw) * 0.25, 0, yaw, 0, w + 0.8, w / 2 + 0.8, 1, m4));
    addSign(x, y + hh + w / 4, z, yaw, w, rng.int(0, BRANDS.length), rng.chance(0.3));
    neonBatch.add(strip, trs(x, y + hh + w / 2 + 0.4, z, 0, yaw, 0, w + 0.6, 0.8, 1, m4), rng.pick(NEON));
    reserve.add(x, z, w / 2);
  }

  // ── signature props on any layout ──
  if (nOver < 2) {
    const cands: number[] = [];
    for (let i = 0; i < track.n; i += 9) {
      let ok = true;
      for (let k = -24; k <= 24 && ok; k += 4) { const j = (i + k + track.n) % track.n; if (Math.abs(track.curvature[j]!) > 0.006 || track.rampH[j]! > 0 || track.edgeL[j] === 2 || track.edgeR[j] === 2) ok = false; }
      const ds = Math.abs(((i * track.spacing - track.startS + track.length * 1.5) % track.length) - track.length / 2);
      if (ok && ds < track.length / 2 - 70) cands.push(i * track.spacing);
    }
    for (let k = 0; k < cands.length && nOver < 2; k++) {
      const s = cands[Math.floor((k * 0.618 * cands.length) % cands.length)]!;
      if (overpasses.some(o => Math.abs(o - s) < track.length / 4)) continue;
      if (addOverpass(s)) nOver++;
    }
  }
  if (!nWheel) {
    for (const p of scatter(terrain, 60, seed + 51, { minDist: 50, maxDist: 150, pad: 10 })) {
      if (clearOf(terrain, p.x, p.z, 16, 4) && reserve.ok(p.x, p.z, 2)) { addWheel(p.x, p.z, faceTrack(p.x, p.z) + Math.PI / 2, 1); break; }
    }
  }
  // road-side billboards
  for (let s0 = track.startS + 60, k = 0; s0 < track.startS + track.length - 40; s0 += 115, k++) {
    const f = frameAt(track, s0), side = k % 2 ? 1 : -1;
    const d = side * ((side < 0 ? track.wallL[f.i]! : track.wallR[f.i]!) + 8);
    const x = f.x + f.rx * d, z = f.z + f.rz * d;
    addBillboard(x, z, Math.atan2(f.x - x, f.z - z) + side * 0.35, 1);
  }

  // ── trees in planters, parked cars ──
  const treePts = scatter(terrain, qcount(90, q), seed + 8, { minDist: 12, maxDist: 70, pad: 2 }).filter(p => reserve.ok(p.x, p.z, 1.5));
  addInstanced(root, bag, cityTreeGeo(), mats.vc(0.8), treePts.map(p => ({ x: p.x, y: p.y - 0.1, z: p.z, ry: p.r, s: p.s })), { castShadow: true, receiveShadow: true, name: 'city-trees' });
  const parked: Xf[] = [];
  for (let k = 0; k < qcount(90, q) * 3 && parked.length < qcount(90, q); k++) {
    const bx = rng.int(Math.floor(tb.minX / BLOCK) + 1, Math.ceil(tb.maxX / BLOCK) - 1), bz = rng.int(Math.floor(tb.minZ / BLOCK) + 1, Math.ceil(tb.maxZ / BLOCK) - 1);
    const alongX = rng.chance(0.5);
    const off = rng.range(STREET + 4, BLOCK - 4), lane = rng.chance(0.5) ? 1.6 : STREET - 1.6;
    const x = alongX ? bx * BLOCK + off : bx * BLOCK + lane, z = alongX ? bz * BLOCK + lane : bz * BLOCK + off;
    if (terrain.inCorridor(x, z, 3) || !reserve.ok(x, z, 2.5)) continue;
    parked.push({ x, y: H(x, z), z, ry: (alongX ? Math.PI / 2 : 0) + (lane > 5 ? Math.PI : 0) });
    reserve.add(x, z, 2.5);
  }
  const parkedGeo = carGeo('#ffffff');
  bag.track(parkedGeo.lights);
  addInstanced(root, bag, parkedGeo.body, paintMat, parked, { colors: TOY, castShadow: true, receiveShadow: true, name: 'parked-cars' });

  // ── moving traffic on clear street stretches (shrinks at the ends of its stretch) ──
  const lanes: Array<{ ax: number; az: number; bx: number; bz: number; len: number; ys: Float32Array }> = [];
  for (let k = 0; k < 40 && lanes.length < qcount(10, q); k++) {
    const alongX = rng.chance(0.5);
    const line = rng.int(Math.floor((alongX ? tb.minZ : tb.minX) / BLOCK) + 1, Math.ceil((alongX ? tb.maxZ : tb.maxX) / BLOCK) - 1) * BLOCK + (rng.chance(0.5) ? 3.5 : STREET - 3.5);
    const lo = alongX ? tb.minX + 30 : tb.minZ + 30, hi = alongX ? tb.maxX - 30 : tb.maxZ - 30;
    let best: [number, number] | null = null, start = -1;
    for (let t = lo; t <= hi; t += 4) {
      const x = alongX ? t : line, z = alongX ? line : t;
      const ok = !terrain.inCorridor(x, z, 3) && !inPit(x, z);
      if (ok && start < 0) start = t;
      if ((!ok || t + 4 > hi) && start >= 0) { if (!best || t - start > best[1] - best[0]) best = [start, t - 4]; start = -1; }
    }
    if (!best || best[1] - best[0] < 110) continue;
    const dir = line % BLOCK < STREET / 2 ? 1 : -1;
    const [t0, t1] = dir > 0 ? best : [best[1], best[0]];
    const lane = alongX ? { ax: t0, az: line, bx: t1, bz: line, len: Math.abs(t1 - t0), ys: new Float32Array(0) } : { ax: line, az: t0, bx: line, bz: t1, len: Math.abs(t1 - t0), ys: new Float32Array(0) };
    const ns = Math.max(2, Math.ceil(lane.len / 4) + 1);
    lane.ys = new Float32Array(ns);
    for (let k = 0; k < ns; k++) { const u = k / (ns - 1); lane.ys[k] = H(lane.ax + (lane.bx - lane.ax) * u, lane.az + (lane.bz - lane.az) * u); }
    lanes.push(lane);
  }
  const traffic: Array<{ lane: number; t: number; speed: number }> = [];
  lanes.forEach((_, li) => { for (let k = 0; k < 3; k++) traffic.push({ lane: li, t: rng.next(), speed: rng.range(9, 15) }); });
  const tBody = carGeo('#ffffff');
  const trafficBody = traffic.length ? new THREE.InstancedMesh(tBody.body, paintMat, traffic.length) : null;
  const trafficLights = traffic.length ? new THREE.InstancedMesh(tBody.lights, mats.glow(), traffic.length) : null;
  bag.track(tBody.body); bag.track(tBody.lights);
  if (trafficBody && trafficLights) {
    traffic.forEach((_, k) => trafficBody.setColorAt(k, new THREE.Color(TOY[k % TOY.length]!)));
    trafficBody.instanceMatrix.setUsage(THREE.DynamicDrawUsage); trafficLights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    trafficBody.frustumCulled = false; trafficLights.frustumCulled = false;
    trafficBody.castShadow = true;
    bag.add(root, trafficBody); bag.add(root, trafficLights);
  }

  // ── searchlights ──
  const beamGeo = bag.track(new THREE.ConeGeometry(16, 320, 20, 1, true));
  beamGeo.translate(0, -160, 0); beamGeo.rotateX(Math.PI);
  const beamMat = bag.track(new THREE.MeshBasicMaterial({ color: '#b8c8ff', transparent: true, opacity: 0.035, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  const beams: Array<{ obj: THREE.Object3D; ph: number; sp: number }> = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.5, r = half + 120;
    const b = new THREE.Mesh(beamGeo, beamMat);
    b.position.set(tcx + Math.cos(a) * r, ext.minY + 60, tcz + Math.sin(a) * r);
    b.renderOrder = 5;
    bag.add(root, b);
    beams.push({ obj: b, ph: k * 2.1, sp: 0.22 + k * 0.05 });
  }

  // ── void below pit edges: dark abyss with a glowing neon grid and a haze rising from it ──
  const voidMat = bag.track(new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uBase: { value: new THREE.Color(PAL.pitColor) }, uA: { value: new THREE.Color('#ff2e88') }, uB: { value: new THREE.Color('#2de2e6') } }]),
    vertexShader: `varying vec3 vW;\n#include <fog_pars_vertex>\nvoid main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;\n#include <fog_vertex>\n}`,
    fragmentShader: `uniform float uTime; uniform vec3 uBase; uniform vec3 uA; uniform vec3 uB; varying vec3 vW;
#include <common>
#include <fog_pars_fragment>
void main(){
  vec2 q = vW.xz / 7.0;
  vec2 fw = max(fwidth(q), vec2(1e-4));
  vec2 g = abs(fract(q - 0.5) - 0.5);
  vec2 l2 = 1.0 - smoothstep(vec2(0.035), vec2(0.035) + fw * 1.5, g);
  float line = max(l2.x, l2.y);
  float fade = clamp(1.0 - max(fw.x, fw.y) * 3.0, 0.25, 1.0);
  float pulse = 0.6 + 0.4 * sin(uTime * 1.5 + (vW.x + vW.z) * 0.02);
  vec3 neon = mix(uA, uB, 0.5 + 0.5 * sin(vW.x * 0.012 + vW.z * 0.008 + uTime * 0.3));
  vec3 c = uBase + neon * line * pulse * 1.8 * fade + neon * 0.05;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`,
    fog: true,
  }));
  const hazeMat = bag.track(new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uA: { value: new THREE.Color('#ff2e88') }, uB: { value: new THREE.Color('#7b5cff') } },
    vertexShader: 'attribute float aT; varying float vT; varying vec3 vW; void main(){ vT = aT; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform float uTime; uniform vec3 uA; uniform vec3 uB; varying float vT; varying vec3 vW;
void main(){
  float a = pow(1.0 - vT, 2.2) * (0.75 + 0.25 * sin(uTime * 0.9 + vW.x * 0.03 + vW.z * 0.02));
  vec3 c = mix(uA, uB, 0.5 + 0.5 * sin(vW.x * 0.01 + uTime * 0.2)) * a * 0.55;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }));
  for (const run of pitRuns(track)) {
    const top = runMinY(track, run);
    const g = pitStrip(track, run, 70, top - 36);
    const m = new THREE.Mesh(g, voidMat); m.name = 'void-grid';
    bag.add(root, m);
    for (const [lvl, w] of [[top - 9, 34], [top - 20, 48]] as const) {
      const hz = pitStrip(track, run, w, lvl, 2);
      const cnt = hz.attributes.position!.count;
      const at = new Float32Array(cnt);
      for (let i = 0; i < cnt; i++) at[i] = i % 2;
      hz.setAttribute('aT', new THREE.BufferAttribute(at, 1));
      const hm = new THREE.Mesh(hz, hazeMat); hm.name = 'void-haze'; hm.renderOrder = 4;
      bag.add(root, hm);
    }
  }

  // ── far ground + build batches ──
  bag.add(root, buildFarGround(tcx, tcz, half * 0.85, half + 900, ext.minY - 6, '#151525', 0.6));
  bBatch.forEach(b => b.build(root, bag));
  ringBatch.forEach(b => b.build(root, bag));
  stat.build(root, bag);
  neonBatch.build(root, bag);
  archGlow.build(root, bag);
  signs.build(root, bag);
  flickerSigns.build(root, bag);
  addInstanced(root, bag, lampTemplate, mats.vc(0.5, { metalness: 0.3 }), lampXf, { castShadow: true, name: 'lamps' });
  const poolMat = bag.track(new THREE.MeshBasicMaterial({ map: glowTex, color: new THREE.Color('#ffb870').multiplyScalar(0.55), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: true }));
  const poolGeo = new THREE.PlaneGeometry(1, 1); poolGeo.rotateX(-Math.PI / 2);
  const pools = addInstanced(root, bag, poolGeo, poolMat, poolXf, { name: 'light-pools' });
  if (pools) pools.renderOrder = 1;

  // ── movers ──
  const rigs: MoverRig[] = [];
  let moverGeneric: THREE.BufferGeometry | null = null;
  const tm = new THREE.Matrix4(), tq = new THREE.Quaternion(), tv = new THREE.Vector3(), ts = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const wheelV = new THREE.Vector3();

  return {
    environment: CITY_ENV,
    update(dt, time) {
      void dt;
      for (let k = 0; k < aviation.length; k++) { const ph = (time * 0.9 + k * 0.37) % 1; glows.setLevel(aviation[k]!, ph < 0.12 ? 1.3 : 0.12); }
      const fl = Math.sin(time * 23) > 0.35 || Math.sin(time * 3.1) > 0.9 ? 1 : 0.35;
      flickerMat.color.setScalar(1.45 * fl);
      for (const w of wheels) {
        const a0 = time * 0.12;
        w.obj.rotation.z = a0;
        for (let k = 0; k < w.n; k++) {
          const a = a0 + (k / w.n) * Math.PI * 2;
          wheelV.set(Math.cos(a) * w.r, Math.sin(a) * w.r, 0.7).applyAxisAngle(up, w.yaw);
          glows.setPos(w.first + k, w.cx + wheelV.x, w.cy + wheelV.y, w.cz + wheelV.z);
          glows.setLevel(w.first + k, 0.7 + 0.5 * Math.sin(time * 4 + k * 0.8));
        }
      }
      for (const b of beams) b.obj.rotation.set(0.45 + 0.2 * Math.sin(time * 0.3 + b.ph), time * b.sp + b.ph, 0, 'YXZ');
      (voidMat.uniforms.uTime as { value: number }).value = time;
      (hazeMat.uniforms.uTime as { value: number }).value = time;
      if (trafficBody && trafficLights) {
        for (let k = 0; k < traffic.length; k++) {
          const c = traffic[k]!, L = lanes[c.lane]!;
          const u = (c.t + (time * c.speed) / L.len) % 1;
          const x = L.ax + (L.bx - L.ax) * u, z = L.az + (L.bz - L.az) * u;
          const sc = Math.min(1, Math.min(u, 1 - u) * L.len / 5);
          tq.setFromAxisAngle(up, Math.atan2(L.bx - L.ax, L.bz - L.az));
          const fy = u * (L.ys.length - 1), iy = Math.min(L.ys.length - 2, Math.floor(fy));
          tm.compose(tv.set(x, L.ys[iy]! + (L.ys[iy + 1]! - L.ys[iy]!) * (fy - iy), z), tq, ts.set(sc, sc, sc));
          trafficBody.setMatrixAt(k, tm); trafficLights.setMatrixAt(k, tm);
        }
        trafficBody.instanceMatrix.needsUpdate = true; trafficLights.instanceMatrix.needsUpdate = true;
      }
      for (const r of rigs) {
        if (r.kind === 'car' || r.kind === 'bus') { r.inner.position.y = Math.sin(time * 9 + r.phase) * 0.03; r.inner.rotation.z = Math.sin(time * 5 + r.phase) * 0.015; }
        else updateGeneric(r, time);
      }
    },
    createMover(look) {
      const k = normKind(look);
      if (k === 'car' || k === 'taxi' || k === 'bus' || k === 'truck' || k === 'van') {
        const isBus = k === 'bus' || k === 'truck';
        const col = isBus ? rng.pick(['#ffb627', '#ff5d5d', '#35c26e']) : TOY[rigs.length % TOY.length]!;
        const g = isBus ? busGeo(col) : carGeo(k === 'taxi' ? '#ffd23f' : col);
        bag.track(g.body); bag.track(g.lights);
        const inner = new THREE.Group();
        const body = new THREE.Mesh(g.body, paintMat);
        body.castShadow = true;
        inner.add(body, new THREE.Mesh(g.lights, mats.glow()));
        // match the sim's collision capsules (race.ts: car r 1.5 / half 1.2, bus r 1.9 / half 3.4): at 1.0 the bus
        // (2.6 × 8.6 m) knocked karts back 0.6 m before its flank and 1 m before its nose was ever touched
        inner.scale.setScalar(isBus ? 1.14 : 1.15);
        const rig = makeRig(isBus ? 'bus' : 'car', inner, rigs.length * 1.3);
        rigs.push(rig);
        return rig.root;
      }
      moverGeneric ??= bag.track(genericMoverGeo(PAL.accent));
      const rig = makeGenericRig(moverGeneric, paintMat, rigs.length * 1.7);
      rigs.push(rig);
      return rig.root;
    },
    dispose() { bag.dispose(); rigs.length = 0; },
  };
}
