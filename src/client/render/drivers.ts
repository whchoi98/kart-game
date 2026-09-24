/**
 * Procedural chibi drivers — 8 species with distinct silhouettes (big heads, glossy
 * cartoon eyes with highlights, blinking), rigged for state-driven animation:
 * torso lean, head look/turn, arms reaching a steering wheel, rabbit ears reacting
 * to speed, swishing tails, robot antenna lamp.
 *
 * Rig (all in the driver's local space, +Z forward, origin at the pelvis):
 *   root ─ torso (pivot at pelvis) ─┬─ head (pivot at neck) ─┬─ eyes (pivot at eye centre)
 *                                   │                        ├─ earL / earR (rabbit)
 *                                   │                        └─ lamp (robot)
 *                                   ├─ armL / armR (pivot at shoulders, +Z toward the hand)
 *                                   └─ tail (pivot at lower back)
 * Each part is ONE merged mesh (paint material, eyes use the unlit material).
 *
 * Level of detail: `buildDriverGeometries(ch, lod)` scales every tessellation (head shells, ellipsoids,
 * tubes, tails…) for the medium (×0.7) and low (×0.5) tiers and drops glints / rivets / tiny extras at low;
 * the high tier builds exactly the original geometry. Below high it also emits a shadow proxy (a head
 * ellipsoid + ears / muzzle, a torso lathe, arm boxes, a coarse tail — a few hundred triangles) and marks
 * the eyes unlit so they can share the paint draw (see kart-materials `markUnlit`).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { CharacterDef, Species } from '../../sim/types.js';
import {
  ATLAS, INK, ellipsoidPoint, luminance, markUnlit, merge, mixHex, orient, paint, revolve, shade, taperTube, xf,
} from './kart-materials.js';

// ───────────────────────────── geometry primitives ─────────────────────────────

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// ───────────────────────────── level of detail ─────────────────────────────

/** Tessellation tier of a driver build (the kart visual passes RenderQuality.level). */
export type DriverLod = 'high' | 'medium' | 'low';
const LOD_SEG: Record<DriverLod, number> = { high: 1, medium: 0.7, low: 0.5 };
/** Active build settings (set by buildDriverGeometries for the duration of one synchronous build). */
let segF = 1;
/** Keep tiny details (eye glints, goggle glints, rivets, buck tooth, nostrils, smile caps, thumbs). */
let tiny = true;
/** Also build the low-poly shadow proxy. */
let proxies = false;

/** Segment count for the active tier: unchanged at high, scaled below but never under min(min, n). */
const sg = (n: number, min: number) => (segF === 1 ? n : Math.max(Math.min(min, n), Math.round(n * segF)));

const S = (r: number, w = 12, h = 8) => new THREE.SphereGeometry(r, sg(w, 6), sg(h, 4));
const E = (rx: number, ry: number, rz: number, w = 14, h = 9) => new THREE.SphereGeometry(1, sg(w, 6), sg(h, 4)).scale(rx, ry, rz);
// low-sided cones / cylinders are shapes (4-sided fox ears, 3-sided cat ears, whiskers): only round ones scale
const CONE = (r: number, h: number, seg = 10) => new THREE.ConeGeometry(r, h, seg > 6 ? sg(seg, 6) : seg, 1);
const CYL = (r0: number, r1: number, h: number, seg = 10) => new THREE.CylinderGeometry(r1, r0, h, seg > 6 ? sg(seg, 6) : seg, 1);
const RBOX = (w: number, h: number, d: number, r: number, seg = 2) =>
  new RoundedBoxGeometry(w, h, d, segF === 1 ? seg : Math.max(1, Math.floor(seg * segF + 0.25)), r);
const TORUS = (r: number, t: number, radial: number, tubular: number, arc?: number) =>
  new THREE.TorusGeometry(r, t, sg(radial, 3), sg(tubular, 6), arc);
const CAPS = (r: number, len: number, cap: number, radial: number) => new THREE.CapsuleGeometry(r, len, sg(cap, 2), sg(radial, 5));
const DISC = (r: number, seg: number) => new THREE.CircleGeometry(r, sg(seg, 8));
const TUBE = (curve: THREE.Curve<THREE.Vector3>, tubular: number, r: number, radial: number, closed: boolean) =>
  new THREE.TubeGeometry(curve, sg(tubular, 6), r, sg(radial, 4), closed);
const TAPER = (pts: THREE.Vector3[], radius: (t: number) => number, tubular: number, radial: number) =>
  taperTube(pts, radius, sg(tubular, 8), sg(radial, 5));

// shadow-proxy primitives (fixed, coarse tessellation; only built when `proxies`)
const PELL = (cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, w = 6, h = 4) =>
  new THREE.SphereGeometry(1, w, h).scale(rx, ry, rz).translate(cx, cy, cz);
const PBOX = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

/** Cartoon eye (built in eye space: +Z out of the face). */
type EyeStyle = 'bead' | 'sclera' | 'cat' | 'visor';

function eyeParts(style: EyeStyle, ew: number, eh: number, ed: number, iris: string, glow: string): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const hi = '#ffffff';
  if (style === 'bead') {
    out.push(paint(E(ew, eh, ed, 12, 8), INK));
    out.push(paint(S(ew * 0.34, 8, 6).translate(-ew * 0.28, eh * 0.36, ed * 0.8), hi));
    if (tiny) out.push(paint(S(ew * 0.16, 6, 4).translate(ew * 0.32, -eh * 0.38, ed * 0.85), hi));
  } else if (style === 'sclera' || style === 'cat') {
    out.push(paint(E(ew, eh, ed, 12, 8), '#fbfbff'));
    const cat = style === 'cat';
    out.push(paint(E(ew * 0.66, eh * 0.72, ed * 0.5, 10, 7).translate(0, -eh * 0.06, ed * 0.62), cat ? iris : INK));
    if (cat) out.push(paint(E(ew * 0.16, eh * 0.56, ed * 0.3, 10, 8).translate(0, -eh * 0.06, ed * 0.95), INK));
    out.push(paint(S(ew * 0.26, 8, 6).translate(-ew * 0.22, eh * 0.24, ed * 1.02), hi));
    if (tiny) out.push(paint(S(ew * 0.12, 6, 4).translate(ew * 0.22, -eh * 0.3, ed * 1.02), hi));
  } else {
    // visor bar (robot)
    out.push(paint(RBOX(ew * 2, eh * 2, ed, Math.min(ew, eh) * 0.9, 2), glow));
    out.push(paint(RBOX(ew * 1.2, eh * 0.5, ed * 0.6, eh * 0.24, 1).translate(-ew * 0.2, eh * 0.45, ed * 0.35), mixHex(glow, '#ffffff', 0.7)));
  }
  return out;
}

// ───────────────────────────── specs ─────────────────────────────

export interface DriverGeometries {
  species: Species;
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  eyes: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;       // shared by both arms (built along +Z, length armLength)
  earL: THREE.BufferGeometry | null;
  earR: THREE.BufferGeometry | null;
  tail: THREE.BufferGeometry | null;
  lamp: THREE.BufferGeometry | null;
  neck: THREE.Vector3;             // torso-local
  eyeCenter: THREE.Vector3;        // head-local
  shoulderL: THREE.Vector3;        // torso-local (+X = driver's left)
  shoulderR: THREE.Vector3;
  earPivotL: THREE.Vector3 | null; // head-local
  earPivotR: THREE.Vector3 | null;
  tailPivot: THREE.Vector3 | null; // torso-local
  lampPivot: THREE.Vector3 | null; // head-local
  armLength: number;
  /** Head centre height above the pelvis (for camera focus). */
  headTop: number;
  /** The eyes are marked unlit (markUnlit) and drawn with the paint material (lower tiers). */
  eyesPainted: boolean;
  /** Shadow-only stand-ins in each part's local space (lower tiers; null at high). */
  shadow: DriverShadowProxy | null;
}

/** Low-poly shadow casters for the driver parts (see rigid-merge ShadowProxyPart). */
export interface DriverShadowProxy {
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  /** Shared by both arms. */
  arm: THREE.BufferGeometry;
  earL: THREE.BufferGeometry | null;
  earR: THREE.BufferGeometry | null;
  tail: THREE.BufferGeometry | null;
}

interface Pal { body: string; accent: string; fur: string; detail: string; suit: string; trim: string; glove: string }

function palette(ch: CharacterDef): Pal {
  const c = ch.colors;
  const suit = luminance(c.accent) > 0.85 ? mixHex(c.accent, c.body, 0.35) : c.accent;
  return { ...c, suit, trim: c.body, glove: '#fbfbf7' };
}

/** Head ellipsoid helper. */
class Head {
  constructor(readonly cx: number, readonly cy: number, readonly cz: number, readonly rx: number, readonly ry: number, readonly rz: number) {}
  at(az: number, el: number, lift = 0) { return ellipsoidPoint(this.cx, this.cy, this.cz, this.rx, this.ry, this.rz, az, el, lift); }
  /** Place a geometry (its +Z along the surface normal) on the head. */
  put(g: THREE.BufferGeometry, az: number, el: number, lift = 0, twist = 0): THREE.BufferGeometry {
    const { p, n } = this.at(az, el, lift);
    return orient(g, p, n, twist);
  }
  shell(color: string, rough = 0.62, w = 22, h = 14): THREE.BufferGeometry {
    return paint(E(this.rx, this.ry, this.rz, w, h).translate(this.cx, this.cy, this.cz), color, { rough });
  }
  /** Coarse ellipsoid of the head for the shadow proxy. */
  proxy(): THREE.BufferGeometry {
    return PELL(this.cx, this.cy, this.cz, this.rx, this.ry, this.rz, 8, 5);
  }
}

interface HeadOut {
  head: THREE.BufferGeometry[];
  eyes: THREE.BufferGeometry[];
  eyeY: number; eyeZ: number;
  earL?: THREE.BufferGeometry[]; earR?: THREE.BufferGeometry[];
  earPivotL?: THREE.Vector3; earPivotR?: THREE.Vector3;
  lamp?: THREE.BufferGeometry[]; lampPivot?: THREE.Vector3;
  torsoExtra?: THREE.BufferGeometry[];
  tail?: THREE.BufferGeometry[]; tailPivot?: THREE.Vector3;
  headTop: number;
  /** Shadow proxy pieces (only when `proxies`): head-local, and for the separately animated ears / tail. */
  proxy?: THREE.BufferGeometry[];
  earProxyL?: THREE.BufferGeometry; earProxyR?: THREE.BufferGeometry;
  tailProxy?: THREE.BufferGeometry;
}

const BLUSH = '#ff8fb1';

function addEyes(h: Head, out: HeadOut, style: EyeStyle, az: number, el: number, ew: number, eh: number, ed: number, iris = INK, glow = '#00e5ff', sink = 0.4): void {
  let ey = 0, ez = 0;
  for (const side of [1, -1]) {
    const g = merge(eyeParts(style, ew, eh, ed, iris, glow));
    const { p, n } = h.at(side * az, el, -ed * sink);
    orient(g, p, n);
    out.eyes.push(g);
    ey = p.y; ez = p.z;
  }
  out.eyeY = ey; out.eyeZ = ez;
}

/** Smile drawn as a tube hugging the surface: arc of half-width r (m) centred at (az, el). */
function smile(h: Head, az: number, el: number, r: number, color = INK, lift = 0.004, depth = 0.45): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  const span = r / Math.max(0.05, h.rx);
  const elSpan = r / Math.max(0.05, h.ry);
  for (let i = 0; i <= 8; i++) {
    const u = i / 8 * 2 - 1;
    pts.push(h.at(az + u * span, el - (1 - u * u) * elSpan * depth, lift + 0.004).p);
  }
  const g = TUBE(new THREE.CatmullRomCurve3(pts), 12, Math.max(0.007, r * 0.13), 5, false);
  const caps = tiny ? [pts[0]!, pts[pts.length - 1]!].map(p => S(Math.max(0.007, r * 0.13), 6, 4).translate(p.x, p.y, p.z)) : [];
  return merge([paint(g, color, { rough: 0.5 }), ...caps.map(c => paint(c, color, { rough: 0.5 }))]);
}

function wMouth(h: Head, el: number, r: number, lift = 0.002): THREE.BufferGeometry[] {
  return [-1, 1].map(s => smile(h, s * r / h.rx, el, r, INK, lift, 0.9));
}

function blush(h: Head, az: number, el: number, r = 0.055): THREE.BufferGeometry[] {
  return [1, -1].map(s => paint(h.put(E(r, r * 0.62, 0.012, 12, 5), s * az, el, -0.002), BLUSH, { rough: 0.8 }));
}

function brows(h: Head, az: number, el: number, color: string, tilt: number, len = 0.05): THREE.BufferGeometry[] {
  return [1, -1].map(s => {
    const g = CAPS(0.013, len, 3, 6).rotateZ(Math.PI / 2 + s * tilt);
    return paint(h.put(g, s * az, el, 0.006), color, { rough: 0.6 });
  });
}

/**
 * Band around the head (headband / goggle strap): a closed tube lying ON the ellipsoid along a
 * plane through height `y` tilted forward by `tiltX` (front lower than back when tiltX > 0).
 */
function band(h: Head, y: number, color: string, tube = 0.03, tiltX = 0.18): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 40; i++) pts.push(bandPoint(h, y, tiltX, (i / 40) * Math.PI * 2, tube * 0.45));
  const g = TUBE(new THREE.CatmullRomCurve3(pts, true), 32, tube, 5, true);
  return paint(g, color, { rough: 0.55 });
}

/**
 * Point of a `band()` path at angle `a` around the head (0 = front, π = back), lifted `lift`
 * along the surface normal. The band plane passes through height `y` above the head centre
 * axis and rises toward the front by tan(tiltX) per metre.
 */
function bandPoint(h: Head, y: number, tiltX: number, a: number, lift: number): THREE.Vector3 {
  const n = new THREE.Vector3(0, Math.cos(tiltX), -Math.sin(tiltX));   // plane normal
  const ax = new THREE.Vector3(1, 0, 0);
  const az = new THREE.Vector3().crossVectors(ax, n).normalize();      // forward axis in the plane
  const o = new THREE.Vector3(0, y - h.cy, 0);
  const inv = new THREE.Vector3(1 / h.rx, 1 / h.ry, 1 / h.rz);
  const u = ax.clone().multiplyScalar(Math.sin(a)).addScaledVector(az, Math.cos(a));
  // solve |(o + u r) * inv| = 1 for r > 0
  const ou = o.clone().multiply(inv), uu = u.clone().multiply(inv);
  const A = uu.dot(uu), B = 2 * ou.dot(uu), C = ou.dot(ou) - 1;
  const r = (-B + Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
  const p = o.clone().addScaledVector(u, r);
  const nn = p.clone().multiply(inv).multiply(inv).normalize();
  return p.addScaledVector(nn, lift).add(new THREE.Vector3(h.cx, h.cy, h.cz));
}

// ───────────────────────────── species heads ─────────────────────────────

function penguinHead(p: Pal): HeadOut {
  const h = new Head(0, 0.29, 0.02, 0.34, 0.31, 0.32);
  const out: HeadOut = { head: [h.shell(p.fur, 0.5)], eyes: [], eyeY: 0, eyeZ: 0, headTop: 0.62 };
  const white = '#f7f8fc';
  // heart-shaped white face
  out.head.push(paint(E(0.2, 0.22, 0.2, 16, 10).translate(0.085, 0.29, 0.16), white, { rough: 0.55 }));
  out.head.push(paint(E(0.2, 0.22, 0.2, 16, 10).translate(-0.085, 0.29, 0.16), white, { rough: 0.55 }));
  out.head.push(paint(E(0.2, 0.15, 0.19, 20, 12).translate(0, 0.19, 0.17), white, { rough: 0.55 }));
  const face = new Head(0, 0.26, 0.17, 0.25, 0.24, 0.2);
  addEyes(face, out, 'bead', 0.42, 0.18, 0.06, 0.075, 0.035);
  // beak
  out.head.push(paint(E(0.085, 0.048, 0.13, 16, 10).translate(0, 0.215, 0.36), p.detail, { rough: 0.35 }));
  out.head.push(paint(E(0.068, 0.03, 0.09, 14, 8).translate(0, 0.17, 0.34), shade(p.detail, -0.12), { rough: 0.4 }));
  out.head.push(...blush(face, 0.72, -0.12, 0.045));
  // goggles on the forehead
  out.head.push(band(h, 0.47, p.accent, 0.028, 0.35));
  for (const s of [1, -1]) {
    const { p: gp, n } = h.at(s * 0.3, 0.72, 0.02);
    out.head.push(paint(orient(TORUS(0.068, 0.02, 5, 14), gp, n), '#e8eef7', { rough: 0.2, metal: 0.9 }));
    out.head.push(paint(orient(DISC(0.066, 14), gp.clone().addScaledVector(n, 0.005), n), '#9fdcff', { rough: 0.08 }));
    if (tiny) out.head.push(paint(orient(E(0.03, 0.018, 0.004, 8, 6), gp.clone().addScaledVector(n, 0.012).add(V(-0.015 * s, 0.02, 0)), n), '#ffffff', { rough: 0.05 }));
  }
  // feather tuft
  for (const [x, a, l] of [[-0.04, 0.35, 0.12], [0, 0, 0.15], [0.04, -0.35, 0.12]] as const) {
    out.head.push(paint(xf(E(0.026, l, 0.03, 8, 8), x, 0.6 + l * 0.6, -0.03, -0.35, 0, a), p.fur, { rough: 0.5 }));
  }
  // scarf (accent) with a tail flapping behind
  const scarf = TORUS(0.16, 0.05, 6, 18).rotateX(Math.PI / 2).scale(1, 1, 0.9);
  out.torsoExtra = [paint(scarf.translate(0, 0.43, 0), p.accent, { rough: 0.8 })];
  out.torsoExtra.push(paint(xf(RBOX(0.1, 0.24, 0.035, 0.016, 1), 0.06, 0.34, -0.2, 0.5, 0.25, 0.25), p.accent, { rough: 0.8 }));
  out.torsoExtra.push(paint(xf(RBOX(0.09, 0.2, 0.035, 0.016, 1), -0.02, 0.3, -0.21, 0.6, -0.2, -0.3), shade(p.accent, -0.1), { rough: 0.8 }));
  if (proxies) out.proxy = [h.proxy(), PELL(0, 0.215, 0.36, 0.085, 0.048, 0.13)];
  return out;
}

function bearHead(p: Pal): HeadOut {
  const h = new Head(0, 0.29, 0.02, 0.35, 0.31, 0.32);
  const light = mixHex(p.fur, '#ffffff', 0.45);
  const out: HeadOut = { head: [h.shell(p.fur, 0.75)], eyes: [], eyeY: 0, eyeZ: 0, headTop: 0.66 };
  if (proxies) out.proxy = [h.proxy()];
  // round ears: one cupped disc per side (inner pad on the ear's own front face), seated on the
  // upper sides of the head above the headband and turned slightly forward.
  for (const s of [1, -1]) {
    const { p: ep, n } = h.at(s * 0.98, 0.98, -0.035);
    const ear = merge([
      paint(E(0.125, 0.125, 0.07, 16, 10), p.fur, { rough: 0.75 }),
      paint(E(0.075, 0.075, 0.03, 14, 8).translate(0, -0.008, 0.05), light, { rough: 0.8 }),
    ]);
    const dir = n.clone().lerp(V(0, 0, 1), 0.45).normalize();
    out.head.push(orient(ear, ep, dir));
    out.proxy?.push(orient(PELL(0, 0, 0, 0.125, 0.125, 0.07), ep, dir));
  }
  // snout
  const sn = h.at(0, -0.3, -0.06).p;
  out.proxy?.push(PELL(sn.x, sn.y, sn.z, 0.16, 0.12, 0.12));
  out.head.push(paint(E(0.16, 0.12, 0.12, 16, 10).translate(sn.x, sn.y, sn.z), light, { rough: 0.7 }));
  const snout = new Head(sn.x, sn.y, sn.z, 0.16, 0.12, 0.12);
  out.head.push(paint(snout.put(E(0.058, 0.042, 0.04, 12, 8), 0, 0.42, -0.012), p.detail, { rough: 0.25 }));
  if (tiny) out.head.push(paint(snout.put(E(0.02, 0.012, 0.004, 8, 6), -0.12, 0.58, 0.024), '#ffffff', { rough: 0.1 }));
  out.head.push(smile(snout, 0, -0.18, 0.04, p.detail));
  addEyes(h, out, 'bead', 0.3, 0.12, 0.055, 0.068, 0.03);
  out.head.push(...brows(h, 0.31, 0.36, p.detail, -0.28, 0.06));
  out.head.push(...blush(h, 0.62, -0.1));
  // headband with a knot sitting on the band at the back of the head
  const bandY = 0.41, bandTilt = 0.26;
  out.head.push(band(h, bandY, p.accent, 0.034, bandTilt));
  const kn = bandPoint(h, bandY, bandTilt, Math.PI, 0.03);
  out.head.push(paint(S(0.045, 10, 8).translate(kn.x, kn.y, kn.z), p.accent, { rough: 0.6 }));
  for (const s of [1, -1]) {
    out.head.push(paint(xf(RBOX(0.05, 0.16, 0.025, 0.012), kn.x + s * 0.05, kn.y - 0.08, kn.z - 0.02, 0.3, 0, s * 0.45), p.accent, { rough: 0.7 }));
  }
  return out;
}

function rabbitHead(p: Pal): HeadOut {
  const h = new Head(0, 0.28, 0.02, 0.33, 0.3, 0.31);
  const out: HeadOut = { head: [h.shell(p.fur, 0.8)], eyes: [], eyeY: 0, eyeZ: 0, headTop: 1.05 };
  addEyes(h, out, 'bead', 0.33, 0.08, 0.066, 0.085, 0.034);
  out.head.push(...blush(h, 0.6, -0.14, 0.06));
  // nose + w mouth + buck tooth
  out.head.push(paint(h.put(E(0.034, 0.024, 0.02, 10, 8), 0, -0.14, 0.004), p.detail, { rough: 0.3 }));
  out.head.push(...wMouth(h, -0.3, 0.024));
  if (tiny) out.head.push(paint(h.put(RBOX(0.036, 0.04, 0.015, 0.006, 1), 0, -0.41, -0.002), '#ffffff', { rough: 0.3 }));
  // cheek fluff
  for (const s of [1, -1]) out.head.push(paint(h.put(E(0.09, 0.07, 0.05, 12, 8), s * 0.75, -0.42, -0.03), p.fur, { rough: 0.85 }));
  // floppy ears (separate, animated). Built from their pivot upward, bent back at the top.
  const bender = (s: number) => (g: THREE.BufferGeometry) => {
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y > 0.2) { const k = y - 0.2; pos.setZ(i, pos.getZ(i) - k * k * 1.6); pos.setX(i, pos.getX(i) + s * k * k * 0.5); }
    }
    g.computeVertexNormals();
    return g;
  };
  const earParts = (s: number) => {
    const outer = CAPS(0.078, 0.3, 5, 12).translate(0, 0.23, 0).scale(1, 1, 0.42);
    const inner = CAPS(0.046, 0.24, 4, 10).translate(0, 0.23, 0.024).scale(1, 1, 0.3);
    const bend = (g: THREE.BufferGeometry) => {
      const pos = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y > 0.2) { const k = y - 0.2; pos.setZ(i, pos.getZ(i) - k * k * 1.6); pos.setX(i, pos.getX(i) + s * k * k * 0.5); }
      }
      g.computeVertexNormals();
      return g;
    };
    return [paint(bend(outer), p.fur, { rough: 0.8 }), paint(bend(inner), mixHex(p.detail, '#ffffff', 0.35), { rough: 0.8 })];
  };
  out.earL = earParts(1); out.earR = earParts(-1);
  out.earPivotL = V(0.11, 0.54, -0.02); out.earPivotR = V(-0.11, 0.54, -0.02);
  if (proxies) {
    out.proxy = [h.proxy()];
    const ear = (s: number) => bender(s)(new THREE.BoxGeometry(0.12, 0.44, 0.05, 1, 4, 1).translate(0, 0.23, 0));
    out.earProxyL = ear(1); out.earProxyR = ear(-1);
    out.tailProxy = PELL(0, 0, 0, 0.09, 0.09, 0.09);
  }
  // bow between the ears (accent)
  out.head.push(paint(S(0.03, 10, 8).translate(0, 0.585, 0.08), p.detail, { rough: 0.5 }));
  for (const s of [1, -1]) out.head.push(paint(xf(CONE(0.05, 0.1, 10), s * 0.055, 0.585, 0.08, 0, 0, s * Math.PI / 2), p.detail, { rough: 0.5 }));
  // puffy tail
  out.tail = [paint(S(0.09, 12, 10), '#ffffff', { rough: 0.95 })];
  out.tailPivot = V(0, 0.1, -0.22);
  return out;
}

function dinoHead(p: Pal): HeadOut {
  const h = new Head(0, 0.3, 0.0, 0.33, 0.3, 0.31);
  const light = mixHex(p.fur, '#ffffff', 0.45);
  const out: HeadOut = { head: [h.shell(p.fur, 0.55)], eyes: [], eyeY: 0, eyeZ: 0, headTop: 0.72 };
  // big muzzle
  out.head.push(paint(E(0.26, 0.17, 0.2, 16, 10).translate(0, 0.19, 0.2), p.fur, { rough: 0.55 }));
  out.head.push(paint(E(0.23, 0.1, 0.17, 20, 10).translate(0, 0.13, 0.21), light, { rough: 0.6 }));
  const mz = new Head(0, 0.19, 0.2, 0.26, 0.17, 0.2);
  if (tiny) for (const s of [1, -1]) out.head.push(paint(mz.put(E(0.022, 0.014, 0.012, 8, 6), s * 0.2, 0.42, -0.004), p.detail, { rough: 0.4 }));
  out.head.push(smile(mz, 0, -0.18, 0.1, INK, 0.0, 0.5));
  for (const s of [1, -1]) out.head.push(paint(mz.put(CONE(0.018, 0.04, 6).rotateX(-Math.PI / 2), s * 0.36, -0.36, -0.01), '#ffffff', { rough: 0.3 }));
  // spots
  for (const [az, el, r] of [[0.9, 0.3, 0.04], [1.1, 0.05, 0.03], [-0.95, 0.35, 0.035], [-1.15, 0.1, 0.028], [2.4, 0.5, 0.04], [-2.5, 0.4, 0.035]] as const) {
    out.head.push(paint(h.put(E(r, r, 0.01, 10, 8), az, el, -0.001), p.detail, { rough: 0.6 }));
  }
  addEyes(h, out, 'sclera', 0.36, 0.32, 0.07, 0.08, 0.04, INK, '', 0.25);
  out.head.push(...brows(h, 0.38, 0.6, p.detail, -0.35, 0.06));
  // head spikes
  for (const [el, s] of [[1.05, 0.07], [1.35, 0.08], [1.7, 0.07]] as const) {
    const { p: sp, n } = h.at(0, el, -0.01);
    out.head.push(paint(orient(CONE(s * 0.8, s * 1.9, 8).rotateX(Math.PI / 2).translate(0, 0, s * 0.7), sp, n), p.accent, { rough: 0.45 }));
  }
  // back spikes on the torso
  out.torsoExtra = [];
  for (const [y, s] of [[0.36, 0.07], [0.22, 0.075], [0.08, 0.06]] as const) {
    out.torsoExtra.push(paint(xf(CONE(s * 0.8, s * 1.9, 8), 0, y, -0.2 - s * 0.4, -Math.PI / 2 - 0.35, 0, 0), p.accent, { rough: 0.45 }));
  }
  // chunky tail curling up over the rear
  const pts = [V(0, 0, 0), V(0, 0.2, -0.16), V(0, 0.4, -0.34), V(0, 0.46, -0.6), V(0, 0.58, -0.82)];
  const tail = [paint(TAPER(pts, t => 0.13 * (1 - t) + 0.02, 18, 10), p.fur, { rough: 0.55 })];
  const curve = new THREE.CatmullRomCurve3(pts);
  for (const t of [0.3, 0.52, 0.74]) {
    const cp = curve.getPointAt(t);
    const tan = curve.getTangentAt(t);
    const up = V(0, 1, 0).sub(tan.clone().multiplyScalar(tan.y)).normalize();
    const r = 0.13 * (1 - t) + 0.02;
    const s = 0.05 + (1 - t) * 0.03;
    tail.push(paint(orient(CONE(s * 0.8, s * 1.8, 8).rotateX(Math.PI / 2).translate(0, 0, r + s * 0.5), cp, up), p.accent, { rough: 0.45 }));
  }
  out.tail = tail;
  out.tailPivot = V(0, 0.1, -0.18);
  if (proxies) {
    out.proxy = [h.proxy(), PELL(0, 0.19, 0.2, 0.26, 0.17, 0.2)];
    out.tailProxy = taperTube(pts, t => 0.13 * (1 - t) + 0.02, 5, 5);
  }
  return out;
}

function foxHead(p: Pal): HeadOut {
  const h = new Head(0, 0.28, 0.02, 0.34, 0.29, 0.31);
  const cream = p.detail;
  const out: HeadOut = { head: [h.shell(p.fur, 0.7)], eyes: [], eyeY: 0, eyeZ: 0, headTop: 0.86 };
  // white cheeks + muzzle
  for (const s of [1, -1]) out.head.push(paint(h.put(E(0.15, 0.11, 0.08, 16, 10), s * 0.52, -0.34, -0.03), cream, { rough: 0.8 }));
  out.head.push(paint(E(0.13, 0.095, 0.15, 14, 9).translate(0, 0.17, 0.26), cream, { rough: 0.75 }));
  out.head.push(paint(E(0.04, 0.03, 0.03, 10, 8).translate(0, 0.2, 0.405), INK, { rough: 0.2 }));
  if (tiny) out.head.push(paint(E(0.012, 0.008, 0.004, 6, 4).translate(-0.012, 0.215, 0.432), '#ffffff', { rough: 0.1 }));
  const mz = new Head(0, 0.17, 0.26, 0.13, 0.095, 0.15);
  out.head.push(smile(mz, 0, -0.35, 0.03));
  // pointy ears
  for (const s of [1, -1]) {
    const ear = paint(xf(CONE(0.13, 0.3, 4).rotateY(Math.PI / 4).scale(1, 1, 0.45), 0, 0.15, 0), p.fur, { rough: 0.7 });
    const inner = paint(xf(CONE(0.07, 0.17, 4).rotateY(Math.PI / 4).scale(1, 1, 0.3), 0, 0.1, 0.03), cream, { rough: 0.8 });
    const tip = paint(xf(CONE(0.05, 0.1, 4).rotateY(Math.PI / 4).scale(1, 1, 0.52), 0, 0.26, 0.002), p.accent, { rough: 0.7 });
    const g = merge([ear, inner, tip]);
    xf(g, s * 0.2, 0.5, -0.02, -0.12, 0, -s * 0.36);
    out.head.push(g);
    if (proxies) (out.proxy ??= [h.proxy(), PELL(0, 0.17, 0.26, 0.13, 0.095, 0.15)])
      .push(xf(xf(new THREE.ConeGeometry(0.13, 0.3, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 0.45), 0, 0.15, 0), s * 0.2, 0.5, -0.02, -0.12, 0, -s * 0.36));
  }
  addEyes(h, out, 'bead', 0.34, 0.14, 0.064, 0.056, 0.03);
  out.head.push(...brows(h, 0.37, 0.36, INK, 0.3, 0.05));
  out.head.push(...blush(h, 0.64, -0.08, 0.045));
  // bushy tail with a white tip
  const pts = [V(0, 0, 0), V(0.08, 0.16, -0.16), V(0.2, 0.38, -0.3), V(0.28, 0.62, -0.28), V(0.26, 0.82, -0.12)];
  const foxTail = (t: number) => 0.055 + 0.15 * Math.sin(Math.PI * Math.min(1, t * 1.08)) + 0.01;
  out.tail = [paint(TAPER(pts, foxTail, 20, 10), p.fur, {
    rough: 0.85, colorFn: (_u, v) => (v > 0.76 ? cream : null),
  })];
  out.tailPivot = V(0, 0.1, -0.2);
  if (proxies) out.tailProxy = taperTube(pts, foxTail, 5, 5);
  return out;
}

function raccoonHead(p: Pal): HeadOut {
  const h = new Head(0, 0.28, 0.02, 0.35, 0.3, 0.31);
  const white = '#f4f4f7';
  const out: HeadOut = { head: [h.shell(p.fur, 0.75)], eyes: [], eyeY: 0, eyeZ: 0, headTop: 0.72 };
  // ears
  for (const s of [1, -1]) {
    const ear = paint(xf(E(0.1, 0.13, 0.05, 10, 7), 0, 0.08, 0), p.fur, { rough: 0.75 });
    const inner = paint(xf(E(0.058, 0.08, 0.02, 8, 6), 0, 0.07, 0.035), p.detail, { rough: 0.8 });
    const g = merge([ear, inner]);
    xf(g, s * 0.22, 0.5, -0.01, -0.1, 0, -s * 0.5);
    out.head.push(g);
    if (proxies) (out.proxy ??= [h.proxy(), PELL(0, 0.16, 0.25, 0.14, 0.1, 0.12)])
      .push(xf(PELL(0, 0.08, 0, 0.1, 0.13, 0.05), s * 0.22, 0.5, -0.01, -0.1, 0, -s * 0.5));
  }
  // white face + muzzle, dark mask band
  out.head.push(paint(h.put(E(0.2, 0.15, 0.08, 14, 9), 0, -0.2, -0.045), white, { rough: 0.8 }));
  out.head.push(paint(E(0.14, 0.1, 0.12, 14, 9).translate(0, 0.16, 0.25), white, { rough: 0.75 }));
  out.head.push(paint(E(0.045, 0.034, 0.03, 10, 8).translate(0, 0.205, 0.365), p.detail, { rough: 0.2 }));
  const mz = new Head(0, 0.16, 0.25, 0.14, 0.1, 0.12);
  out.head.push(smile(mz, 0, -0.4, 0.035, p.detail));
  // bandit mask: thin patches (protrude ~1 cm) so the eyes sit proud of them instead of sinking in
  for (const s of [1, -1]) out.head.push(paint(h.put(E(0.135, 0.095, 0.034, 14, 9), s * 0.33, 0.1, -0.021, s * -0.2), p.detail, { rough: 0.6 }));
  out.head.push(paint(h.put(E(0.08, 0.04, 0.03, 12, 8), 0, 0.12, -0.018), p.detail, { rough: 0.6 }));
  out.head.push(paint(h.put(E(0.1, 0.035, 0.02, 12, 8), 0, 0.4, -0.004), white, { rough: 0.8 }));
  addEyes(h, out, 'sclera', 0.33, 0.1, 0.06, 0.066, 0.03, INK, '', -0.15);
  out.head.push(band(h, 0.48, p.accent, 0.03, 0.3));
  // ringed tail
  const pts = [V(0, 0, 0), V(-0.08, 0.18, -0.16), V(-0.2, 0.4, -0.28), V(-0.26, 0.62, -0.22), V(-0.24, 0.78, -0.06)];
  const ringTail = (t: number) => 0.06 + 0.09 * Math.sin(Math.PI * Math.min(1, t * 1.05)) + 0.02;
  out.tail = [paint(TAPER(pts, ringTail, 22, 10), p.fur, {
    rough: 0.85, colorFn: (_u, v) => (v > 0.12 && Math.floor(v * 7) % 2 === 1 ? p.detail : null),
  })];
  out.tailPivot = V(0, 0.1, -0.2);
  if (proxies) out.tailProxy = taperTube(pts, ringTail, 5, 5);
  return out;
}

function catHead(p: Pal): HeadOut {
  const h = new Head(0, 0.28, 0.02, 0.35, 0.3, 0.31);
  const pink = '#ffb3c7';
  const out: HeadOut = { head: [h.shell(p.fur, 0.75)], eyes: [], eyeY: 0, eyeZ: 0, headTop: 0.8 };
  // triangle ears (right one in the patch colour)
  for (const s of [1, -1]) {
    const c = s < 0 ? p.detail : p.fur;
    const ear = paint(xf(CONE(0.12, 0.22, 3).rotateY(Math.PI).scale(1, 1, 0.55), 0, 0.1, 0), c, { rough: 0.75 });
    const inner = paint(xf(CONE(0.07, 0.14, 3).rotateY(Math.PI).scale(1, 1, 0.3), 0, 0.08, 0.035), pink, { rough: 0.8 });
    const g = merge([ear, inner]);
    xf(g, s * 0.2, 0.5, 0.0, -0.1, 0, -s * 0.3);
    out.head.push(g);
    if (proxies) (out.proxy ??= [h.proxy()])
      .push(xf(xf(new THREE.ConeGeometry(0.12, 0.22, 3, 1).rotateY(Math.PI).scale(1, 1, 0.55), 0, 0.1, 0), s * 0.2, 0.5, 0.0, -0.1, 0, -s * 0.3));
  }
  // patch over the right eye / forehead
  out.head.push(paint(h.put(E(0.15, 0.13, 0.04, 16, 10), -0.55, 0.45, -0.025), p.detail, { rough: 0.75 }));
  // muzzle puff + nose + w-mouth + whiskers
  // muzzle puffs are kept shallow so the ω mouth drawn over them stays visible
  for (const s of [1, -1]) out.head.push(paint(h.put(E(0.07, 0.055, 0.032, 12, 8), s * 0.14, -0.3, -0.017), '#ffffff', { rough: 0.8 }));
  out.head.push(paint(h.put(E(0.03, 0.02, 0.02, 10, 6), 0, -0.14, 0.012), '#ff7aa0', { rough: 0.3 }));
  out.head.push(...wMouth(h, -0.27, 0.022, 0.011));
  for (const s of [1, -1]) {
    for (const [dy, a] of [[0.0, 0.08], [-0.035, -0.12]] as const) {
      const { p: wp } = h.at(s * 0.42, -0.25 + dy, -0.01);
      const g = CYL(0.004, 0.004, 0.2, 4).rotateZ(Math.PI / 2 + s * a).translate(s * 0.09, 0, 0);
      out.head.push(paint(g.translate(wp.x, wp.y, wp.z + 0.02), INK, { rough: 0.5 }));
    }
  }
  addEyes(h, out, 'cat', 0.33, 0.1, 0.064, 0.074, 0.034, '#2bb673', '', 0.25);
  out.head.push(...blush(h, 0.63, -0.14, 0.05));
  // bow on the left ear
  const bw = V(0.28, 0.62, 0.04);
  out.head.push(paint(S(0.03, 10, 8).translate(bw.x, bw.y, bw.z), p.accent, { rough: 0.45 }));
  for (const s of [1, -1]) out.head.push(paint(xf(CONE(0.05, 0.1, 12), bw.x + s * 0.05, bw.y + s * 0.012, bw.z, 0, 0, s * Math.PI / 2 + 0.25), p.accent, { rough: 0.45 }));
  // slender curling tail
  const pts = [V(0, 0, 0), V(0.05, 0.14, -0.12), V(0.12, 0.34, -0.2), V(0.16, 0.52, -0.14), V(0.12, 0.62, -0.02), V(0.05, 0.6, 0.03)];
  out.tail = [paint(TAPER(pts, t => 0.05 - t * 0.012, 24, 8), p.fur, { rough: 0.8, colorFn: (_u, v) => (v > 0.72 ? p.detail : null) })];
  out.tailPivot = V(0, 0.1, -0.2);
  if (proxies) out.tailProxy = taperTube(pts, t => 0.05 - t * 0.012, 5, 4);
  return out;
}

function robotHead(p: Pal): HeadOut {
  const metal = p.fur;
  const out: HeadOut = { head: [], eyes: [], eyeY: 0, eyeZ: 0, headTop: 0.95 };
  out.head.push(paint(RBOX(0.62, 0.5, 0.52, 0.14, 3).translate(0, 0.28, 0.02), metal, { rough: 0.3, metal: 0.55 }));
  // brow plate + visor
  out.head.push(paint(RBOX(0.5, 0.25, 0.1, 0.07, 2).translate(0, 0.3, 0.25), INK, { rough: 0.12, metal: 0.2 }));
  // visor eyes (unlit glow)
  for (const s of [1, -1]) {
    const g = merge(eyeParts('visor', 0.055, 0.042, 0.02, INK, p.accent));
    out.eyes.push(g.translate(s * 0.11, 0.305, 0.305));
  }
  out.eyeY = 0.305; out.eyeZ = 0.305;
  // grille mouth
  for (const y of [0.13, 0.1]) out.head.push(paint(RBOX(0.16, 0.014, 0.02, 0.006, 1).translate(0, y, 0.285), shade(metal, -0.45), { rough: 0.4, metal: 0.4 }));
  // cheek lights
  for (const s of [1, -1]) out.head.push(paint(CYL(0.022, 0.022, 0.01, 12).rotateX(Math.PI / 2).translate(s * 0.2, 0.13, 0.284), p.detail, { rough: 0.3 }));
  // ear pods with bolts
  for (const s of [1, -1]) {
    out.head.push(paint(CYL(0.08, 0.08, 0.07, 16).rotateZ(Math.PI / 2).translate(s * 0.33, 0.28, 0.02), p.accent, { rough: 0.35, metal: 0.2 }));
    out.head.push(paint(CYL(0.035, 0.035, 0.03, 8).rotateZ(Math.PI / 2).translate(s * 0.375, 0.28, 0.02), '#e9eef3', { rough: 0.2, metal: 1 }));
  }
  // top panel line + rivets
  if (tiny) {
    out.head.push(paint(RBOX(0.4, 0.02, 0.36, 0.01, 1).translate(0, 0.53, 0.0), shade(metal, -0.2), { rough: 0.4, metal: 0.5 }));
    for (const [x, z] of [[-0.24, 0.2], [0.24, 0.2], [-0.24, -0.16], [0.24, -0.16]] as const) {
      out.head.push(paint(S(0.018, 8, 6).translate(x, 0.53, z), '#eef2f6', { rough: 0.2, metal: 1 }));
    }
  }
  // antenna
  out.head.push(paint(CYL(0.014, 0.014, 0.22, 8).translate(0, 0.64, -0.02), '#dfe6ec', { rough: 0.2, metal: 1 }));
  out.head.push(paint(CYL(0.05, 0.06, 0.03, 12).translate(0, 0.54, -0.02), shade(metal, -0.3), { rough: 0.3, metal: 0.6 }));
  out.lamp = [paint(S(0.05, 12, 8), '#ffffff', { rough: 0.2 })];
  out.lampPivot = V(0, 0.77, -0.02);
  // rounded box (r 0.14) as the union of three boxes inset by r on two axes each (all inside it), + ear pods, antenna
  if (proxies) out.proxy = [PBOX(0.62, 0.22, 0.24, 0, 0.28, 0.02), PBOX(0.34, 0.5, 0.24, 0, 0.28, 0.02), PBOX(0.34, 0.22, 0.52, 0, 0.28, 0.02),
    PBOX(0.74, 0.12, 0.12, 0, 0.28, 0.02), PBOX(0.024, 0.22, 0.024, 0, 0.645, -0.02)];
  return out;
}

const HEADS: Record<Species, (p: Pal) => HeadOut> = {
  penguin: penguinHead, bear: bearHead, rabbit: rabbitHead, dino: dinoHead,
  fox: foxHead, raccoon: raccoonHead, cat: catHead, robot: robotHead,
};

// ───────────────────────────── torso & arms ─────────────────────────────

const ARM_LEN = 0.36;

function decalDisc(r: number, rect: typeof ATLAS.plate, seg = 18): THREE.BufferGeometry {
  return paint(DISC(r, seg), '#ffffff', { rect, rough: 0.45 });
}

function torsoParts(ch: CharacterDef, p: Pal): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  if (ch.species === 'robot') {
    out.push(paint(RBOX(0.44, 0.4, 0.34, 0.1, 2).translate(0, 0.22, 0), p.fur, { rough: 0.3, metal: 0.55 }));
    out.push(paint(RBOX(0.26, 0.15, 0.04, 0.03, 1).translate(0, 0.25, 0.17), INK, { rough: 0.15 }));
    for (const [x, c] of [[-0.07, p.detail], [0, p.accent], [0.07, '#ffd23f']] as const) {
      out.push(paint(S(0.022, 10, 8).translate(x, 0.25, 0.195), c, { rough: 0.2 }));
    }
    out.push(paint(CYL(0.11, 0.13, 0.08, 16).translate(0, 0.42, 0), shade(p.fur, -0.35), { rough: 0.35, metal: 0.6 }));
    for (const s of [1, -1]) out.push(paint(S(0.085, 12, 8).translate(s * 0.24, 0.34, 0), p.accent, { rough: 0.35, metal: 0.2 }));
    out.push(xf(decalDisc(0.1, ATLAS.roundel), 0, 0.22, -0.172, 0, Math.PI, 0));
    return out;
  }
  const penguin = ch.species === 'penguin';
  const suit = penguin ? p.fur : p.suit;
  const prof: Array<[number, number]> = [[0.001, 0], [0.17, 0.0], [0.215, 0.05], [0.24, 0.15], [0.232, 0.27], [0.2, 0.36], [0.15, 0.425], [0.001, 0.46]];
  out.push(paint(revolve(prof, sg(18, 8)).scale(1, 1, 0.84), suit, { rough: penguin ? 0.5 : 0.7 }));
  if (penguin) {
    out.push(paint(E(0.17, 0.2, 0.1, 14, 9).translate(0, 0.2, 0.135), '#f7f8fc', { rough: 0.55 }));
  } else {
    // collar, belt, zipper stripe
    out.push(paint(TORUS(0.135, 0.035, 5, 16).rotateX(Math.PI / 2).scale(1, 1, 0.9).translate(0, 0.415, 0), p.trim, { rough: 0.6 }));
    out.push(paint(TORUS(0.212, 0.026, 4, 18).rotateX(Math.PI / 2).scale(1, 1, 0.84).translate(0, 0.06, 0), shade(p.suit, -0.55), { rough: 0.6 }));
    out.push(paint(new THREE.BoxGeometry(0.04, 0.26, 0.02).translate(0, 0.25, 0.196).rotateX(-0.08), p.trim, { rough: 0.6 }));
    out.push(xf(decalDisc(0.062, ATLAS.plate), 0.1, 0.27, 0.19, -0.12, 0.42, 0));
    // shoulder pads
    for (const s of [1, -1]) out.push(paint(S(0.085, 10, 6).translate(s * 0.195, 0.345, 0), p.trim, { rough: 0.6 }));
  }
  // race number on the back
  out.push(xf(decalDisc(0.1, ATLAS.roundel), 0, 0.23, -0.2, 0.06, Math.PI, 0));
  return out;
}

function armGeometry(ch: CharacterDef, p: Pal): THREE.BufferGeometry {
  const L = ARM_LEN;
  if (ch.species === 'penguin') {
    return merge([
      paint(E(0.04, 0.11, 0.2, 12, 8).translate(0, 0, 0.17), p.fur, { rough: 0.5 }),
      paint(E(0.035, 0.07, 0.07, 10, 8).translate(0, 0, L - 0.02), shade(p.fur, 0.15), { rough: 0.5 }),
    ]);
  }
  if (ch.species === 'robot') {
    return merge([
      paint(CYL(0.035, 0.035, 0.16, 10).rotateX(Math.PI / 2).translate(0, 0, 0.09), '#dfe6ec', { rough: 0.25, metal: 1 }),
      paint(S(0.05, 12, 8).translate(0, 0, 0.18), p.accent, { rough: 0.35 }),
      paint(CYL(0.045, 0.04, 0.12, 10).rotateX(Math.PI / 2).translate(0, 0, 0.26), p.fur, { rough: 0.3, metal: 0.5 }),
      paint(E(0.06, 0.055, 0.06, 12, 8).translate(0, 0, L), shade(p.fur, -0.45), { rough: 0.4, metal: 0.5 }),
    ]);
  }
  const sleeve = CAPS(0.056, L - 0.1, 3, 9).rotateX(Math.PI / 2).translate(0, 0, (L - 0.06) / 2);
  return merge([
    paint(sleeve, p.suit, { rough: 0.7 }),
    paint(TORUS(0.052, 0.02, 4, 8).translate(0, 0, L - 0.07), p.glove, { rough: 0.6 }),
    paint(E(0.068, 0.062, 0.075, 10, 7).translate(0, 0, L), p.glove, { rough: 0.6 }),
    ...(tiny ? [paint(E(0.03, 0.028, 0.04, 6, 4).translate(0.05, 0.02, L - 0.01), p.glove, { rough: 0.6 })] : []),
  ]);
}

/** Shadow proxy pieces → one painted (attribute-compatible) geometry. */
function proxyGeometry(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return merge(parts.map(g => paint(g, '#000000')));
}

function torsoProxy(ch: CharacterDef): THREE.BufferGeometry {
  // (inscribed, like every proxy piece: see kart-model kartShadowProxy)
  if (ch.species === 'robot') return proxyGeometry([PBOX(0.4, 0.36, 0.3, 0, 0.22, 0), PBOX(0.56, 0.12, 0.12, 0, 0.34, 0)]);
  return proxyGeometry([revolve([[0.001, 0.01], [0.18, 0.03], [0.225, 0.15], [0.19, 0.35], [0.001, 0.45]], 8).scale(1, 1, 0.84)]);
}

function armProxy(ch: CharacterDef): THREE.BufferGeometry {
  const L = ARM_LEN;
  if (ch.species === 'penguin') return proxyGeometry([PBOX(0.05, 0.15, L - 0.02, 0, 0, L / 2)]);
  if (ch.species === 'robot') return proxyGeometry([PBOX(0.06, 0.06, L + 0.02, 0, 0, L / 2 + 0.02)]);
  return proxyGeometry([PBOX(0.08, 0.08, L + 0.08, 0, 0, (L + 0.02) / 2)]);
}

// ───────────────────────────── build + cache ─────────────────────────────

export function buildDriverGeometries(ch: CharacterDef, lod: DriverLod = 'high'): DriverGeometries {
  segF = LOD_SEG[lod]; tiny = lod !== 'low'; proxies = lod !== 'high';
  try {
    return buildDriver(ch, lod);
  } finally {
    segF = 1; tiny = true; proxies = false;
  }
}

function buildDriver(ch: CharacterDef, lod: DriverLod): DriverGeometries {
  const p = palette(ch);
  const ho = HEADS[ch.species](p);
  const eyeCenter = V(0, ho.eyeY, ho.eyeZ);
  const eyes = merge(ho.eyes);
  eyes.translate(-eyeCenter.x, -eyeCenter.y, -eyeCenter.z);
  const eyesPainted = lod !== 'high';
  if (eyesPainted) markUnlit(eyes);
  const torso = merge([...torsoParts(ch, p), ...(ho.torsoExtra ?? [])]);
  const neckY = ch.species === 'robot' ? 0.43 : 0.43;
  const shadow: DriverShadowProxy | null = proxies ? {
    torso: torsoProxy(ch),
    head: proxyGeometry(ho.proxy?.length ? ho.proxy : [PELL(0, 0.29, 0.02, 0.34, 0.31, 0.32, 8, 5)]),
    arm: armProxy(ch),
    earL: ho.earProxyL ? proxyGeometry([ho.earProxyL]) : null,
    earR: ho.earProxyR ? proxyGeometry([ho.earProxyR]) : null,
    tail: ho.tailProxy ? proxyGeometry([ho.tailProxy]) : null,
  } : null;
  return {
    species: ch.species,
    torso,
    head: merge(ho.head),
    eyes,
    arm: armGeometry(ch, p),
    earL: ho.earL ? merge(ho.earL) : null,
    earR: ho.earR ? merge(ho.earR) : null,
    tail: ho.tail ? merge(ho.tail) : null,
    lamp: ho.lamp ? merge(ho.lamp) : null,
    neck: V(0, neckY, 0.0),
    eyeCenter,
    shoulderL: V(0.2, 0.34, 0.02),
    shoulderR: V(-0.2, 0.34, 0.02),
    earPivotL: ho.earPivotL ?? null,
    earPivotR: ho.earPivotR ?? null,
    tailPivot: ho.tailPivot ?? null,
    lampPivot: ho.lampPivot ?? null,
    armLength: ARM_LEN,
    headTop: neckY + ho.headTop,
    eyesPainted,
    shadow,
  };
}

export function disposeDriverGeometries(g: DriverGeometries): void {
  for (const x of [g.torso, g.head, g.eyes, g.arm, g.earL, g.earR, g.tail, g.lamp]) x?.dispose();
  const s = g.shadow;
  if (s) for (const x of [s.torso, s.head, s.arm, s.earL, s.earR, s.tail]) x?.dispose();
}

// ───────────────────────────── rig ─────────────────────────────

export interface DriverPose {
  dt: number;
  time: number;
  /** Smoothed steering −1..1 (+ = right). */
  steer: number;
  /** 0..1 fraction of max speed. */
  speedFrac: number;
  /** −1..1 lean into the turn (+ = lean right). */
  lean: number;
  /** Longitudinal acceleration (m/s²) for inertia on ears/tail/torso. */
  accel: number;
  lookBack: boolean;
  /** 0..1 blend toward arms-up celebration. */
  cheer: number;
  /** Eyes squeezed shut (hit / tumbling). */
  squint: boolean;
  /** Hand targets in the driver-root's parent space (chassis space). */
  gripL: THREE.Vector3;
  gripR: THREE.Vector3;
  /** Idle look-around when parked. */
  idle: number;
}

const _inv = new THREE.Quaternion();
const _t = new THREE.Vector3();
const _d = new THREE.Vector3();
const _Z = new THREE.Vector3(0, 0, 1);

export class DriverRig {
  readonly root = new THREE.Group();
  readonly torso = new THREE.Group();
  readonly head = new THREE.Group();
  readonly meshes: THREE.Mesh[] = [];
  /** Torso and head part meshes (bones for the shadow proxy). */
  readonly torsoMesh: THREE.Mesh;
  readonly headMesh: THREE.Mesh;
  readonly eyes: THREE.Mesh;
  readonly armL: THREE.Mesh;
  readonly armR: THREE.Mesh;
  readonly earL: THREE.Mesh | null = null;
  readonly earR: THREE.Mesh | null = null;
  readonly tail: THREE.Mesh | null = null;
  readonly lamp: THREE.Mesh | null = null;
  readonly lampMaterial: THREE.MeshBasicMaterial | null = null;
  private blinkAt: number;
  private blinkT = -1;
  private earVel = 0;
  private earAng = 0;
  private tailPhase: number;
  private lookT = 0;
  private headYaw = 0;
  private readonly lampOn: THREE.Color;
  private readonly lampOff: THREE.Color;

  constructor(readonly geo: DriverGeometries, paintMat: THREE.Material, unlitMat: THREE.Material, detail: string, seed: number) {
    const mk = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D) => {
      const mesh = new THREE.Mesh(g, m);
      parent.add(mesh);
      this.meshes.push(mesh);
      return mesh;
    };
    this.root.add(this.torso);
    this.torsoMesh = mk(geo.torso, paintMat, this.torso);
    this.head.position.copy(geo.neck);
    this.torso.add(this.head);
    this.headMesh = mk(geo.head, paintMat, this.head);
    // lower tiers: the eyes are marked unlit and join the paint draw (see buildDriverGeometries)
    this.eyes = mk(geo.eyes, geo.eyesPainted ? paintMat : unlitMat, this.head);
    this.eyes.position.copy(geo.eyeCenter);
    this.armL = mk(geo.arm, paintMat, this.torso);
    this.armL.position.copy(geo.shoulderL);
    this.armR = mk(geo.arm, paintMat, this.torso);
    this.armR.position.copy(geo.shoulderR);
    if (geo.earL && geo.earPivotL) { this.earL = mk(geo.earL, paintMat, this.head); this.earL.position.copy(geo.earPivotL); }
    if (geo.earR && geo.earPivotR) { this.earR = mk(geo.earR, paintMat, this.head); this.earR.position.copy(geo.earPivotR); }
    if (geo.tail && geo.tailPivot) { this.tail = mk(geo.tail, paintMat, this.torso); this.tail.position.copy(geo.tailPivot); }
    this.lampOn = new THREE.Color(detail).multiplyScalar(1.6);
    this.lampOff = new THREE.Color(detail).multiplyScalar(0.35);
    if (geo.lamp && geo.lampPivot) {
      this.lampMaterial = new THREE.MeshBasicMaterial({ color: this.lampOn.clone() });
      this.lamp = mk(geo.lamp, this.lampMaterial, this.head);
      this.lamp.position.copy(geo.lampPivot);
    }
    this.blinkAt = 1 + (seed % 7) * 0.37;
    this.tailPhase = seed * 1.7;
  }

  update(k: DriverPose): void {
    const t = k.time, dt = k.dt;
    // blink (occasional double blink)
    if (this.blinkT < 0 && t >= this.blinkAt) this.blinkT = 0;
    let eyeY = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const b = this.blinkT / 0.14;
      eyeY = b < 1 ? Math.abs(1 - 2 * b) * 0.9 + 0.1 : 1;
      if (b >= 1) {
        this.blinkT = -1;
        const r = Math.sin(t * 12.9898 + this.tailPhase) * 43758.5453;
        const f = r - Math.floor(r);
        this.blinkAt = t + (f < 0.18 ? 0.18 : 1.8 + f * 3.2);
      }
    }
    if (k.squint) eyeY = 0.18;
    this.eyes.scale.set(k.squint ? 1.12 : 1, eyeY, 1);

    // torso: lean into turns, breathe, rock back on acceleration, bounce while cheering
    const breathe = Math.sin(t * 2.4 + this.tailPhase) * 0.012;
    const cheerBounce = k.cheer * Math.abs(Math.sin(t * 7)) * 0.05;
    this.torso.rotation.set(
      THREE.MathUtils.clamp(-k.accel * 0.006, -0.12, 0.1) + k.cheer * -0.08,
      k.lookBack ? 0.35 : 0,
      k.lean * 0.2,
    );
    this.torso.scale.set(1 - breathe * 0.5, 1 + breathe, 1 - breathe * 0.5);
    this.torso.position.y = cheerBounce;

    // head: look into the turn / over the shoulder / idle glances
    this.lookT += dt;
    let yawTarget = -k.steer * 0.38;
    if (k.idle > 0) yawTarget += Math.sin(this.lookT * 0.7 + this.tailPhase) * 0.32 * k.idle;
    if (k.lookBack) yawTarget = 2.0;
    this.headYaw += (yawTarget - this.headYaw) * Math.min(1, dt * (k.lookBack ? 9 : 6));
    this.head.rotation.set(
      -k.cheer * 0.22 + Math.sin(t * 1.9 + this.tailPhase) * 0.025 + (k.squint ? 0.1 : 0),
      this.headYaw,
      k.lean * 0.14 + Math.sin(t * 1.3) * 0.02,
      'YXZ',
    );

    // arms reach for the grips (or wave in the air)
    this.torso.updateMatrix();
    _inv.copy(this.torso.quaternion).invert();
    this.aim(this.armL, k.gripL, k.cheer, 1, t);
    this.aim(this.armR, k.gripR, k.cheer, -1, t);

    // rabbit ears: spring toward a speed-dependent sweep-back
    if (this.earL && this.earR) {
      const target = -0.12 - k.speedFrac * 0.62 - Math.min(0.2, Math.max(0, k.accel) * 0.01) + k.cheer * 0.2;
      // fixed sub-steps: one explicit step per frame goes unstable at very low frame rates
      for (let left = dt; left > 1e-6;) {
        const h = Math.min(left, 1 / 120);
        left -= h;
        this.earVel += ((target - this.earAng) * 70 - this.earVel * 9) * h;
        this.earAng += this.earVel * h;
      }
      const flap = Math.sin(t * (6 + k.speedFrac * 14)) * (0.04 + k.speedFrac * 0.1);
      this.earL.rotation.set(this.earAng + flap, 0, -0.2 - k.speedFrac * 0.1 + Math.sin(t * 1.7) * 0.03);
      this.earR.rotation.set(this.earAng - flap * 0.8, 0, 0.2 + k.speedFrac * 0.1 - Math.sin(t * 1.9) * 0.03);
    }
    // tail swish
    if (this.tail) {
      const wag = k.cheer > 0.3 ? 9 : 2.2 + k.speedFrac * 2;
      this.tailPhase += dt * wag;
      const amp = this.geo.species === 'rabbit' ? 0.05 : this.geo.species === 'dino' ? 0.16 : 0.3;
      this.tail.rotation.set(-k.speedFrac * 0.25 + Math.sin(this.tailPhase * 0.5) * 0.05, Math.sin(this.tailPhase) * amp - k.steer * 0.3, 0);
    }
    // robot antenna lamp
    if (this.lampMaterial) {
      const on = (t % 1.1) < 0.55;
      this.lampMaterial.color.copy(on ? this.lampOn : this.lampOff);
    }
  }

  private aim(arm: THREE.Mesh, grip: THREE.Vector3, cheer: number, side: number, t: number): void {
    // target in torso space
    _t.copy(grip).sub(this.root.position).divideScalar(this.root.scale.x);
    _t.y -= this.torso.position.y;
    _t.applyQuaternion(_inv);
    if (cheer > 0) {
      const wave = Math.sin(t * 9 + side) * 0.08;
      _d.set(side * (0.34 + wave), 0.86, 0.06 + Math.cos(t * 9 + side) * 0.05);
      _t.lerp(_d, cheer);
    }
    _d.copy(_t).sub(arm.position);
    const len = _d.length();
    _d.divideScalar(len || 1);
    arm.quaternion.setFromUnitVectors(_Z, _d);
    arm.scale.set(1, 1, THREE.MathUtils.clamp(len / this.geo.armLength, 0.6, 1.35));
  }

  dispose(): void {
    this.lampMaterial?.dispose();
  }
}
