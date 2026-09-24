/**
 * Menu showroom: self-contained scene (own lights, backdrop, effects) rendered by the
 * pipeline behind the UI.
 *   'title'  — stylised round stage, karts parading in a circle under a sunburst sky.
 *   'garage' — one kart on a slowly rotating turntable in a soft studio, idle driver.
 *   'podium' — 1-2-3 podium at dusk, drivers celebrating, confetti + fireworks.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { CHARACTERS } from '../../sim/characters.js';
import type { CharacterId, KartState } from '../../sim/types.js';
import type { KartVisual, RenderPipeline, Showroom } from './contracts.js';
import { createDisplayKartState, createKartVisual, type KartVisualExtras } from './kart-model.js';
import { canvasTexture, createFxPointsMaterial, getGlowTexture, getShadowTexture, getSparkTexture, makeCanvas, roundRect, INK } from './kart-materials.js';
import { createItemDisplayMesh } from './item-models.js';

type Mode = 'title' | 'garage' | 'podium';
type Visual = KartVisual & KartVisualExtras;

interface Actor { v: Visual; k: KartState; id: CharacterId; x: number; z: number; yaw: number; y: number; pop: number; phase: number }

const clamp = THREE.MathUtils.clamp;
const easeOutBack = (x: number) => { const c1 = 1.7, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

interface SkyOpts { top: string; mid: string; horizon: string; bottom: string; rays?: { color: string; count: number; strength: number } }

/** Gradient sky dome (direction based, so the horizon always sits at eye level) with optional sunburst. */
function skyDome(o: SkyOpts, time: { value: number }): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      cTop: { value: new THREE.Color(o.top) }, cMid: { value: new THREE.Color(o.mid) },
      cHor: { value: new THREE.Color(o.horizon) }, cBot: { value: new THREE.Color(o.bottom) },
      cRay: { value: new THREE.Color(o.rays?.color ?? '#ffffff') },
      uRays: { value: o.rays?.count ?? 0 }, uRayStr: { value: o.rays?.strength ?? 0 }, uTime: time,
    },
    vertexShader: `varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 cTop; uniform vec3 cMid; uniform vec3 cHor; uniform vec3 cBot; uniform vec3 cRay;
      uniform float uRays; uniform float uRayStr; uniform float uTime; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 c = h > 0.0 ? mix(mix(cHor, cMid, smoothstep(0.0, 0.14, h)), cTop, smoothstep(0.14, 0.7, h)) : mix(cHor, cBot, smoothstep(0.0, -0.18, h));
        if (uRays > 0.0 && d.z < 0.0) {
          vec2 q = vec2(d.x, d.y - 0.12) / max(0.2, -d.z);
          float a = atan(q.y, q.x) / 6.28318 * uRays + uTime * 0.03;
          float band = smoothstep(0.35, 0.5, abs(fract(a) - 0.5) * 2.0);
          float fall = exp(-length(q) * 0.55);
          c = mix(c, cRay, band * uRayStr * fall * smoothstep(-0.05, 0.08, h));
          c += cRay * exp(-length(q) * 3.2) * 0.35;
        }
        // keep the backdrop under the pipeline's bloom threshold (0.86 linear luminance) so the
        // whole sky does not bloom into a milky haze; only the stage and karts may glow
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c *= min(1.0, 0.78 / max(lum, 1e-4));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(150, 40, 20), mat);
  m.renderOrder = -10;
  m.frustumCulled = false;
  return m;
}

/**
 * Large floor disc whose colour fades into the horizon colour at the rim. Unlit by default: the
 * floor then shows exactly the gradient (seamless with the sky horizon) and never climbs past the
 * pipeline's bloom threshold the way a lit near-white floor does. `lit` floors receive shadows.
 */
function fadeFloor(center: string, edge: string, radius = 120, y = -0.02, lit = false): THREE.Mesh {
  const { canvas, ctx } = makeCanvas(512);
  const g = ctx.createRadialGradient(256, 256, 0, 256, 256, 256);
  g.addColorStop(0, center); g.addColorStop(0.12, center); g.addColorStop(0.55, edge); g.addColorStop(1, edge);
  ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 512);
  const map = canvasTexture(canvas);
  const mat = lit ? new THREE.MeshStandardMaterial({ map, roughness: 0.9 }) : new THREE.MeshBasicMaterial({ map });
  mat.userData.ownMap = true;
  const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 64).rotateX(-Math.PI / 2), mat);
  m.position.y = y;
  m.receiveShadow = lit;
  return m;
}

function stageTexture(): THREE.Texture {
  const S = 1024, { canvas, ctx } = makeCanvas(S);
  const c = S / 2;
  const rings: Array<[number, string]> = [[500, '#1b1036'], [488, '#ffd23f'], [462, '#ff4f8b'], [436, '#eef0f7'], [420, '#3a7bff'], [300, '#4b8dff'], [292, '#eef0f7'], [150, '#5c9dff']];
  for (const [r, col] of rings) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fill(); }
  // checker band
  ctx.save(); ctx.translate(c, c);
  for (let i = 0; i < 48; i++) {
    ctx.fillStyle = i % 2 ? '#1b1036' : '#eef0f7';
    ctx.beginPath(); ctx.arc(0, 0, 436, (i / 48) * Math.PI * 2, ((i + 1) / 48) * Math.PI * 2); ctx.arc(0, 0, 420, ((i + 1) / 48) * Math.PI * 2, (i / 48) * Math.PI * 2, true); ctx.fill();
  }
  // stars around the inner ring
  ctx.fillStyle = '#ffe066';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    star(ctx, Math.cos(a) * 360, Math.sin(a) * 360, 22, 10);
  }
  ctx.restore();
  // centre emblem
  ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.8;
  star(ctx, c, c, 110, 48);
  ctx.globalAlpha = 1;
  const t = canvasTexture(canvas);
  t.anisotropy = 8;
  return t;
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r : R;
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath(); ctx.fill();
}

function numberTexture(n: number, bg: string, fg: string): THREE.Texture {
  const { canvas, ctx } = makeCanvas(256);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = 'rgba(255,255,255,0.18)'; roundRect(ctx, 18, 18, 220, 220, 36); ctx.fill();
  ctx.font = '900 190px "Black Han Sans", "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round'; ctx.lineWidth = 18; ctx.strokeStyle = INK;
  ctx.strokeText(String(n), 128, 140);
  ctx.fillStyle = fg; ctx.fillText(String(n), 128, 140);
  return canvasTexture(canvas);
}

export function createShowroom(pipeline: RenderPipeline): Showroom {
  const quality = pipeline.quality;
  const scene = new THREE.Scene();
  scene.name = 'showroom';
  const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 400);
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(x: T): T => { disposables.push(x); return x; };

  // ── lights (shared by all modes; intensities tweaked per mode) ──
  const hemi = new THREE.HemisphereLight('#e3f2ff', '#8c7a66', 1.0);
  const key = new THREE.DirectionalLight('#fff1dc', 2.6);
  key.position.set(6, 12, 9);
  key.castShadow = quality.shadows;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 40 });
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 4;
  const rimA = new THREE.DirectionalLight('#7fdcff', 1.4);
  rimA.position.set(-8, 5, -8);
  const rimB = new THREE.DirectionalLight('#ff8fd8', 1.1);
  rimB.position.set(8, 4, -7);
  scene.add(hemi, key, key.target, rimA, rimB);

  // ── mode groups ──
  const groups: Record<Mode, THREE.Group> = { title: new THREE.Group(), garage: new THREE.Group(), podium: new THREE.Group() };
  for (const g of Object.values(groups)) { g.visible = false; scene.add(g); }
  const built: Record<Mode, boolean> = { title: false, garage: false, podium: false };

  // per-character visual pool (reused across modes)
  const pool = new Map<CharacterId, Visual[]>();
  const inUse = new Set<Visual>();
  const takeVisual = (id: CharacterId): Visual => {
    let list = pool.get(id);
    if (!list) { list = []; pool.set(id, list); }
    let v = list.find(x => !inUse.has(x));
    if (!v) { v = createKartVisual(id, quality); list.push(v); }
    inUse.add(v);
    return v;
  };
  let actors: Actor[] = [];
  let mode: Mode = 'title';
  let modeTime = 0;
  let clock = 0;

  // ── title stage ──
  const skyTime = { value: 0 };
  const stageRim: THREE.InstancedMesh[] = [];
  const BULB_ON = [new THREE.Color('#fff3b0'), new THREE.Color('#ff8fd8')];
  const BULB_DIM = [new THREE.Color('#8a7a4a'), new THREE.Color('#7a3a68')];
  const titleProps: THREE.Object3D[] = [];
  const buildTitle = () => {
    const g = groups.title;
    g.add(skyDome({ top: '#1459d6', mid: '#3f9dff', horizon: '#ffe3a6', bottom: '#ffd08a', rays: { color: '#bfe6ff', count: 16, strength: 0.22 } }, skyTime));
    g.add(fadeFloor('#7cc4ff', '#ffe3a6', 140, -0.9));
    // stage
    const top = track(stageTexture());
    const mats = [
      track(new THREE.MeshStandardMaterial({ color: '#3a7bff', roughness: 0.45 })),
      track(new THREE.MeshStandardMaterial({ map: top, roughness: 0.55 })),
      track(new THREE.MeshStandardMaterial({ color: '#2a2f6b', roughness: 0.6 })),
    ];
    const disc = new THREE.Mesh(track(new THREE.CylinderGeometry(7.2, 7.5, 0.6, 72, 1)), mats);
    disc.position.y = -0.3;
    disc.receiveShadow = true;
    g.add(disc);
    const skirt = new THREE.Mesh(track(new THREE.CylinderGeometry(7.6, 8.2, 0.5, 72, 1)), mats[2]);
    skirt.position.y = -0.62;
    g.add(skirt);
    // glowing rim lights (emissive bulbs)
    const bulbGeo = track(new THREE.SphereGeometry(0.09, 10, 8));
    const bulbMat = track(new THREE.MeshBasicMaterial({ color: '#fff3b0' }));
    const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, 72);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      m.makeTranslation(Math.sin(a) * 7.42, -0.3, Math.cos(a) * 7.42);
      bulbs.setMatrixAt(i, m);
      bulbs.setColorAt(i, new THREE.Color(i % 2 ? '#fff3b0' : '#ff8fd8'));
    }
    g.add(bulbs);
    stageRim.push(bulbs);
    const ring = new THREE.Mesh(track(new THREE.TorusGeometry(7.25, 0.06, 8, 96).rotateX(Math.PI / 2)), track(new THREE.MeshBasicMaterial({ color: '#dfe9ff' })));
    ring.position.y = 0.005;
    g.add(ring);
    // floating item boxes & coins for charm
    for (const [x, y, z, kind, s] of [[-8.3, 3.9, -5, 'box', 1.25], [8.7, 4.5, -7, 'box', 1.15], [-5.4, 5.5, -12, 'coin', 1.4], [6.7, 2.7, -1.5, 'coin', 1.2], [-12.5, 0.9, -16, 'box', 1.05]] as const) {
      const o = createItemDisplayMesh(kind);
      o.position.set(x, y, z);
      o.scale.setScalar(s);
      o.userData.baseY = y;
      g.add(o);
      titleProps.push(o);
    }
  };

  // ── garage ──
  let turntable: THREE.Group | null = null;
  const buildGarage = () => {
    const g = groups.garage;
    g.add(skyDome({ top: '#3440c0', mid: '#7481f5', horizon: '#d6d2fb', bottom: '#bfc0e8', rays: { color: '#ffffff', count: 12, strength: 0.1 } }, skyTime));
    g.add(fadeFloor('#ebe8fb', '#bfc0e8', 60, -0.36));
    const ttShadow = new THREE.Mesh(track(new THREE.PlaneGeometry(7.4, 7.4).rotateX(-Math.PI / 2)),
      track(new THREE.MeshBasicMaterial({ map: getShadowTexture(), color: '#1c1a3a', transparent: true, opacity: 0.55, depthWrite: false })));
    ttShadow.position.y = -0.35;
    ttShadow.renderOrder = -1;
    g.add(ttShadow);
    const tt = new THREE.Group();
    const { canvas: c2, ctx: x2 } = makeCanvas(512);
    x2.fillStyle = '#2b2f55'; x2.fillRect(0, 0, 512, 512);
    x2.save(); x2.translate(256, 256);
    for (let i = 0; i < 24; i++) {
      x2.fillStyle = i % 2 ? '#353a6a' : '#2b2f55';
      x2.beginPath(); x2.moveTo(0, 0); x2.arc(0, 0, 256, (i / 24) * Math.PI * 2, ((i + 1) / 24) * Math.PI * 2); x2.fill();
    }
    x2.strokeStyle = '#ffd23f'; x2.lineWidth = 10; x2.beginPath(); x2.arc(0, 0, 238, 0, Math.PI * 2); x2.stroke();
    x2.strokeStyle = 'rgba(255,255,255,0.5)'; x2.lineWidth = 4; x2.beginPath(); x2.arc(0, 0, 150, 0, Math.PI * 2); x2.stroke();
    x2.restore();
    const ttMats = [
      track(new THREE.MeshStandardMaterial({ color: '#c3c9dc', roughness: 0.3, metalness: 0.6 })),
      track(new THREE.MeshStandardMaterial({ map: track(canvasTexture(c2)), roughness: 0.5 })),
      track(new THREE.MeshStandardMaterial({ color: '#2b2f55' })),
    ];
    const plate = new THREE.Mesh(track(new THREE.CylinderGeometry(2.3, 2.45, 0.34, 64, 1)), ttMats);
    plate.position.y = -0.17;
    plate.receiveShadow = true;
    plate.castShadow = quality.shadows;
    tt.add(plate);
    const glow = new THREE.Mesh(track(new THREE.TorusGeometry(2.42, 0.035, 8, 96).rotateX(Math.PI / 2)), track(new THREE.MeshBasicMaterial({ color: '#7fdcff' })));
    glow.position.y = -0.12;
    tt.add(glow);
    g.add(tt);
    turntable = tt;
  };

  // ── podium ──
  let confetti: THREE.InstancedMesh | null = null;
  const confettiState: Array<{ x: number; y: number; z: number; vy: number; rx: number; ry: number; spin: number; ph: number }> = [];
  let fireworks: THREE.Points | null = null;
  const fwP: Array<{ x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; r: number; g: number; b: number; size: number }> = [];
  let fwNext = 0;
  const beams: THREE.Mesh[] = [];
  const PODIUM: Array<[number, number, string, string]> = [[0, 1.25, '#ffd23f', '#fff6c8'], [-3.1, 0.85, '#cfd8e6', '#ffffff'], [3.1, 0.6, '#e39a5b', '#ffe2c8']];
  const buildPodium = () => {
    const g = groups.podium;
    g.add(skyDome({ top: '#0b1040', mid: '#4a2f99', horizon: '#ff9f70', bottom: '#3a2a66', rays: { color: '#ffd9a8', count: 10, strength: 0.12 } }, skyTime));
    // stars
    const starGeo = new THREE.BufferGeometry();
    const sp: number[] = [];
    for (let i = 0; i < 260; i++) {
      const a = Math.random() * Math.PI - Math.PI / 2 + Math.PI, y = 12 + Math.random() * 30;
      sp.push(Math.sin(a) * 55, y, Math.cos(a) * 55);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    g.add(new THREE.Points(track(starGeo), track(new THREE.PointsMaterial({ color: '#ffffff', size: 0.35, sizeAttenuation: true, fog: false }))));
    // floor
    g.add(fadeFloor('#6a58b8', '#3a2a66', 140, 0, true));
    const carpet = new THREE.Mesh(track(new THREE.PlaneGeometry(3.2, 20).rotateX(-Math.PI / 2)), track(new THREE.MeshStandardMaterial({ color: '#d7263d', roughness: 0.9 })));
    carpet.position.set(0, 0.01, 10);
    carpet.receiveShadow = true;
    g.add(carpet);
    PODIUM.forEach(([x, h, trim, face], i) => {
      const blk = new THREE.Mesh(track(new RoundedBoxGeometry(2.9, h, 2.6, 3, 0.14)), track(new THREE.MeshStandardMaterial({ color: '#f6f3ff', roughness: 0.4 })));
      blk.position.set(x, h / 2, 0);
      blk.castShadow = blk.receiveShadow = quality.shadows;
      g.add(blk);
      const band = new THREE.Mesh(track(new RoundedBoxGeometry(3.0, 0.16, 2.7, 2, 0.06)), track(new THREE.MeshStandardMaterial({ color: trim, roughness: 0.25, metalness: 0.6 })));
      band.position.set(x, h - 0.05, 0);
      g.add(band);
      const num = new THREE.Mesh(track(new THREE.PlaneGeometry(1.0, 1.0)), track(new THREE.MeshStandardMaterial({ map: track(numberTexture(i + 1, trim, face)), roughness: 0.4 })));
      num.position.set(x, Math.max(0.36, h / 2 - 0.05), 1.305);
      num.scale.setScalar(Math.min(1, h * 0.9));
      g.add(num);
    });
    // spotlight beams
    const beamMat = track(new THREE.MeshBasicMaterial({ map: getGlowTexture(), color: '#ffe8b0', transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    for (const s of [-1, -0.35, 0.35, 1]) {
      const beam = new THREE.Mesh(track(new THREE.ConeGeometry(1.8, 22, 24, 1, true).translate(0, -11, 0)), beamMat);
      beam.position.set(s * 12, 20, -10);
      g.add(beam);
      beams.push(beam);
    }
    // confetti
    const cgeo = track(new THREE.PlaneGeometry(0.12, 0.2));
    confetti = new THREE.InstancedMesh(cgeo, track(new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, fog: false })), Math.round(360 * Math.max(0.4, quality.particles)));
    const cols = ['#ff4f8b', '#ffd23f', '#3aa8ff', '#38e36b', '#c850ff', '#ffffff', '#ff8c1a'].map(c => new THREE.Color(c));
    for (let i = 0; i < confetti.count; i++) {
      confetti.setColorAt(i, cols[i % cols.length]!);
      confettiState.push({ x: (Math.random() - 0.5) * 16, y: Math.random() * 12, z: (Math.random() - 0.5) * 8 + 1, vy: 0.9 + Math.random() * 0.9, rx: Math.random() * 6, ry: Math.random() * 6, spin: 2 + Math.random() * 5, ph: Math.random() * 6 });
    }
    confetti.frustumCulled = false;
    g.add(confetti);
    // fireworks
    const N = Math.round(320 * Math.max(0.4, quality.particles));
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    fg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 4), 4));
    fg.setAttribute('psize', new THREE.BufferAttribute(new Float32Array(N), 1));
    fireworks = new THREE.Points(track(fg), track(createFxPointsMaterial(getSparkTexture(), true)));
    fireworks.frustumCulled = false;
    for (let i = 0; i < N; i++) fwP.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, r: 1, g: 1, b: 1, size: 0.5 });
    g.add(fireworks);
  };

  const place = (list: Array<{ id: CharacterId; x: number; z: number; yaw: number; y?: number }>) => {
    for (const a of actors) { a.v.root.removeFromParent(); a.v.setCheer(0); inUse.delete(a.v); }
    actors = list.map((p, i) => {
      const v = takeVisual(p.id);
      groups[mode].add(v.root);
      const k = createDisplayKartState(p.id, i);
      return { v, k, id: p.id, x: p.x, z: p.z, yaw: p.yaw, y: p.y ?? 0, pop: 0, phase: i * 1.37 };
    });
  };

  const show = (m: Mode, chars: CharacterId[]) => {
    const list = chars.length ? chars : CHARACTERS.map(c => c.id);
    if (m === mode && modeTime > 0 && actors.length && m !== 'podium') {
      // garage: swap the kart if the character changed; title: keep the parade running
      if (m === 'garage' && actors[0]!.id !== list[0]) {
        place([{ id: list[0]!, x: 0, z: 0, yaw: 0 }]);
        if (turntable) turntable.rotation.y = -0.25; // present the new kart 3/4 front
        actors[0]!.pop = 0;
      }
      return;
    }
    mode = m;
    if (!built[m]) { ({ title: buildTitle, garage: buildGarage, podium: buildPodium })[m](); built[m] = true; }
    for (const [k, g] of Object.entries(groups)) g.visible = k === m;
    modeTime = 0;
    if (m === 'title') {
      const ids = list.slice(0, 8);
      place(ids.map(id => ({ id, x: 0, z: 0, yaw: 0 })));
    } else if (m === 'garage') {
      place([{ id: list[0]!, x: 0, z: 0, yaw: 0 }]);
    } else {
      const top = list.slice(0, 3);
      place(top.map((id, i) => ({ id, x: PODIUM[i]![0], z: 0.1, yaw: 0, y: PODIUM[i]![1] })));
      fwNext = 0.3;
    }
    // lighting per mode
    if (m === 'podium') {
      hemi.color.set('#9fa8ff'); hemi.groundColor.set('#5a3a6b'); hemi.intensity = 0.9;
      key.color.set('#ffe6c8'); key.intensity = 2.4; key.position.set(4, 12, 10);
      rimA.color.set('#6fd6ff'); rimA.intensity = 1.8; rimB.color.set('#ff7ad8'); rimB.intensity = 1.6;
    } else if (m === 'garage') {
      hemi.color.set('#e6f0ff'); hemi.groundColor.set('#6a6f8c'); hemi.intensity = 1.0;
      key.color.set('#fff4e6'); key.intensity = 2.5; key.position.set(5, 10, 8);
      rimA.color.set('#7fdcff'); rimA.intensity = 1.6; rimB.color.set('#ffb0e6'); rimB.intensity = 1.2;
    } else {
      // the stage fills half the frame: keep its lit blues just under the pipeline's bloom threshold
      hemi.color.set('#e3f2ff'); hemi.groundColor.set('#8c7a66'); hemi.intensity = 0.85;
      key.color.set('#fff1dc'); key.intensity = 2.15; key.position.set(6, 12, 9);
      rimA.color.set('#7fdcff'); rimA.intensity = 0.9; rimB.color.set('#ff8fd8'); rimB.intensity = 0.75;
    }
  };

  const baseCam = { title: [0, 3.1, 13.2, 0, 0.8, 0, 38], garage: [0.2, 1.55, 5.6, 0, 0.72, 0, 34], podium: [0, 2.7, 9.8, 0, 1.65, 0, 38] } as Record<Mode, number[]>;
  let aspect = 16 / 9;

  const update = (dt: number, time: number) => {
    const d = clamp(dt, 0, 0.1);
    clock += d;
    modeTime += d;
    const t = clock;
    skyTime.value = t;
    if (mode === 'title') {
      const R = 4.6, n = actors.length || 1;
      const w = 0.42;
      actors.forEach((a, i) => {
        const th = t * w + (i / n) * Math.PI * 2;
        const k = a.k;
        k.x = Math.sin(th) * R; k.z = Math.cos(th) * R; k.y = 0;
        k.yaw = th + Math.PI / 2;
        k.speed = w * R;
        k.steerVisual = -0.35 + Math.sin(t * 1.3 + i) * 0.1;
        // playful moments: hops, a short drift + boost
        const cyc = (t + i * 1.9) % 9;
        k.hopTime = cyc < 0.3 ? 0.3 - cyc : 0;
        const hopY = cyc < 0.3 ? Math.sin((cyc / 0.3) * Math.PI) * 0.35 : 0;
        k.grounded = hopY <= 0.001;
        k.boostTime = cyc > 5 && cyc < 5.9 ? 0.9 - (cyc - 5) : 0; k.boostKind = i % 3 === 0 ? 'mini2' : i % 3 === 1 ? 'mini1' : 'mini3';
        k.driftDir = cyc > 3 && cyc < 5 ? -1 : 0; k.driftLevel = cyc > 4.2 ? 2 : cyc > 3.6 ? 1 : 0;
        k.driftAngle = k.driftDir ? 0.3 : 0;
        // staggered pop-in: pop runs to 1 + stagger so every kart settles at exactly scale 1
        a.pop = Math.min(1 + i * 0.06, a.pop + d * 2.5);
        a.v.update(k, { x: k.x, y: hopY, z: k.z, yaw: k.yaw }, d, { lookBack: false, throttle: true, time: t });
        a.v.root.scale.setScalar(Math.max(0.01, easeOutBack(clamp(a.pop - i * 0.06, 0, 1))));
      });
      for (const o of titleProps) { o.rotation.y = t * 0.8 + o.position.x; o.position.y = (o.userData.baseY as number) + Math.sin(t * 1.4 + o.position.x) * 0.25; }
      // marquee chase around the stage rim
      const step = Math.floor(t * 7);
      for (const b of stageRim) {
        for (let i = 0; i < b.count; i++) {
          const lit = (i + step) % 6 < 4;
          b.setColorAt(i, (lit ? BULB_ON : BULB_DIM)[i % 2]!);
        }
        if (b.instanceColor) b.instanceColor.needsUpdate = true;
      }
    } else if (mode === 'garage') {
      const a = actors[0];
      if (turntable) turntable.rotation.y += d * 0.3;
      if (a) {
        const k = a.k;
        const yaw = (turntable?.rotation.y ?? 0) + 0.6;
        k.x = 0; k.z = 0; k.yaw = yaw; k.speed = 0;
        k.steerVisual = Math.sin(t * 0.7) * 0.45;
        const rev = (t % 6) > 4.6 && (t % 6) < 5.4;
        a.pop = Math.min(1, a.pop + d * 2.2);
        const hop = a.pop < 1 ? Math.sin(a.pop * Math.PI) * 0.35 : 0;
        a.v.update(k, { x: 0, y: hop, z: 0, yaw }, d, { lookBack: false, throttle: rev, time: t });
        a.v.root.scale.setScalar(Math.max(0.01, easeOutBack(a.pop)));
      }
    } else {
      actors.forEach((a, i) => {
        const k = a.k;
        k.x = a.x; k.z = a.z; k.y = a.y; k.yaw = a.yaw + Math.sin(t * 0.8 + i) * 0.12;
        k.speed = 0;
        a.v.setCheer(1);
        const hop = i === 0 ? Math.max(0, Math.sin(t * 5.2)) * 0.28 : Math.max(0, Math.sin(t * 4.4 + i * 2)) * 0.14;
        if (i === 0) k.starTime = 0;
        a.pop = Math.min(1, a.pop + d * 2);
        a.v.update(k, { x: a.x, y: a.y + hop, z: a.z, yaw: k.yaw }, d, { lookBack: false, throttle: false, time: t });
        a.v.root.scale.setScalar(Math.max(0.01, easeOutBack(clamp(a.pop * 1.4 - i * 0.2, 0, 1))));
      });
      beams.forEach((b, i) => { b.rotation.z = Math.sin(t * 0.6 + i * 1.7) * 0.35; b.rotation.x = Math.sin(t * 0.45 + i) * 0.2; });
      updateConfetti(d, t);
      updateFireworks(d);
    }
    // camera: gentle sway, framing adapts to narrow screens
    const [cx, cy, cz, tx, ty, tz, fov] = baseCam[mode];
    const narrow = aspect < 1.2 ? (1.2 / Math.max(0.45, aspect)) : 1;
    camera.fov = fov! * Math.min(1.7, 0.75 + 0.25 * narrow);
    const sway = mode === 'garage' ? 0.15 : 0.5;
    let dist = cz! * (narrow > 1 ? Math.min(1.35, 0.85 + 0.15 * narrow) : 1);
    // Podium on portrait / narrow screens: pull back until 2nd and 3rd (x = ±3.1 plus kart width and
    // sway) stay in frame; the menu UI sits above and below the podium there.
    if (mode === 'podium' && narrow > 1) dist = Math.max(dist, 4.7 / Math.max(0.05, Math.tan(camera.fov * Math.PI / 360) * aspect));
    camera.position.set(cx! + Math.sin(t * 0.21) * sway, cy! + Math.sin(t * 0.33) * sway * 0.2, dist);
    camera.lookAt(tx!, ty!, tz!);
    camera.updateProjectionMatrix();
    void time;
  };

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
  const updateConfetti = (d: number, t: number) => {
    if (!confetti) return;
    for (let i = 0; i < confettiState.length; i++) {
      const c = confettiState[i]!;
      c.y -= c.vy * d;
      if (c.y < 0.02) { c.y = 12 + Math.random() * 3; c.x = (Math.random() - 0.5) * 16; }
      c.rx += c.spin * d; c.ry += c.spin * 0.7 * d;
      _e.set(c.rx, c.ry, 0);
      _q.setFromEuler(_e);
      _m.compose(_p.set(c.x + Math.sin(t * 1.3 + c.ph) * 0.4, c.y, c.z + Math.cos(t * 1.1 + c.ph) * 0.3), _q, _s);
      confetti.setMatrixAt(i, _m);
    }
    confetti.instanceMatrix.needsUpdate = true;
  };
  const _c = new THREE.Color();
  const updateFireworks = (d: number) => {
    if (!fireworks) return;
    fwNext -= d;
    if (fwNext <= 0) {
      fwNext = 0.7 + Math.random() * 0.8;
      const cx = (Math.random() - 0.5) * 16, cy = 4.6 + Math.random() * 2.8, cz = -5 - Math.random() * 4;
      _c.setHSL(Math.random(), 1, 0.5);
      let spawned = 0;
      for (const p of fwP) {
        if (p.life > 0) continue;
        const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
        const sp = 5 + Math.random() * 1.5;
        p.x = cx; p.y = cy; p.z = cz;
        p.vx = Math.cos(a) * s * sp; p.vy = u * sp; p.vz = Math.sin(a) * s * sp;
        p.max = p.life = 1.1 + Math.random() * 0.5;
        p.r = _c.r; p.g = _c.g; p.b = _c.b; p.size = 0.32 + Math.random() * 0.22;
        if (++spawned >= 70) break;
      }
    }
    const g = fireworks.geometry;
    const pos = g.attributes.position!.array as Float32Array, col = g.attributes.color!.array as Float32Array, sz = g.attributes.psize!.array as Float32Array;
    for (let i = 0; i < fwP.length; i++) {
      const p = fwP[i]!;
      if (p.life > 0) {
        p.life -= d;
        p.vx *= 1 - d * 1.2; p.vy = p.vy * (1 - d * 1.2) - 2.2 * d; p.vz *= 1 - d * 1.2;
        p.x += p.vx * d; p.y += p.vy * d; p.z += p.vz * d;
      }
      const a = p.life > 0 ? Math.min(1, p.life / p.max * 1.6) * (0.7 + 0.3 * Math.sin(p.life * 40)) : 0;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      col[i * 4] = p.r; col[i * 4 + 1] = p.g; col[i * 4 + 2] = p.b; col[i * 4 + 3] = a;
      sz[i] = p.life > 0 ? p.size : 0;
    }
    g.attributes.position!.needsUpdate = true; g.attributes.color!.needsUpdate = true; g.attributes.psize!.needsUpdate = true;
  };

  return {
    scene, camera,
    show,
    update,
    setAspect(a: number) { aspect = a; camera.aspect = a; camera.updateProjectionMatrix(); },
    dispose() {
      for (const list of pool.values()) for (const v of list) v.dispose();
      pool.clear(); inUse.clear(); actors = [];
      for (const o of titleProps) { o.removeFromParent(); (o.userData.release as (() => void) | undefined)?.(); }
      scene.traverse(o => {
        const m = o as THREE.Mesh;
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
        if (m.isMesh || (o as THREE.Points).isPoints) {
          if (m.geometry) m.geometry.dispose();
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mm of mats) {
            if (!mm) continue;
            if (mm.userData.ownMap) (mm as THREE.MeshBasicMaterial).map?.dispose();
            mm.dispose();
          }
        }
      });
      for (const x of disposables) x.dispose();
      // lights own GPU resources too (the key light's shadow-map render target)
      for (const l of [hemi, key, rimA, rimB]) l.dispose();
      scene.clear();
    },
  };
}
