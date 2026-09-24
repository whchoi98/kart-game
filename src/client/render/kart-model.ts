/**
 * Procedural go-kart + driver visuals with full state-driven animation.
 *
 * Model space: kart faces +Z, +Y up, +X is the kart's LEFT (right = −X), origin at the
 * ground-contact centre. ~2.1 m long, 1.5 m wide.
 *
 * Draw calls per kart (typical racing): body + steering wheel + paint-material driver parts are ONE
 * rigid-skinned draw (rigid-merge.ts) + wheels 1 (InstancedMesh ×4) + eyes/lamp 1–2 + contact shadow 1
 * ≈ 4–5 (2–3 more in the shadow pass). Effects only draw while active
 * (flames 1 (InstancedMesh ×2), sparks 1, smoke 1, held items ≤3, rocket shell 3, drone 3).
 *
 * Level of detail (from RenderQuality.level at createKartVisual): 'high' is the reference model. 'medium'
 * and 'low' use coarser tessellation (tyres/treads, rims, tubes, bevels, heads/eyes/ears) and low drops tiny
 * details (chrome rings, vent lines, bolts, glints…) — ≈ 9.4k / 4.6k triangles per kart instead of ≈ 13.9k.
 * Below high the eyes join the rigid-skinned paint draw (unlit vertices, kart-materials `markUnlit`) and the
 * shadow pass draws a ≈ 0.6k-triangle proxy of boxes / cylinders skinned to the same parts (rigid-merge
 * shadow proxy) instead of body + driver + wheels + eyes: 1 shadow draw per kart instead of 3–4.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getCharacter, CHARACTERS } from '../../sim/characters.js';
import { PHYS } from '../../sim/constants.js';
import type { BoostKind, CharacterDef, CharacterId, HeldItem, KartState } from '../../sim/types.js';
import type { KartPose, KartVisual, KartVisualOptions, RenderQuality, ResolvedQuality } from './contracts.js';
import {
  ATLAS, INK, RefCache, acquireCharacterAtlas, atlasUV, attachNearFade, createAdditiveMaterial, createFxPointsMaterial,
  createPaintMaterial, createPaintTwin, createUnlitMaterial, paintUniforms, getFlameTexture, getShadowTexture, getSmokeTexture, getSparkTexture,
  merge, mixHex, paint, releaseCharacterAtlas, revolve, setNearFadeEnabled, shade, shadeByHeight, tube, xf,
} from './kart-materials.js';
import { DriverRig, buildDriverGeometries, disposeDriverGeometries, type DriverGeometries, type DriverPose } from './drivers.js';
import { createHeldItemMesh } from './item-models.js';
import { mergeRigidParts, type RigidMerge, type ShadowProxyPart } from './rigid-merge.js';

// ───────────────────────────── layout constants ─────────────────────────────

export const KART_LAYOUT = {
  rearAxle: { x: 0.6, y: 0.352, z: -0.58, r: 0.34, w: 0.3 },
  frontAxle: { x: 0.56, y: 0.302, z: 0.64, r: 0.29, w: 0.24 },
  seat: new THREE.Vector3(0, 0.47, -0.36),
  wheelHub: new THREE.Vector3(0, 0.74, -0.02),
  wheelTilt: 0.6,
  wheelRadius: 0.15,
  exhaust: [new THREE.Vector3(0.2, 0.705, -1.1), new THREE.Vector3(-0.2, 0.705, -1.1)],
  exhaustPitch: 0.42,
};
const RL = KART_LAYOUT.rearAxle, FL = KART_LAYOUT.frontAxle;

const RBOX = (w: number, h: number, d: number, r: number, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, r);
const CYL = (r0: number, r1: number, h: number, seg = 12) => new THREE.CylinderGeometry(r1, r0, h, seg, 1);
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

const DARK = '#2b2d42';
const GUNMETAL = '#434a59';
const CHROME = '#eef2f7';

/** Geometry tier of a kart visual: the RenderQuality level it is created for ('high' = the reference model). */
export type KartLod = ResolvedQuality;
/** Per-tier value (high, medium, low). */
const tier = <T>(lod: KartLod, high: T, medium: T, low: T): T => (lod === 'high' ? high : lod === 'medium' ? medium : low);

// ───────────────────────────── kart body geometry ─────────────────────────────

/** Main tub: side profile extruded across the width, tapered toward nose and tail, stripe UVs. */
function tubGeometry(lod: KartLod): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.84, 0.2);
  s.lineTo(0.72, 0.2);
  s.quadraticCurveTo(0.9, 0.2, 0.91, 0.3);
  s.quadraticCurveTo(0.92, 0.37, 0.84, 0.39);
  s.quadraticCurveTo(0.52, 0.43, 0.36, 0.52);
  s.quadraticCurveTo(0.26, 0.58, 0.16, 0.56);
  s.quadraticCurveTo(0.08, 0.55, 0.05, 0.46);
  s.lineTo(-0.5, 0.42);
  s.quadraticCurveTo(-0.58, 0.42, -0.6, 0.48);
  s.lineTo(-0.82, 0.48);
  s.quadraticCurveTo(-0.88, 0.48, -0.88, 0.42);
  s.lineTo(-0.88, 0.26);
  s.quadraticCurveTo(-0.88, 0.2, -0.84, 0.2);
  const depth = 0.66, bt = 0.07;
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(s, {
    depth, bevelEnabled: true, bevelThickness: bt, bevelSize: 0.05, bevelSegments: tier(lod, 3, 2, 1), curveSegments: tier(lod, 5, 3, 2),
  });
  // shape (x=z, y) extruded along +z → world: x' = depth/2 − z, y' = y, z' = x
  const m = new THREE.Matrix4().set(0, 0, -1, depth / 2, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);
  g.applyMatrix4(m);
  // taper toward nose and tail (stripe UVs are assigned afterwards from the final x)
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const f = z > 0.28 ? 1 - 0.36 * THREE.MathUtils.smoothstep(z, 0.28, 1.0)
      : z < -0.62 ? 1 - 0.12 * THREE.MathUtils.smoothstep(-z, 0.62, 0.95) : 1;
    pos.setX(i, x * f);
  }
  g.deleteAttribute('normal');
  g = toCreasedNormals(g, 0.9);
  return g;
}

/**
 * Racing-stripe UVs for the tub: u is an affine function of the vertex x, so it interpolates
 * exactly across every triangle (a taper-compensated u zig-zags across the extrusion's long
 * trapezoid quads). The stripe keeps a constant painted width from tail to nose.
 */
function applyStripeUV(g: THREE.BufferGeometry): void {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const [u, v] = atlasUV(ATLAS.stripe, THREE.MathUtils.clamp((pos.getX(i) + 0.4) / 0.8, 0.002, 0.998), 0.5);
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
}

function wingGeometry(width: number, lod: KartLod): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0.17, 0.0);
  s.quadraticCurveTo(0.1, 0.06, -0.16, 0.035);
  s.lineTo(-0.17, -0.005);
  s.quadraticCurveTo(0.05, -0.02, 0.17, 0.0);
  const d = width - 0.04;
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.012, bevelSegments: tier(lod, 2, 1, 1), curveSegments: tier(lod, 5, 3, 2) });
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, -1, d / 2, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  g.deleteAttribute('normal');
  return toCreasedNormals(g, 0.9);
}

function kartBodyGeometry(ch: CharacterDef, lod: KartLod): THREE.BufferGeometry {
  const c = ch.colors;
  const body = c.body, accent = c.accent;
  const podColor = accent;
  const trimDark = shade(body, -0.55);
  const parts: THREE.BufferGeometry[] = [];
  const P = (g: THREE.BufferGeometry, color: string, rough = 0.5, metal = 0) => parts.push(paint(g, color, { rough, metal }));
  const L = <T>(high: T, medium: T, low: T): T => tier(lod, high, medium, low);
  const lo = lod === 'low';
  /** Rounded box with one corner segment; a plain box at the low tier. */
  const RB1 = (w: number, h: number, d: number, r: number) => (lo ? new THREE.BoxGeometry(w, h, d) : RBOX(w, h, d, r, 1));

  // tub (colour from the stripe strip of the atlas)
  const tub = paint(tubGeometry(lod), '#ffffff', { rough: 0.32 });
  applyStripeUV(tub); // paint() pointed the UVs at the white area: map them onto the stripe strip
  parts.push(tub);

  // floor pan + skid
  P(RB1(0.92, 0.05, 1.84, 0.02).translate(0, 0.13, 0), DARK, 0.7);
  // axles
  P(CYL(0.03, 0.03, RL.x * 2, L(10, 8, 6)).rotateZ(Math.PI / 2).translate(0, RL.y, RL.z), GUNMETAL, 0.4, 0.7);
  P(CYL(0.03, 0.03, FL.x * 2, L(10, 8, 6)).rotateZ(Math.PI / 2).translate(0, FL.y, FL.z), GUNMETAL, 0.4, 0.7);
  // side pods
  for (const s of [1, -1]) {
    const pod = RBOX(0.3, 0.24, 0.56, 0.1, L(2, 2, 1));
    const pos = pod.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) { // taper the pod's front downward
      const z = pos.getZ(i), y = pos.getY(i);
      if (z > 0) pos.setY(i, y - (y > 0 ? z * z * 0.9 : 0));
    }
    pod.computeVertexNormals();
    P(pod.translate(s * 0.56, 0.3, 0.06), podColor, 0.35);
    // dark intake at the front + side vent lines
    P(new THREE.SphereGeometry(1, L(8, 8, 6), L(4, 4, 3)).scale(0.09, 0.05, 0.03).translate(s * 0.56, 0.29, 0.335), INK, 0.6);
    if (!lo) for (const dz of [-0.14, -0.08]) P(new THREE.BoxGeometry(0.012, 0.1, 0.03).translate(s * 0.712, 0.3, dz + 0.06 - 0.1), trimDark, 0.5);
    // number roundel on the pod side
    parts.push(xf(paint(new THREE.CircleGeometry(0.1, L(20, 14, 10)), '#ffffff', { rect: ATLAS.roundel, rough: 0.35 }), s * 0.713, 0.31, 0.1, 0, s * Math.PI / 2, 0));
  }
  // front bumper (U-shaped tube)
  for (const g of tube([V(0.46, 0.2, 0.74), V(0.5, 0.2, 0.95), V(0.28, 0.2, 1.02), V(0, 0.2, 1.035), V(-0.28, 0.2, 1.02), V(-0.5, 0.2, 0.95), V(-0.46, 0.2, 0.74)], 0.062, L(18, 12, 8), L(7, 6, 4))) P(g, DARK, 0.55);
  if (!lo) for (const s of [1, -1]) P(CYL(0.03, 0.03, 0.22, L(8, 6, 6)).rotateX(Math.PI / 2).translate(s * 0.25, 0.2, 0.92), GUNMETAL, 0.4, 0.6);
  // rear bumper
  for (const g of tube([V(0.4, 0.22, -0.86), V(0.36, 0.22, -0.99), V(0, 0.22, -1.03), V(-0.36, 0.22, -0.99), V(-0.4, 0.22, -0.86)], 0.058, L(14, 10, 6), L(7, 6, 4))) P(g, DARK, 0.55);
  // number plate on the nose + frame
  {
    const plate = RB1(0.25, 0.22, 0.04, 0.035);
    P(xf(plate, 0, 0.35, 0.945, -0.62, 0, 0), INK, 0.5);
    const face = paint(new THREE.PlaneGeometry(0.21, 0.19), '#ffffff', { rect: ATLAS.plate, rough: 0.3 });
    parts.push(xf(face, 0, 0.35 + 0.021 * Math.sin(0.62), 0.945 + 0.021 * Math.cos(0.62), -0.62, 0, 0));
  }
  // frog-eye headlights on the hood
  for (const s of [1, -1]) {
    const hx = s * 0.19, hy = 0.5, hz = 0.64;
    P(xf(CYL(0.07, 0.075, 0.07, L(10, 8, 8)), hx, hy, hz, 1.25, 0, 0), body, 0.32);
    if (!lo) P(xf(new THREE.TorusGeometry(0.058, 0.014, 3, L(12, 10, 10)), hx, hy + 0.01, hz + 0.03, -0.32, 0, 0), CHROME, 0.15, 1);
    P(xf(new THREE.SphereGeometry(0.056, L(8, 8, 6), L(3, 2, 2), 0, Math.PI * 2, 0, Math.PI / 2), hx, hy + 0.01, hz + 0.03, 1.25, 0, 0), '#fff4c2', 0.08);
  }
  // tail lights + rear badge
  const lamp = new THREE.Color(1.9, 0.18, 0.22);
  for (const s of [1, -1]) {
    parts.push(paint(CYL(0.058, 0.058, 0.03, L(12, 10, 8)).rotateX(Math.PI / 2).translate(s * 0.25, 0.4, -0.94), lamp, { rough: 0.15 }));
    if (!lo) P(new THREE.TorusGeometry(0.06, 0.012, L(4, 3, 3), L(12, 10, 10)).translate(s * 0.25, 0.4, -0.955), CHROME, 0.15, 1);
  }
  parts.push(xf(paint(new THREE.CircleGeometry(0.07, L(18, 12, 10)), '#ffffff', { rect: ATLAS.plate, rough: 0.3 }), 0, 0.37, -0.947, 0, Math.PI, 0));
  // cowl vent + dash gauge
  P(new THREE.BoxGeometry(0.3, 0.02, 0.1).translate(0, 0.608, 0.24), trimDark, 0.5);
  // seat
  const seatC = c.detail;
  P(RB1(0.46, 0.08, 0.36, 0.03).translate(0, 0.49, -0.36), DARK, 0.7);
  P(xf(RB1(0.5, 0.46, 0.09, 0.045), 0, 0.72, -0.62, -0.18, 0, 0), seatC, 0.6);
  P(xf(new THREE.BoxGeometry(0.36, 0.32, 0.03), 0, 0.73, -0.57, -0.18, 0, 0), shade(seatC, -0.25), 0.7);
  // steering column
  {
    const W = KART_LAYOUT.wheelHub, a = KART_LAYOUT.wheelTilt;
    const d = V(0, Math.sin(a), -Math.cos(a));
    const base = W.clone().addScaledVector(d, -0.3);
    const mid = base.clone().add(W).multiplyScalar(0.5);
    const col = CYL(0.022, 0.026, 0.3, L(8, 6, 6)).rotateX(Math.PI / 2 - a).translate(mid.x, mid.y, mid.z);
    P(col, GUNMETAL, 0.35, 0.7);
  }
  // engine block with fins, velocity stacks and exhausts
  P(RB1(0.44, 0.24, 0.3, 0.05).translate(0, 0.64, -0.78), GUNMETAL, 0.4, 0.55);
  for (const dy of lo ? [0, 0.1] : [0, 0.05, 0.1]) P(new THREE.BoxGeometry(0.48, 0.022, 0.24).translate(0, 0.58 + dy, -0.78), shade(GUNMETAL, 0.12), 0.4, 0.6);
  P(new THREE.BoxGeometry(0.3, 0.06, 0.2).translate(0, 0.79, -0.76), accent, 0.35);
  for (const s of [1, -1]) {
    const bell = revolve([[0.035, 0], [0.04, 0.06], [0.062, 0.12], [0.05, 0.125], [0.03, 0.1]], L(10, 8, 6));
    P(bell.translate(s * 0.09, 0.82, -0.76), CHROME, 0.14, 1);
  }
  for (const s of [1, -1]) {
    for (const g of tube([V(s * 0.14, 0.6, -0.9), V(s * 0.17, 0.62, -0.98), V(s * 0.2, 0.67, -1.06)], 0.042, L(6, 5, 4), L(7, 6, 5), false)) P(g, CHROME, 0.16, 1);
    const tip = revolve([[0.044, -0.02], [0.058, 0.06], [0.064, 0.075], [0.05, 0.07], [0.04, 0.02]], L(10, 8, 6));
    const e = KART_LAYOUT.exhaust[s > 0 ? 0 : 1]!;
    P(xf(tip, e.x, e.y - 0.02, e.z + 0.04, -(Math.PI / 2 + KART_LAYOUT.exhaustPitch), 0, 0), CHROME, 0.14, 1);
  }
  // rear spoiler
  for (const s of [1, -1]) P(xf(new THREE.BoxGeometry(0.04, 0.3, 0.08), s * 0.22, 0.87, -0.92, -0.25, 0, 0), DARK, 0.5);
  P(xf(wingGeometry(1.16, lod), 0, 1.0, -0.98, 0.12, 0, 0), accent, 0.35);
  for (const s of [1, -1]) {
    P(RB1(0.035, 0.2, 0.4, 0.03).translate(s * 0.59, 0.97, -0.98), body, 0.32);
  }
  // pinstripe on the wing
  P(xf(new THREE.BoxGeometry(1.1, 0.008, 0.05), 0, 1.034, -0.99, 0.12, 0, 0), body, 0.35);
  const g = merge(parts);
  shadeByHeight(g, 0.08, 0.5, 0.72);
  return g;
}

/** Wheel at rear size, axle along X, outer face toward +X. Front wheels use instance scale. */
function wheelGeometry(ch: CharacterDef, lod: KartLod): THREE.BufferGeometry {
  const R = RL.r, W = RL.w, ri = R * 0.6, hw = W / 2;
  const L = <T>(high: T, medium: T, low: T): T => tier(lod, high, medium, low);
  const lo = lod === 'low';
  // low: a plain rounded tyre (no knobs — at 16 sides a knob pattern reads as a polygon); the outer
  // shoulder keeps the reference rings around the accent band (ring np − 2) so the band stays a thin stripe
  const prof: Array<[number, number]> = lo ? [
    [ri, -hw + 0.02], [R - 0.06, -hw], [R, -hw + 0.05], [R, hw - 0.05], [R - 0.025, hw - 0.012], [R - 0.07, hw], [ri, hw - 0.02],
  ] : [
    [ri, -hw + 0.02], [R - 0.07, -hw], [R - 0.025, -hw + 0.012], [R, -hw + 0.05],
    [R, -hw * 0.45], [R - 0.012, 0], [R, hw * 0.45],
    [R, hw - 0.05], [R - 0.025, hw - 0.012], [R - 0.07, hw], [ri, hw - 0.02],
  ];
  // 4 segments per knob period at every tier (32 / 8 at high, 24 / 6 at medium)
  const N = L(8, 6, 0), SEG = L(32, 24, 16);
  const tread = (phi: number, j: number): number => {
    if (lo || j < 3 || j > 7 || j === 5) return 0;
    const shift = j < 5 ? 0 : 0.5;
    const f = (phi / (Math.PI * 2)) * N + shift;
    return (f - Math.floor(f)) < 0.5 ? 0.016 : -0.004;
  };
  const tyre = revolve(prof, SEG, (phi, j) => tread(phi, j));
  tyre.rotateZ(-Math.PI / 2);
  const np = prof.length;
  const band = mixHex(ch.colors.accent, '#2a2a33', 0.35);
  const parts: THREE.BufferGeometry[] = [paint(tyre, '#2a2a33', {
    rough: 0.88, colorFn: (_u, v) => (Math.abs(v * (np - 1) - (np - 2)) < 0.01 ? band : null),
  })];
  // rim dish, spokes, hub, cap, lug nuts
  const rimC = ch.colors.accent;
  parts.push(paint(CYL(ri * 1.02, ri * 1.02, W - 0.05, L(14, 12, 10)).rotateZ(Math.PI / 2), shade(rimC, -0.25), { rough: 0.4, metal: 0.3 }));
  if (!lo) parts.push(paint(new THREE.TorusGeometry(ri * 0.98, 0.018, 3, L(14, 12, 12)).rotateY(Math.PI / 2).translate(hw - 0.03, 0, 0), rimC, { rough: 0.3, metal: 0.2 }));
  parts.push(paint(new THREE.CircleGeometry(ri * 0.96, L(18, 14, 10)).rotateY(Math.PI / 2).translate(hw - 0.05, 0, 0), shade(rimC, -0.4), { rough: 0.5 }));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const sp = new THREE.BoxGeometry(0.03, ri * 0.9, 0.05).translate(0, ri * 0.45, 0);
    sp.rotateX(a);
    parts.push(paint(sp.translate(hw - 0.035, 0, 0), '#ffffff', { rough: 0.3, metal: 0.1 }));
  }
  parts.push(paint(CYL(0.06, 0.07, 0.05, L(10, 8, 6)).rotateZ(-Math.PI / 2).translate(hw - 0.03, 0, 0), CHROME, { rough: 0.15, metal: 1 }));
  const cap = lo ? new THREE.CircleGeometry(0.045, 8).rotateY(Math.PI / 2).translate(hw - 0.004, 0, 0)
    : new THREE.SphereGeometry(0.045, L(8, 6, 6), L(3, 2, 2), 0, Math.PI * 2, 0, Math.PI / 2).rotateZ(-Math.PI / 2).translate(hw - 0.005, 0, 0);
  parts.push(paint(cap, ch.colors.body, { rough: 0.3 }));
  // inner cover
  parts.push(paint(new THREE.CircleGeometry(ri * 1.02, L(14, 12, 10)).rotateY(-Math.PI / 2).translate(-hw + 0.03, 0, 0), DARK, { rough: 0.8 }));
  return merge(parts);
}

/** Steering wheel in its own plane (faces −Z toward the driver). */
function steeringGeometry(ch: CharacterDef, lod: KartLod): THREE.BufferGeometry {
  const R = KART_LAYOUT.wheelRadius;
  const L = <T>(high: T, medium: T, low: T): T => tier(lod, high, medium, low);
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.TorusGeometry(R, 0.024, L(6, 5, 4), L(20, 14, 10)), DARK, { rough: 0.7 }));
  for (const s of [1, -1]) {
    parts.push(paint(new THREE.TorusGeometry(R, 0.03, L(6, 4, 3), L(5, 4, 3), 0.7).rotateZ(Math.PI / 2 - s * 1.0 - 0.35), ch.colors.accent, { rough: 0.6 }));
  }
  for (const a of [-0.22, Math.PI + 0.22, -Math.PI / 2]) {
    const sp = new THREE.BoxGeometry(R * 0.95, 0.03, 0.02).translate(R * 0.48, 0, 0);
    parts.push(paint(sp.rotateZ(a), GUNMETAL, { rough: 0.4, metal: 0.6 }));
  }
  parts.push(paint(CYL(0.045, 0.05, 0.04, L(12, 10, 8)).rotateX(Math.PI / 2), GUNMETAL, { rough: 0.4, metal: 0.6 }));
  parts.push(paint(new THREE.CircleGeometry(0.036, L(16, 10, 8)).rotateY(Math.PI).translate(0, 0, -0.021), ch.colors.body, { rough: 0.35 }));
  return merge(parts);
}

/**
 * Shadow-pass stand-in for the kart body + wheels in chassis space (lower tiers, see rigid-merge): boxes for
 * the tub, pods, bumpers, engine / seat back and wing, capped 8-sided cylinders for the wheels (they spin
 * about their own axis, so binding them to the body reads the same). ≈ 0.36k triangles. Every piece sits
 * just INSIDE the real surfaces: a proxy face above a real one would self-shadow the kart where it should be
 * lit, while a proxy a few cm smaller only shrinks the (soft, PCF-filtered) cast shadow imperceptibly.
 */
function kartShadowProxy(): THREE.BufferGeometry {
  const B = (w: number, h: number, d: number, x: number, y: number, z: number, rx = 0) => xf(new THREE.BoxGeometry(w, h, d), x, y, z, rx);
  const parts = [
    B(0.74, 0.29, 1.2, 0, 0.3, -0.3),          // tub: cockpit + tail (real: ±0.40 wide, rim 0.47, deck 0.53)
    B(0.54, 0.25, 0.6, 0, 0.29, 0.6),          // tapered hood + nose (real: ±0.40 → ±0.26, top 0.56 → 0.44)
    B(1.38, 0.2, 0.46, 0, 0.3, 0.05),          // side pods (real: x ±0.71, y 0.18–0.42, rounded 0.1)
    B(0.96, 0.09, 0.09, 0, 0.2, 1.0), B(0.09, 0.09, 0.24, 0.47, 0.2, 0.85), B(0.09, 0.09, 0.24, -0.47, 0.2, 0.85), // front bumper tube
    B(0.76, 0.09, 0.09, 0, 0.22, -1.0), B(0.09, 0.09, 0.14, 0.37, 0.22, -0.92), B(0.09, 0.09, 0.14, -0.37, 0.22, -0.92), // rear bumper tube
    B(0.42, 0.22, 0.28, 0, 0.64, -0.78), B(0.24, 0.1, 0.1, 0, 0.84, -0.76), // engine block + stacks
    B(0.46, 0.42, 0.07, 0, 0.72, -0.62, -0.18), // seat back
    B(1.1, 0.04, 0.3, 0, 1.0, -0.98, 0.12),    // wing
    B(0.03, 0.28, 0.06, 0.22, 0.87, -0.92, -0.25), B(0.03, 0.28, 0.06, -0.22, 0.87, -0.92, -0.25),
    B(0.03, 0.18, 0.36, 0.59, 0.97, -0.98), B(0.03, 0.18, 0.36, -0.59, 0.97, -0.98),
    B(0.11, 0.07, 0.11, 0.19, 0.5, 0.64), B(0.11, 0.07, 0.11, -0.19, 0.5, 0.64), // frog-eye lamps
  ];
  // an 8-gon with its corners on the tyre radius is inscribed in the tyre
  for (const [x, y, z, , front] of WHEEL_SLOTS) {
    const a = front ? FL : RL;
    parts.push(CYL(a.r, a.r, a.w - 0.02, 8).rotateZ(Math.PI / 2).translate(x, y, z));
  }
  return merge(parts.map(g => paint(g, '#000000')));
}

// ───────────────────────────── shared FX geometry ─────────────────────────────

interface FxAssets {
  flame: THREE.BufferGeometry;      // template: outer + core cone (nozzle at origin, along −Z, length 1)
  flameOuterCount: number;
  shadow: THREE.BufferGeometry;
  shell: THREE.BufferGeometry;      // turbo-rocket hull (painted, roundel UVs)
  shellFlame: THREE.BufferGeometry; // big rocket flame (vertex coloured)
  drone: THREE.BufferGeometry;      // drone body + cables (painted)
  rotor: THREE.BufferGeometry;      // one 2-blade prop (painted)
  blur: THREE.BufferGeometry;       // 4 rotor blur discs (vertex coloured)
}

function flameGeometry(outerR: number, coreR: number, coreLen: number, seg = 14): { g: THREE.BufferGeometry; outer: number } {
  const outer = new THREE.ConeGeometry(outerR, 1, seg, 3, true).translate(0, 0.5, 0).rotateX(-Math.PI / 2);
  const core = new THREE.ConeGeometry(coreR, coreLen, seg, 2, true).translate(0, coreLen / 2, 0).rotateX(-Math.PI / 2);
  const oc = outer.attributes.position!.count;
  const g = new THREE.BufferGeometry();
  const o2 = outer.toNonIndexed(), c2 = core.toNonIndexed();
  outer.dispose(); core.dispose();
  const n = o2.attributes.position!.count + c2.attributes.position!.count;
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), colA = new Float32Array(n * 3).fill(1);
  pos.set(o2.attributes.position!.array as Float32Array, 0);
  pos.set(c2.attributes.position!.array as Float32Array, o2.attributes.position!.count * 3);
  uv.set(o2.attributes.uv!.array as Float32Array, 0);
  uv.set(c2.attributes.uv!.array as Float32Array, o2.attributes.position!.count * 2);
  const outerCount = o2.attributes.position!.count;
  o2.dispose(); c2.dispose();
  void oc;
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(colA, 3));
  g.computeBoundingSphere();
  return { g, outer: outerCount };
}

function colorFlame(g: THREE.BufferGeometry, outerCount: number, outer: THREE.Color, core: THREE.Color): void {
  const a = g.attributes.color as THREE.BufferAttribute;
  const arr = a.array as Float32Array;
  for (let i = 0; i < a.count; i++) {
    const c = i < outerCount ? outer : core;
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  a.needsUpdate = true;
}

const SHELL_AXIS_Y = 0.62;

function shellGeometry(): THREE.BufferGeometry {
  const hull = '#2b2d42', red = '#ff5d5d', white = '#f6f7fb';
  const parts: THREE.BufferGeometry[] = [];
  // profile (radius, z) — lathe around Y then Y→Z
  const bodyProf: Array<[number, number]> = [[0.5, -1.36], [0.66, -1.3], [0.8, -1.12], [0.86, -0.8], [0.87, -0.3], [0.86, 0.3]];
  const midProf: Array<[number, number]> = [[0.86, 0.3], [0.85, 0.6], [0.8, 0.95]];
  const noseProf: Array<[number, number]> = [[0.8, 0.95], [0.7, 1.25], [0.54, 1.55], [0.34, 1.82], [0.16, 2.0], [0.05, 2.08], [0.001, 2.1]];
  const gap = 1.08; // open cockpit around the top
  const toZ = (g: THREE.BufferGeometry) => g.rotateX(Math.PI / 2).translate(0, SHELL_AXIS_Y, 0);
  parts.push(paint(toZ(revolve(bodyProf, 30, undefined, Math.PI + gap, Math.PI * 2 - gap * 2)), hull, { rough: 0.3, metal: 0.25 }));
  parts.push(paint(toZ(revolve(midProf, 36)), hull, { rough: 0.3, metal: 0.25 }));
  parts.push(paint(toZ(revolve(noseProf, 36)), red, { rough: 0.22, metal: 0.1 }));
  parts.push(paint(new THREE.TorusGeometry(0.8, 0.035, 8, 40).translate(0, SHELL_AXIS_Y, 0.95), white, { rough: 0.3 }));
  parts.push(paint(new THREE.TorusGeometry(0.47, 0.03, 8, 32).translate(0, SHELL_AXIS_Y, 1.6), white, { rough: 0.3 }));
  parts.push(paint(toZ(revolve([[0.16, 1.99], [0.12, 2.06], [0.06, 2.14], [0.001, 2.17]], 20)), CHROME, { rough: 0.12, metal: 1 }));
  // cockpit rim
  for (const s of [1, -1]) {
    const a = Math.PI + s * gap;
    const r = 0.87;
    const pts = [V(Math.sin(a) * r * 0.93, SHELL_AXIS_Y - Math.cos(a) * r * 0.93, -1.08), V(Math.sin(a) * r, SHELL_AXIS_Y - Math.cos(a) * r, -0.5), V(Math.sin(a) * r, SHELL_AXIS_Y - Math.cos(a) * r, 0.3)];
    for (const g of tube(pts, 0.035, 16, 8)) parts.push(paint(g, white, { rough: 0.3 }));
  }
  // bands
  parts.push(paint(new THREE.TorusGeometry(0.868, 0.03, 8, 40).translate(0, SHELL_AXIS_Y, 0.34), white, { rough: 0.3 }));
  parts.push(paint(new THREE.TorusGeometry(0.8, 0.028, 8, 40).translate(0, SHELL_AXIS_Y, -1.12), red, { rough: 0.3 }));
  // side roundels
  for (const s of [1, -1]) {
    parts.push(xf(paint(new THREE.CircleGeometry(0.22, 28), '#ffffff', { rect: ATLAS.roundel, rough: 0.3 }), s * 0.872, SHELL_AXIS_Y - 0.08, -0.35, 0, s * Math.PI / 2, 0));
  }
  // fins (X configuration)
  const fin = new THREE.Shape();
  fin.moveTo(0, 0); fin.lineTo(0.5, 0); fin.quadraticCurveTo(0.62, -0.02, 0.6, -0.14); fin.lineTo(0.42, -0.5); fin.lineTo(0, -0.42); fin.lineTo(0, 0);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const g = new THREE.ExtrudeGeometry(fin, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 2, curveSegments: 6 });
    g.translate(0, 0, -0.025);
    // fin plane: x = radial, y = along −Z (sweep back)
    g.applyMatrix4(new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1));
    g.translate(0.7, 0, -0.9);
    g.rotateZ(a);
    g.translate(0, SHELL_AXIS_Y, 0);
    parts.push(paint(g, red, { rough: 0.3 }));
  }
  // nozzle bell
  const bell = revolve([[0.46, 0.0], [0.44, -0.05], [0.4, -0.16], [0.44, -0.26], [0.36, -0.24], [0.3, -0.1], [0.28, 0.0]], 28);
  parts.push(paint(bell.rotateX(Math.PI / 2).translate(0, SHELL_AXIS_Y, -1.34), CHROME, { rough: 0.15, metal: 1 }));
  return merge(parts);
}

function droneGeometry(): { body: THREE.BufferGeometry; rotor: THREE.BufferGeometry; blur: THREE.BufferGeometry } {
  const yellow = '#ffd23f', parts: THREE.BufferGeometry[] = [];
  const P = (g: THREE.BufferGeometry, c: string, rough = 0.45, metal = 0) => parts.push(paint(g, c, { rough, metal }));
  // (tessellation kept modest: the drone is a transient, ~1 m prop — about 2.5k tris in total)
  P(new THREE.SphereGeometry(1, 20, 12).scale(0.42, 0.3, 0.4), yellow, 0.35);
  P(new THREE.SphereGeometry(1, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.24, 0.16, 0.24).translate(0, 0.24, 0), '#e9eef5', 0.2, 0.4);
  P(new THREE.SphereGeometry(0.05, 8, 6).translate(0, 0.42, 0), '#ff3864', 0.2);
  P(new THREE.TorusGeometry(0.4, 0.03, 6, 24).rotateX(Math.PI / 2).scale(1, 1, 0.96).translate(0, -0.02, 0), '#2b2d42', 0.5);
  // face
  for (const s of [1, -1]) {
    P(new THREE.SphereGeometry(1, 12, 8).scale(0.055, 0.07, 0.03).translate(s * 0.13, 0.05, 0.385), INK, 0.1);
    P(new THREE.SphereGeometry(0.018, 6, 4).translate(s * 0.13 - 0.015, 0.075, 0.41), '#ffffff', 0.1);
    P(new THREE.SphereGeometry(1, 8, 6).scale(0.045, 0.028, 0.01).translate(s * 0.24, -0.04, 0.33).rotateY(s * 0.1), '#ff8fb1', 0.8);
  }
  P(new THREE.TorusGeometry(0.05, 0.012, 6, 12, Math.PI).rotateZ(Math.PI).translate(0, -0.04, 0.4), INK, 0.4);
  // arms + motor pods
  const rotorAt: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const x = Math.sin(a) * 0.62, z = Math.cos(a) * 0.62;
    P(CYL(0.032, 0.032, 0.5, 8).rotateX(Math.PI / 2).translate(0, 0, 0.35).rotateY(a), '#434a59', 0.4, 0.5);
    P(CYL(0.07, 0.08, 0.1, 12).translate(x, 0.02, z), '#2b2d42', 0.45);
    P(CYL(0.02, 0.02, 0.06, 8).translate(x, 0.1, z), CHROME, 0.2, 1);
    rotorAt.push(V(x, 0.13, z));
  }
  // hook + cables (kart attach points at (±0.5, −1.68, 0) relative to the drone)
  P(CYL(0.03, 0.03, 0.14, 8).translate(0, -0.34, 0), '#434a59', 0.4, 0.6);
  for (const s of [1, -1]) {
    const a = V(0, -0.4, 0), b = V(s * 0.52, -1.7, 0);
    const len = a.distanceTo(b);
    const g = CYL(0.012, 0.012, len, 6);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
    P(g, '#1f2230', 0.6);
    P(new THREE.TorusGeometry(0.035, 0.01, 6, 10).rotateX(Math.PI / 2).translate(b.x, b.y, 0), CHROME, 0.2, 1);
  }
  const body = merge(parts);
  const rotor = merge([
    paint(new THREE.BoxGeometry(0.5, 0.014, 0.07), '#f6f7fb', { rough: 0.4 }),
    paint(CYL(0.03, 0.03, 0.03, 8), '#ff3864', { rough: 0.3 }),
  ]);
  const blurs: THREE.BufferGeometry[] = [];
  for (const p of rotorAt) blurs.push(new THREE.CircleGeometry(0.27, 18).rotateX(-Math.PI / 2).translate(p.x, p.y + 0.005, p.z).toNonIndexed());
  const blur = merge(blurs.map(g => { g.deleteAttribute('normal'); return g; }));
  const bc = new Float32Array(blur.attributes.position!.count * 3).fill(1);
  blur.setAttribute('color', new THREE.BufferAttribute(bc, 3));
  return { body, rotor, blur };
}

const fxCache = new RefCache<FxAssets>(a => {
  for (const g of [a.flame, a.shadow, a.shell, a.shellFlame, a.drone, a.rotor, a.blur]) g.dispose();
});

function buildFxAssets(): FxAssets {
  const f = flameGeometry(0.5, 0.26, 0.55);
  const sf = flameGeometry(0.5, 0.3, 0.6, 18);
  colorFlame(sf.g, sf.outer, new THREE.Color('#ff7a1a'), new THREE.Color('#fff2a8'));
  const d = droneGeometry();
  return {
    flame: f.g, flameOuterCount: f.outer,
    shadow: new THREE.PlaneGeometry(1.9, 2.7).rotateX(-Math.PI / 2),
    shell: shellGeometry(),
    shellFlame: sf.g,
    drone: d.body, rotor: d.rotor, blur: d.blur,
  };
}

// ───────────────────────────── per-character asset cache ─────────────────────────────

interface KartAssets {
  body: THREE.BufferGeometry; wheel: THREE.BufferGeometry; steer: THREE.BufferGeometry; driver: DriverGeometries;
  /** Shadow proxy of body + wheels (chassis space); null at the high tier. */
  shadow: THREE.BufferGeometry | null;
}

const kartCache = new RefCache<KartAssets>(a => {
  a.body.dispose(); a.wheel.dispose(); a.steer.dispose(); a.shadow?.dispose();
  disposeDriverGeometries(a.driver);
});

function buildKartAssets(ch: CharacterDef, lod: KartLod): KartAssets {
  return {
    body: kartBodyGeometry(ch, lod), wheel: wheelGeometry(ch, lod), steer: steeringGeometry(ch, lod),
    driver: buildDriverGeometries(ch, lod),
    shadow: lod === 'high' ? null : kartShadowProxy(),
  };
}

function atlasInfo(ch: CharacterDef) {
  return { species: ch.species, number: CHARACTERS.findIndex(c => c.id === ch.id) + 1, ...ch.colors };
}

// ───────────────────────────── helpers ─────────────────────────────

const clamp = THREE.MathUtils.clamp;
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeInOut = (x: number) => x * x * (3 - 2 * x);
/** Wrap an angle difference into (−π, π]. */
function wrapAngle(a: number): number {
  let d = a % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}
function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}
/** Cheap deterministic hash noise in [0,1). */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Max integration step of the visual springs (s). */
const SPRING_H = 1 / 120;

/**
 * Damped spring x'' = k(target − x) − c·x' integrated in fixed sub-steps of ≤ SPRING_H.
 * One symplectic-Euler step per frame is only stable while k·dt² + 2c·dt < 4 — for the chassis
 * bob (k 230, c 15) that is dt < 0.082 s, so below ~12 fps the suspension grew ×2 per frame until
 * the body and driver were 1e20 m away and only the wheels were left on screen.
 */
class Spring {
  v = 0;
  constructor(public x: number) {}
  step(target: number, k: number, c: number, dt: number, lo = -Infinity, hi = Infinity): number {
    let left = dt;
    while (left > 1e-6) {
      const h = left > SPRING_H ? SPRING_H : left;
      left -= h;
      this.v += ((target - this.x) * k - this.v * c) * h;
      this.x += this.v * h;
      if (this.x < lo) { this.x = lo; if (this.v < 0) this.v = 0; }
      else if (this.x > hi) { this.x = hi; if (this.v > 0) this.v = 0; }
    }
    if (!Number.isFinite(this.x) || !Number.isFinite(this.v)) { this.x = target; this.v = 0; }
    return this.x;
  }
}

const BOOST_COLORS: Record<BoostKind | 'star', [string, string]> = {
  mini1: ['#2f8fff', '#d6f0ff'],
  mini2: ['#ff7414', '#fff0b8'],
  mini3: ['#c23bff', '#ffd2ff'],
  start: ['#ff8a12', '#fff39a'],
  pad: ['#ff8a12', '#fff39a'],
  nitro: ['#ff7a12', '#fff39a'],
  trick: ['#ff9a12', '#fff39a'],
  ramp: ['#ff9a12', '#fff39a'],
  coin: ['#ffb000', '#fff39a'],
  star: ['#ffffff', '#ffffff'],
};
const BOOST_STRENGTH: Partial<Record<BoostKind, number>> = { mini1: 0.8, mini2: 1.0, mini3: 1.25, nitro: 1.15, start: 1.1, pad: 1.05 };
const DRIFT_COLORS = ['#fff3b0', '#3aa8ff', '#ff9a1a', '#c850ff'].map(c => new THREE.Color(c));

const WHEEL_SLOTS: ReadonlyArray<readonly [number, number, number, number, boolean]> = [
  [RL.x, RL.y, RL.z, 1, false], [-RL.x, RL.y, RL.z, -1, false],
  [FL.x, FL.y, FL.z, 1, true], [-FL.x, FL.y, FL.z, -1, true],
];
const HELD_KINDS = ['banana', 'orb', 'rocket'] as const;
/** A fresh spin timer above this means the hit was a squash (PHYS.squashTime) rather than a spin-out. */
const SQUASH_DETECT = (PHYS.spinTime + PHYS.squashTime) / 2;
const SPARK_N = 56;
const PINNED = 6;
const SMOKE_N = 22;

interface Particle { life: number; max: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; size: number; grow: number; r: number; g: number; b: number; a: number }
function makeParticles(n: number): Particle[] {
  return Array.from({ length: n }, () => ({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 0, grow: 0, r: 1, g: 1, b: 1, a: 1 }));
}

function makePoints(n: number, mat: THREE.PointsMaterial): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('psize', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.6, 0), 4);
  const p = new THREE.Points(g, mat);
  p.frustumCulled = true;
  p.visible = false;
  return p;
}

// ───────────────────────────── the visual ─────────────────────────────

/** Extra (non-contract) controls used by the showroom / results screens. */
export interface KartVisualExtras {
  /** Force the driver's celebration pose (0..1). */
  setCheer(amount: number): void;
  /**
   * Race views: screen-door fade the kart (body, driver, wheels, eyes) where it comes within ~3 m of the
   * rendering camera, so a CPU kart cutting past the chase camera doesn't fill a quarter of the screen.
   * Per fragment and per view (split screen included); a player's own kart sits ≥ 3.7 m from its chase
   * camera and is never affected. Off by default (showroom / preview cameras frame karts closely).
   */
  setNearFade(on: boolean): void;
  /**
   * Race views, set per rendered view (scene.onBeforeRender): 0 = normal … 1 = dissolved completely, for a kart
   * whose hull is right at that view's lens. Pushes the near-fade band out so the whole kart screen-doors away
   * (per fragment, no pop; shadows it casts are unaffected) and fades its contact shadow and exhaust FX with
   * it. Needs setNearFade(true).
   */
  setLensFade(amount: number): void;
  /** Last value given to setLensFade (debug/QA). */
  readonly lensFade: number;
}

/** Near-camera fade band (view depth, m): fully dithered out below GONE, fully drawn beyond FULL. */
const NEAR_FADE_GONE = 1.1;
const NEAR_FADE_FULL = 2.9;
/** setLensFade(1) moves that band this far out: a kart within ~2 m of the lens has no fragment left. */
const LENS_FADE_SHIFT = 2.6;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _col = new THREE.Color();
const _col2 = new THREE.Color();
/** Nozzle orientation of the exhaust flames (pitched along the pipes). */
const FLAME_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(KART_LAYOUT.exhaustPitch, 0, 0));

class KartVisualImpl implements KartVisual, KartVisualExtras {
  readonly root = new THREE.Group();
  readonly charId: CharacterId;
  private readonly ch: CharacterDef;
  private readonly q: RenderQuality;
  private readonly assets: KartAssets;
  private readonly fx: FxAssets;
  private readonly atlas: THREE.Texture;
  // hierarchy
  private readonly scaler = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private readonly inner = new THREE.Group();
  private readonly kartGroup = new THREE.Group();
  private readonly chassis = new THREE.Group();
  private readonly bodyMesh: THREE.Mesh;
  private readonly wheels: THREE.InstancedMesh;
  private readonly steerTilt = new THREE.Group();
  private readonly steerMesh: THREE.Mesh;
  private readonly driver: DriverRig;
  private readonly shadow: THREE.Mesh;
  /** Both exhaust flames: one InstancedMesh (one draw) sharing the per-kart coloured geometry. */
  private readonly flames: THREE.InstancedMesh;
  private readonly flameGeo: THREE.BufferGeometry;
  private readonly sparks: THREE.Points;
  private readonly smoke: THREE.Points;
  private readonly heldGroup = new THREE.Group();
  // materials
  private readonly paintMat: THREE.MeshStandardMaterial;
  /** paintMat twin for the InstancedMesh parts (wheels, rotors): avoids per-frame program switches. */
  private readonly paintInstMat: THREE.MeshStandardMaterial;
  /** Body, steering wheel and paint-material driver parts drawn as one rigid-skinned mesh (rigid-merge.ts). */
  private readonly merged: RigidMerge | null;
  private readonly unlitMat: THREE.MeshBasicMaterial;
  private readonly flameMat: THREE.MeshBasicMaterial;
  private readonly sparkMat: THREE.PointsMaterial;
  private readonly smokeMat: THREE.PointsMaterial;
  private readonly shadowMat: THREE.MeshBasicMaterial;
  // lazily created effects
  private shell: THREE.Group | null = null;
  private shellMat: THREE.MeshStandardMaterial | null = null;
  private shellFlame: THREE.Mesh | null = null;
  private shellFlameMat: THREE.MeshBasicMaterial | null = null;
  private drone: THREE.Group | null = null;
  private droneRotors: THREE.InstancedMesh | null = null;
  private droneBlurMat: THREE.MeshBasicMaterial | null = null;
  private readonly heldPool: Record<HeldItem['kind'], THREE.Object3D[]> = { banana: [], orb: [], rocket: [] };
  private readonly heldUsed: Record<HeldItem['kind'], number> = { banana: 0, orb: 0, rocket: 0 };
  // state
  private t = 0;
  private prevSpeed = 0;
  private accel = 0;
  private spinR = 0;
  private spinF = 0;
  /** Chassis suspension offset (m), squash (−0.7..0.45), shrink scale, rocket-shell amount. */
  private readonly bobS = new Spring(0);
  private readonly sqS = new Spring(0);
  private readonly shS = new Spring(1);
  private readonly shellS = new Spring(0);
  private get sq(): number { return this.sqS.x; }
  private get sh(): number { return this.shS.x; }
  private get shellAmt(): number { return this.shellS.x; }
  private flameAmt = 0;
  private flameKind: BoostKind | 'star' | null = null;
  private readonly flameCol = new THREE.Color();
  private wasGrounded = true;
  private airT = 0;
  private groundY = 0;
  private prevHop = 0; private prevSpin = 0; private prevTumble = 0; private prevTrick = 0;
  private spinStart = 1; private tumbleStart = 1; private trickStart = 1;
  private spinDir = 1; private trickVariant = 0;
  private squashHit = false;
  private respawning = false;
  private readonly settle = new THREE.Vector3();
  private settleYaw = 0;
  private orbitSpread = (Math.PI * 2) / 3;
  private readonly resStart = new THREE.Vector3();
  private resYaw = 0;
  private droneLeave = -1;
  private idle = 0;
  private cheerForced = 0;
  private finishCheer = 0;
  private wasFinished = false;
  private ghost = false;
  private nearFadeOn = false;
  private lensAmount = 0;
  /** Contact-shadow opacity update() chose this frame (before the per-view lens fade). */
  private shadowOpacity = 0;
  private starWas = false;
  private sparkEmit = 0; private starEmit = 0; private smokeEmit = 0;
  private readonly sparkP = makeParticles(SPARK_N);
  private readonly smokeP = makeParticles(SMOKE_N);
  private readonly dp: DriverPose;
  private readonly seed: number;
  private readonly castShadows: boolean;
  private readonly lod: KartLod;

  constructor(charId: CharacterId, quality: RenderQuality, seed: number, lod: KartLod) {
    this.charId = charId;
    this.ch = getCharacter(charId);
    this.q = quality;
    this.seed = seed;
    this.castShadows = quality.shadows;
    this.lod = lod;
    this.assets = kartCache.acquire(`${charId}:${lod}`, () => buildKartAssets(this.ch, lod));
    this.fx = fxCache.acquire('fx', buildFxAssets);
    this.atlas = acquireCharacterAtlas(charId, atlasInfo(this.ch));
    this.paintMat = createPaintMaterial(this.atlas);
    this.paintInstMat = createPaintTwin(this.paintMat);
    this.unlitMat = createUnlitMaterial();
    this.flameMat = createAdditiveMaterial(getFlameTexture());
    this.sparkMat = createFxPointsMaterial(getSparkTexture(), true);
    this.smokeMat = createFxPointsMaterial(getSmokeTexture(), false);
    this.shadowMat = new THREE.MeshBasicMaterial({
      map: getShadowTexture(), color: '#000000', transparent: true, opacity: quality.shadows ? 0.42 : 0.7,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });

    // hierarchy
    this.root.name = `kart-${charId}`;
    this.root.add(this.scaler);
    this.scaler.add(this.pivot);
    this.pivot.position.y = 0.55;
    this.pivot.add(this.inner);
    this.inner.position.y = -0.55;
    this.inner.add(this.kartGroup);
    this.kartGroup.add(this.chassis);

    this.bodyMesh = new THREE.Mesh(this.assets.body, this.paintMat);
    this.chassis.add(this.bodyMesh);

    this.wheels = new THREE.InstancedMesh(this.assets.wheel, this.paintInstMat, 4);
    this.wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.kartGroup.add(this.wheels);
    this.setWheels(0);
    this.wheels.computeBoundingSphere();
    if (this.wheels.boundingSphere) this.wheels.boundingSphere.radius += 0.3;

    this.steerTilt.position.copy(KART_LAYOUT.wheelHub);
    this.steerTilt.rotation.x = KART_LAYOUT.wheelTilt;
    this.steerMesh = new THREE.Mesh(this.assets.steer, this.paintMat);
    this.steerTilt.add(this.steerMesh);
    this.chassis.add(this.steerTilt);

    this.driver = new DriverRig(this.assets.driver, this.paintMat, this.unlitMat, this.ch.colors.detail, seed);
    const nearFade = paintUniforms(this.paintMat)?.uNearFade;
    if (nearFade) {
      attachNearFade(this.unlitMat, nearFade);
      if (this.driver.lampMaterial) attachNearFade(this.driver.lampMaterial, nearFade);
    }
    this.driver.root.position.copy(KART_LAYOUT.seat);
    const ds = this.ch.weightClass === 'heavy' ? 1.04 : this.ch.weightClass === 'light' ? 0.96 : 1;
    this.driver.root.scale.setScalar(ds);
    this.chassis.add(this.driver.root);

    this.shadow = new THREE.Mesh(this.fx.shadow, this.shadowMat);
    this.shadow.position.y = 0.035;
    this.shadow.renderOrder = -1;
    this.root.add(this.shadow);

    // exhaust flames: one per-kart coloured geometry, one instance per nozzle (chassis space)
    this.flameGeo = this.fx.flame.clone();
    this.flames = new THREE.InstancedMesh(this.flameGeo, this.flameMat, KART_LAYOUT.exhaust.length);
    this.flames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flames.visible = false;
    this.flames.frustumCulled = false;
    this.chassis.add(this.flames);
    this.sparks = makePoints(SPARK_N, this.sparkMat);
    this.inner.add(this.sparks);
    this.smoke = makePoints(SMOKE_N, this.smokeMat);
    this.inner.add(this.smoke);
    this.inner.add(this.heldGroup);

    for (const m of [this.bodyMesh, this.wheels, this.steerMesh, ...this.driver.meshes]) {
      m.castShadow = this.castShadows;
      m.receiveShadow = this.castShadows;
    }
    // Same pixels, 1 draw call instead of 6–9 (and again in the shadow pass): the parts keep animating
    // as before and act as the bones of one rigid-skinned mesh. Below high the shadow pass draws the
    // low-poly proxy instead (skinned to the same parts), which also stands in for the wheels and eyes.
    this.merged = mergeRigidParts(this.root,
      [this.bodyMesh, this.steerMesh, ...this.driver.meshes.filter(m => m.material === this.paintMat)], this.paintMat,
      this.castShadows ? this.shadowProxyParts() : []);
    if (this.merged?.mesh.userData.shadowRange) {
      for (const m of [this.wheels, this.driver.eyes, this.driver.lamp]) {
        if (!m) continue;
        m.castShadow = false;
        m.userData.noShadowCast = true; // applyShadowFlags keeps it off
      }
    }
    this.dp = {
      dt: 0, time: 0, steer: 0, speedFrac: 0, lean: 0, accel: 0, lookBack: false, cheer: 0, squint: false,
      gripL: new THREE.Vector3(), gripR: new THREE.Vector3(), idle: 0,
    };
  }

  setCheer(amount: number): void { this.cheerForced = clamp(amount, 0, 1); }

  /** Shadow proxy pieces bound to the parts they follow (empty at the high tier). */
  private shadowProxyParts(): ShadowProxyPart[] {
    const out: ShadowProxyPart[] = [];
    const body = this.assets.shadow, dv = this.driver, ds = this.assets.driver.shadow;
    if (!body || !ds) return out;
    out.push({ part: this.bodyMesh, geometry: body });
    out.push({ part: dv.torsoMesh, geometry: ds.torso }, { part: dv.headMesh, geometry: ds.head });
    out.push({ part: dv.armL, geometry: ds.arm }, { part: dv.armR, geometry: ds.arm });
    if (ds.earL && dv.earL) out.push({ part: dv.earL, geometry: ds.earL });
    if (ds.earR && dv.earR) out.push({ part: dv.earR, geometry: ds.earR });
    if (ds.tail && dv.tail) out.push({ part: dv.tail, geometry: ds.tail });
    return out;
  }

  setNearFade(on: boolean): void {
    const u = paintUniforms(this.paintMat);
    if (!u) return;
    this.nearFadeOn = on;
    this.lensAmount = 0;
    u.uNearFade.value.set(on ? NEAR_FADE_GONE : 0, on ? NEAR_FADE_FULL : 0);
    for (const m of [this.paintMat, this.paintInstMat, this.unlitMat, this.driver.lampMaterial, this.shellMat]) {
      if (m) setNearFadeEnabled(m, on);
    }
  }

  get lensFade(): number { return this.lensAmount; }

  setLensFade(amount: number): void {
    if (!this.nearFadeOn) return;
    const a = amount > 0 ? (amount < 1 ? amount : 1) : 0;
    if (a === this.lensAmount) return;
    this.lensAmount = a;
    const shift = a * LENS_FADE_SHIFT;
    paintUniforms(this.paintMat)?.uNearFade.value.set(NEAR_FADE_GONE + shift, NEAR_FADE_FULL + shift);
    const keep = 1 - a;
    this.shadowMat.opacity = this.shadowOpacity * keep;
    this.flameMat.opacity = keep;
    this.sparkMat.opacity = keep;
    this.smokeMat.opacity = keep;
    // held / orbiting items share one material with every kart: hide them once the kart is mostly gone
    this.heldGroup.visible = a < 0.6;
  }

  // ── wheels ──
  private setWheels(steerYaw: number): void {
    const fsx = FL.w / RL.w, fsr = FL.r / RL.r;
    for (let i = 0; i < 4; i++) {
      const w = WHEEL_SLOTS[i]!; // indexed reads: tuple destructuring allocates an iterator in unoptimised tiers
      const x = w[0], y = w[1], z = w[2], side = w[3], front = w[4];
      const spin = (front ? this.spinF : this.spinR) * side;
      _e.set(spin, (front ? steerYaw : 0) + (side < 0 ? Math.PI : 0), 0, 'YXZ');
      _q.setFromEuler(_e);
      _sc.set(front ? fsx : 1, front ? fsr : 1, front ? fsr : 1);
      _m.compose(_v.set(x, y, z), _q, _sc);
      this.wheels.setMatrixAt(i, _m);
    }
    this.wheels.instanceMatrix.needsUpdate = true;
  }

  private setGhost(on: boolean): void {
    this.ghost = on;
    for (const m of [this.paintMat, this.paintInstMat, this.unlitMat, this.driver.lampMaterial, this.shellMat]) {
      if (!m) continue;
      m.transparent = on;
      m.opacity = on ? 0.42 : 1;
      m.needsUpdate = true;
    }
    this.applyShadowFlags(this.root);
  }

  /** Solid parts cast shadows (unless ghosted); transparent / additive FX never do. */
  private applyShadowFlags(o: THREE.Object3D): void {
    const cast = this.castShadows && !this.ghost;
    o.traverse(c => {
      const m = c as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.Material;
      m.castShadow = cast && !mat.transparent && m.userData.noShadowCast !== true;
    });
  }

  focus(out: THREE.Vector3): THREE.Vector3 {
    const s = this.sh;
    out.set(0, 1.16 * s, -0.32 * s).applyQuaternion(this.root.quaternion).add(this.root.position);
    return out;
  }

  update(k: KartState, pose: KartPose, dt: number, opts: KartVisualOptions): void {
    const d = clamp(dt, 0, 0.1);
    this.t += d;
    const t = this.t;
    if (!!opts.ghost !== this.ghost) this.setGhost(!!opts.ghost);

    // ── pose (with respawn-drone carry override) ──
    let px = pose.x, py = pose.y, pz = pose.z;
    let yaw = pose.yaw + k.driftAngle, pitch = -k.pitch, roll = k.roll;
    let carry = 0;
    if (k.respawnTime > 0) {
      if (!this.respawning) {
        this.respawning = true;
        this.resStart.set(pose.x, pose.y, pose.z);
        this.resYaw = pose.yaw;
        this.droneLeave = -1;
      }
      const p = clamp(1 - k.respawnTime / PHYS.respawnTime, 0, 1);
      const ls = k.lastSafe;
      const c = clamp((p - 0.16) / 0.7, 0, 1);
      const e = easeInOutCubic(c);
      px = this.resStart.x + (ls.x - this.resStart.x) * e;
      pz = this.resStart.z + (ls.z - this.resStart.z) * e;
      const lift = Math.sin(c * Math.PI) * 3.2 + (p > 0.86 ? (1 - (p - 0.86) / 0.14) * 0.25 : c >= 1 ? 0.25 : 0);
      py = this.resStart.y + (ls.y - this.resStart.y) * e + lift;
      yaw = lerpAngle(this.resYaw, ls.yaw, e);
      carry = p < 0.16 ? 0 : 1;
      pitch = Math.sin(t * 2.3) * 0.06 * carry;
      roll = Math.sin(t * 3.1) * 0.12 * carry;
    } else if (this.respawning) {
      this.respawning = false;
      this.droneLeave = 0;
      // The sim drops the kart at pointAt(lastSafe.i, clamp(d)), which can sit metres away from
      // lastSafe.xyz where the drone was heading: glide from the carried pose instead of popping.
      this.settle.set(this.root.position.x - px, this.root.position.y - py, this.root.position.z - pz);
      this.settleYaw = wrapAngle(this.root.rotation.y - yaw);
      if (this.settle.lengthSq() > 400) { this.settle.set(0, 0, 0); this.settleYaw = 0; } // teleport, not a drop
    }
    if (this.settle.lengthSq() > 1e-6 || Math.abs(this.settleYaw) > 1e-4) {
      const f = Math.exp(-d * 7);
      this.settle.multiplyScalar(f);
      this.settleYaw *= f;
      px += this.settle.x; py += this.settle.y; pz += this.settle.z;
      yaw += this.settleYaw;
    }
    this.root.position.set(px, py, pz);
    this.root.rotation.set(pitch, yaw, roll, 'YXZ');

    // ── derived motion ──
    const speed = k.speed;
    const sf = clamp(Math.abs(speed) / Math.max(8, k.maxSpeed), 0, 1.25);
    const accRaw = d > 0 ? (speed - this.prevSpeed) / d : 0;
    this.accel += (clamp(accRaw, -60, 60) - this.accel) * Math.min(1, d * 6);
    this.prevSpeed = speed;

    // landing / hop / hit transitions
    if (!k.grounded) this.airT += d;
    if (k.grounded && !this.wasGrounded && this.airT > 0.1 && k.respawnTime <= 0) {
      const impact = Math.min(1.6, this.airT);
      this.sqS.v -= 1.1 + impact * 2.4;
      this.bobS.v -= 0.8 + impact * 1.6;
    }
    if (k.grounded) { this.airT = 0; if (k.respawnTime <= 0) this.groundY = py; }
    this.wasGrounded = k.grounded;
    if (k.hopTime > this.prevHop + 0.05) this.sqS.v += 2.4;
    this.prevHop = k.hopTime;
    if (k.spinTime > this.prevSpin + 0.05) {
      this.spinStart = Math.max(0.2, k.spinTime);
      // squash hits start the spin timer at PHYS.squashTime (1.6 s) vs PHYS.spinTime (1.05 s)
      this.squashHit = k.spinTime > SQUASH_DETECT;
      this.spinDir = -this.spinDir;
      if (this.squashHit) this.sqS.v -= 7;
    }
    if (k.spinTime <= 0) this.squashHit = false;
    this.prevSpin = k.spinTime;
    if (k.tumbleTime > this.prevTumble + 0.05) this.tumbleStart = Math.max(0.3, k.tumbleTime);
    this.prevTumble = k.tumbleTime;
    if (k.trickTime > this.prevTrick + 0.05) { this.trickStart = Math.max(0.2, k.trickTime); this.trickVariant = (this.trickVariant + 1) % 3; }
    this.prevTrick = k.trickTime;
    if (k.finished && !this.wasFinished) this.finishCheer = k.position <= 3 ? 3.2 : 0;
    this.wasFinished = k.finished;
    this.finishCheer = Math.max(0, this.finishCheer - d);

    // ── squash & stretch + shrink springs ──
    const sqTarget = this.squashHit && k.spinTime > 0.22 ? -0.64 : 0;
    this.sqS.step(sqTarget, 170, 11, d, -0.7, 0.45);
    const shTarget = k.shrinkTime > 0 ? 0.55 : 1;
    this.shS.step(shTarget, 95, 8.5, d, 0.35, 1.3);
    const sxz = this.sh * (1 - this.sq * 0.45);
    this.scaler.scale.set(sxz, this.sh * (1 + this.sq), sxz);

    // ── pivot rotations: spin-out, tumble, trick ──
    let rx = 0, ry = 0, rz = 0;
    if (k.spinTime > 0 && !this.squashHit) {
      const p = clamp(1 - k.spinTime / this.spinStart, 0, 1);
      ry = this.spinDir * Math.PI * 4 * easeOutCubic(p);
    } else if (this.squashHit && k.spinTime > 0) {
      ry = Math.sin(t * 16) * 0.07 * (k.spinTime / 1.6);
    }
    if (k.tumbleTime > 0) {
      const p = clamp(1 - k.tumbleTime / this.tumbleStart, 0, 1);
      rx = Math.PI * 2 * easeInOutCubic(clamp(p / 0.78, 0, 1));
      ry += this.spinDir * Math.PI * 0.6 * easeOutCubic(p);
    }
    let trickCheer = 0;
    if (k.trickTime > 0) {
      const p = clamp(1 - k.trickTime / this.trickStart, 0, 1);
      const e = easeInOut(p);
      if (this.trickVariant === 0) ry += Math.PI * 2 * e * (this.seed % 2 ? 1 : -1);
      else if (this.trickVariant === 1) rz = Math.PI * 2 * e;
      else rx -= Math.PI * 2 * e;
      trickCheer = Math.sin(p * Math.PI);
    }
    this.pivot.rotation.set(rx, ry, rz, 'YXZ');

    // ── chassis: suspension, lean, pitch ──
    const bob = this.bobS.step(0, 230, 15, d, -0.4, 0.4);
    const onRoad = k.grounded && k.respawnTime <= 0;
    const rough = k.surface === 'dirt' || k.surface === 'mud' ? 2.4 : 1;
    let rumble = onRoad ? (Math.sin(t * 31 + this.seed) * 0.005 + Math.sin(t * 19.7) * 0.004) * sf * rough : 0;
    if (opts.throttle && Math.abs(speed) < 2 && k.stallTime <= 0) rumble += Math.sin(t * 95) * 0.004;
    if (k.stallTime > 0) rumble += Math.sin(t * 40) * 0.01 * (hash(Math.floor(t * 12)) > 0.5 ? 1 : 0.3);
    const drift = k.driftDir;
    if (drift !== 0 && onRoad) rumble += Math.abs(Math.sin(t * 13)) * 0.012;
    this.chassis.position.y = bob + rumble;
    this.chassis.rotation.x = clamp(-this.accel * 0.0032, -0.07, 0.06);
    this.chassis.rotation.z = -k.steerVisual * Math.min(1, sf) * 0.07 - drift * 0.03;

    // ── wheels & steering ──
    const wheelSpeed = k.respawnTime > 0 ? 2 : speed;
    this.spinR = (this.spinR + (wheelSpeed / RL.r) * d) % (Math.PI * 2);
    this.spinF = (this.spinF + (wheelSpeed / FL.r) * d) % (Math.PI * 2);
    const steerA = k.steerVisual;
    this.setWheels(-steerA * 0.42);
    this.steerMesh.rotation.z = steerA * 1.25;

    // ── driver ──
    const dp = this.dp;
    dp.dt = d; dp.time = t;
    dp.steer = steerA;
    dp.speedFrac = Math.min(1, sf);
    dp.lean = clamp(steerA * Math.min(1, sf) * 1.1 + drift * 0.35, -1, 1);
    dp.accel = this.accel;
    dp.lookBack = opts.lookBack && k.respawnTime <= 0;
    dp.cheer = Math.max(this.cheerForced, trickCheer, this.finishCheer > 0 ? Math.min(1, this.finishCheer * 2) : 0);
    dp.squint = k.spinTime > 0 || k.tumbleTime > 0 || k.stallTime > 0 || (k.respawnTime > 0 && carry === 0);
    const idleTarget = Math.abs(speed) < 0.5 && !opts.throttle ? 1 : 0;
    this.idle += (idleTarget - this.idle) * Math.min(1, d * 2);
    dp.idle = this.idle;
    this.grip(dp.gripL, 1, steerA * 1.25);
    this.grip(dp.gripR, -1, steerA * 1.25);
    this.driver.update(dp);

    // ── effects ──
    this.updateFlames(k, t, d);
    this.updateSparks(k, t, d);
    this.updateSmoke(k, opts, t, d);
    this.updateStar(k, t);
    this.updateShell(k, t, d);
    this.updateDrone(k, t, d, carry);
    this.updateHeld(k, t, d);

    // invulnerability blink (not while starred / rocketing)
    const blink = k.invulnTime > 0 && k.starTime <= 0 && k.autopilotTime <= 0 && k.respawnTime <= 0;
    this.kartGroup.visible = !blink || Math.floor(t * 18) % 3 !== 0;

    // contact shadow
    const h = k.grounded && k.respawnTime <= 0 ? 0 : Math.max(0, py - this.groundY);
    const vis = !this.ghost && k.respawnTime <= 0 && h < 12;
    this.shadow.visible = vis;
    if (vis) {
      const s = 1 / (1 + h * 0.3);
      this.shadow.position.y = 0.035 - h;
      this.shadow.scale.set(s * this.sh * (1 + Math.max(0, -this.sq) * 0.4), 1, s * this.sh);
      this.shadowOpacity = (this.castShadows ? 0.42 : 0.7) * s;
      this.shadowMat.opacity = this.shadowOpacity * (1 - this.lensAmount);
    }
  }

  /** Hand target on the steering-wheel rim (chassis space). */
  private grip(out: THREE.Vector3, side: number, phi: number): void {
    const R = KART_LAYOUT.wheelRadius, a = KART_LAYOUT.wheelTilt;
    const lx = side * R * 0.82, ly = R * 0.57;
    const c = Math.cos(phi), s = Math.sin(phi);
    const x = lx * c - ly * s, y = lx * s + ly * c;
    out.set(x, y * Math.cos(a), y * Math.sin(a)).add(KART_LAYOUT.wheelHub);
  }

  private updateFlames(k: KartState, t: number, d: number): void {
    const boosting = k.boostTime > 0 && k.autopilotTime <= 0 && k.respawnTime <= 0;
    const target = boosting ? Math.min(1, k.boostTime / 0.12) : 0;
    this.flameAmt += (target - this.flameAmt) * Math.min(1, d * (boosting ? 22 : 12));
    const on = this.flameAmt > 0.03;
    this.flames.visible = on;
    if (!on) return;
    const kind: BoostKind | 'star' = k.starTime > 0 ? 'star' : (k.boostKind ?? 'nitro');
    if (kind === 'star') {
      _col.setHSL((t * 1.6) % 1, 1, 0.55);
      _col2.setHSL((t * 1.6 + 0.15) % 1, 0.6, 0.85);
      colorFlame(this.flameGeo, this.fx.flameOuterCount, _col, _col2);
      this.flameCol.copy(_col);
      this.flameKind = 'star';
    } else if (kind !== this.flameKind) {
      const [o, c] = BOOST_COLORS[kind];
      colorFlame(this.flameGeo, this.fx.flameOuterCount, _col.set(o), _col2.set(c));
      this.flameCol.copy(_col);
      this.flameKind = kind;
    }
    const strength = kind === 'star' ? 1.1 : BOOST_STRENGTH[kind as BoostKind] ?? 1;
    for (let i = 0; i < KART_LAYOUT.exhaust.length; i++) {
      const n1 = hash(Math.floor(t * 40) + i * 17), n2 = hash(Math.floor(t * 40) + i * 31 + 5);
      const len = (0.5 + 0.34 * strength) * this.flameAmt * (0.8 + 0.4 * n1);
      const w = (0.19 + 0.07 * strength) * (0.85 + 0.3 * n2) * (0.7 + 0.3 * this.flameAmt);
      _m.compose(KART_LAYOUT.exhaust[i]!, FLAME_Q, _sc.set(w, w, len));
      this.flames.setMatrixAt(i, _m);
    }
    this.flames.instanceMatrix.needsUpdate = true;
    getFlameTexture().offset.x = (t * 2.3) % 1;
  }

  private spawn(ps: Particle[], from: number, to: number): Particle | null {
    for (let i = from; i < to; i++) if (ps[i]!.life <= 0) return ps[i]!;
    return null;
  }

  private updateSparks(k: KartState, t: number, d: number): void {
    const ps = this.sparkP;
    const drifting = k.driftDir !== 0 && (k.grounded || k.hopTime > 0) && k.respawnTime <= 0;
    const level = k.driftLevel;
    const col = DRIFT_COLORS[level]!;
    const rate = this.q.particles;
    // pinned glows: 0,1 coloured drift flares, 2,3 white-hot cores, 4,5 exhaust glows
    for (let i = 0; i < 4; i++) {
      const f = ps[i]!;
      if (drifting) {
        const side = i % 2 === 0 ? 1 : -1;
        const core = i >= 2;
        f.life = 1; f.max = 1;
        f.x = side * RL.x; f.y = 0.22; f.z = RL.z - (core ? 0.44 : 0.4);
        const base = level === 0 ? 0.42 : 0.9 + level * 0.2;
        const n = hash(Math.floor(t * 28) + i * 7);
        f.size = (core ? base * 0.42 : base) * (0.75 + 0.5 * n);
        // cores stay tinted: near-white cores washed every level out to the same white blob
        if (core) { f.r = 0.55 + col.r * 0.45; f.g = 0.55 + col.g * 0.45; f.b = 0.55 + col.b * 0.45; f.a = 1; }
        else { f.r = col.r; f.g = col.g; f.b = col.b; f.a = level === 0 ? 0.7 : 1; }
      } else f.life = 0;
    }
    const boostGlow = this.flameAmt > 0.05;
    for (let i = 4; i < 6; i++) {
      const f = ps[i]!;
      if (boostGlow) {
        const e = KART_LAYOUT.exhaust[i - 4]!;
        f.life = 1; f.max = 1;
        f.x = e.x; f.y = e.y + 0.02 + this.chassis.position.y; f.z = e.z - 0.08;
        // big enough to read from the chase camera, which sees the flame cones end-on
        // (not larger: under night bloom a ~1 m additive glow per nozzle merged into one white blob)
        f.size = (0.66 + 0.24 * hash(Math.floor(t * 30) + i)) * this.flameAmt;
        f.r = this.flameCol.r; f.g = this.flameCol.g; f.b = this.flameCol.b; f.a = 0.85;
      } else f.life = 0;
    }
    if (drifting) {
      this.sparkEmit += d * (level === 0 ? 24 : 40 + level * 16) * rate;
      while (this.sparkEmit >= 1) {
        this.sparkEmit -= 1;
        const p = this.spawn(ps, PINNED, SPARK_N);
        if (!p) break;
        const side = hash(t * 91 + this.sparkEmit) > 0.5 ? 1 : -1;
        const r1 = hash(t * 13.3 + side + this.sparkEmit), r2 = hash(t * 7.7 + side * 3 + this.sparkEmit), r3 = hash(t * 5.1 + 9 + this.sparkEmit);
        p.x = side * RL.x + (r1 - 0.5) * 0.25; p.y = 0.1; p.z = RL.z - 0.38;
        p.vx = side * (0.2 + r1 * 1.1) * (r3 > 0.3 ? 1 : -1); p.vy = 1.3 + r2 * 2.4; p.vz = -(1.4 + r3 * 2.6);
        p.max = p.life = 0.18 + r2 * 0.2;
        p.size = level === 0 ? 0.14 : 0.2 + r1 * 0.16; p.grow = -0.25;
        const white = r3 > 0.55 ? 0.6 : 0.1;
        p.r = col.r + (1 - col.r) * white; p.g = col.g + (1 - col.g) * white; p.b = col.b + (1 - col.b) * white; p.a = 1;
      }
    }
    // star sparkles
    if (k.starTime > 0) {
      this.starEmit += d * 30 * rate;
      while (this.starEmit >= 1) {
        this.starEmit -= 1;
        const p = this.spawn(ps, PINNED, SPARK_N);
        if (!p) break;
        const r1 = hash(t * 17.1 + this.starEmit), r2 = hash(t * 3.9 + 1), r3 = hash(t * 11.7 + 2);
        p.x = (r1 - 0.5) * 1.7; p.y = 0.25 + r2 * 1.4; p.z = (r3 - 0.5) * 2.2;
        p.vx = 0; p.vy = 0.6; p.vz = -0.8;
        p.max = p.life = 0.45;
        p.size = 0.22 + r2 * 0.2; p.grow = -0.3;
        _col.setHSL(r1, 1, 0.62);
        p.r = _col.r; p.g = _col.g; p.b = _col.b; p.a = 1;
      }
    }
    this.flushParticles(this.sparks, ps, d, 7, PINNED);
  }

  private updateSmoke(k: KartState, opts: KartVisualOptions, t: number, d: number): void {
    const ps = this.smokeP;
    const rate = this.q.particles;
    if (k.stallTime > 0) {
      this.smokeEmit += d * 14 * rate;
      while (this.smokeEmit >= 1) {
        this.smokeEmit -= 1;
        const p = this.spawn(ps, 0, SMOKE_N);
        if (!p) break;
        const r1 = hash(t * 9.1 + this.smokeEmit), r2 = hash(t * 4.3 + 7);
        p.x = (r1 - 0.5) * 0.3; p.y = 0.86; p.z = -0.8;
        p.vx = (r2 - 0.5) * 0.6; p.vy = 1.1 + r1 * 0.6; p.vz = -0.4;
        p.max = p.life = 0.9 + r2 * 0.4; p.size = 0.35; p.grow = 1.0;
        const g = 0.32 + r1 * 0.12;
        p.r = g; p.g = g; p.b = g * 1.05; p.a = 0.75;
      }
    } else if (opts.throttle && Math.abs(k.speed) < 2.5 && k.respawnTime <= 0 && k.autopilotTime <= 0) {
      this.smokeEmit += d * 9 * rate;
      while (this.smokeEmit >= 1) {
        this.smokeEmit -= 1;
        const p = this.spawn(ps, 0, SMOKE_N);
        if (!p) break;
        const e = KART_LAYOUT.exhaust[hash(t * 5.5) > 0.5 ? 0 : 1]!;
        const r1 = hash(t * 8.3 + 3);
        p.x = e.x; p.y = e.y + 0.04; p.z = e.z - 0.05;
        p.vx = (r1 - 0.5) * 0.4; p.vy = 0.7; p.vz = -1.2;
        p.max = p.life = 0.45; p.size = 0.16; p.grow = 0.7;
        p.r = 0.92; p.g = 0.92; p.b = 0.95; p.a = 0.45;
      }
    }
    this.flushParticles(this.smoke, ps, d, -1.2, 0);
  }

  /** Integrate particles and write the point buffers. Hides the Points when idle. */
  private flushParticles(pts: THREE.Points, ps: Particle[], d: number, gravity: number, pinnedCount: number): void {
    const g = pts.geometry;
    const pos = g.attributes.position!.array as Float32Array;
    const colA = g.attributes.color!.array as Float32Array;
    const size = g.attributes.psize!.array as Float32Array;
    let any = false;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      const pinned = i < pinnedCount;
      if (p.life > 0 && !pinned) {
        p.life -= d;
        p.vy -= gravity * d;
        p.x += p.vx * d; p.y += p.vy * d; p.z += p.vz * d;
        p.size = Math.max(0, p.size + p.grow * d);
      }
      if (p.life > 0) {
        any = true;
        const a = pinned ? p.a : p.a * clamp(p.life / p.max, 0, 1);
        pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
        colA[i * 4] = p.r; colA[i * 4 + 1] = p.g; colA[i * 4 + 2] = p.b; colA[i * 4 + 3] = a;
        size[i] = p.size;
      } else {
        size[i] = 0; colA[i * 4 + 3] = 0;
      }
    }
    pts.visible = any;
    if (any) {
      g.attributes.position!.needsUpdate = true;
      g.attributes.color!.needsUpdate = true;
      g.attributes.psize!.needsUpdate = true;
    }
  }

  private updateStar(k: KartState, t: number): void {
    const u = paintUniforms(this.paintMat);
    if (!u) return;
    const star = k.starTime > 0;
    if (star) {
      const ending = k.starTime < 1.2;
      u.uStar.value = ending ? (Math.floor(t * 9) % 2 === 0 ? 0.9 : 0.25) : 0.85 + 0.15 * Math.sin(t * 20);
      u.uStarTime.value = t;
      this.starWas = true;
    } else if (this.starWas) {
      u.uStar.value = 0;
      this.starWas = false;
    }
  }

  private updateShell(k: KartState, t: number, d: number): void {
    const target = k.autopilotTime > 0 ? 1 : 0;
    if (target === 0 && this.shellAmt < 0.001 && !this.shell?.visible) return;
    if (!this.shell) this.buildShell();
    const shell = this.shell!;
    this.shellS.step(target, 160, 12, d, 0, 1.25);
    const vis = this.shellAmt > 0.02;
    shell.visible = vis;
    const hideKart = this.shellAmt > 0.55 && target > 0;
    this.bodyMesh.visible = !hideKart;
    this.wheels.visible = !hideKart;
    this.steerMesh.visible = !hideKart;
    if (!vis) return;
    const s = this.shellAmt;
    shell.scale.setScalar(s);
    shell.position.y = Math.sin(t * 20) * 0.015;
    shell.rotation.z = Math.sin(t * 3.1) * 0.04;
    const f = this.shellFlame!;
    const n = hash(Math.floor(t * 40));
    f.scale.set(0.75 * (0.9 + 0.2 * n), 0.75 * (0.9 + 0.2 * n), 2.4 * (0.85 + 0.3 * hash(Math.floor(t * 40) + 3)));
    f.visible = target > 0;
  }

  private buildShell(): void {
    const g = new THREE.Group();
    this.shellMat = createPaintMaterial(this.atlas);
    const su = paintUniforms(this.shellMat), ku = paintUniforms(this.paintMat);
    if (su && ku) su.uNearFade = ku.uNearFade; // (before its first compile) fades with the kart
    if (this.nearFadeOn) setNearFadeEnabled(this.shellMat, true);
    this.shellMat.side = THREE.DoubleSide;
    if (this.ghost) { this.shellMat.transparent = true; this.shellMat.opacity = 0.42; }
    const hull = new THREE.Mesh(this.fx.shell, this.shellMat);
    g.add(hull);
    this.shellFlameMat = createAdditiveMaterial(getFlameTexture());
    const fl = new THREE.Mesh(this.fx.shellFlame, this.shellFlameMat);
    fl.position.set(0, SHELL_AXIS_Y, -1.5);
    fl.frustumCulled = false;
    g.add(fl);
    this.shellFlame = fl;
    this.inner.add(g);
    this.shell = g;
    this.applyShadowFlags(g);
  }

  private updateDrone(k: KartState, t: number, d: number, carry: number): void {
    const active = k.respawnTime > 0 || this.droneLeave >= 0;
    if (!active) { if (this.drone) this.drone.visible = false; return; }
    if (!this.drone) this.buildDrone();
    const dr = this.drone!;
    dr.visible = true;
    let y = 2.3 + Math.sin(t * 4) * 0.05;
    let s = 1;
    if (k.respawnTime > 0) {
      const p = clamp(1 - k.respawnTime / PHYS.respawnTime, 0, 1);
      if (p < 0.16) y += (1 - easeOutCubic(p / 0.16)) * 6;
      void carry;
    } else {
      this.droneLeave += d;
      const q = this.droneLeave / 0.8;
      y += easeInOut(Math.min(1, q)) * 7;
      s = 1 - Math.max(0, q - 0.4) / 0.6;
      if (q >= 1) { this.droneLeave = -1; dr.visible = false; return; }
    }
    dr.position.set(0, y, 0);
    dr.rotation.set(Math.sin(t * 2.3) * -0.06, 0, Math.sin(t * 3.1) * -0.1);
    dr.scale.setScalar(Math.max(0.01, s));
    // rotors
    const r = this.droneRotors!;
    const a = t * 38;
    for (let i = 0; i < 4; i++) {
      const ang = Math.PI / 4 + (i * Math.PI) / 2;
      _e.set(0, a * (i % 2 ? 1 : -1) + i, 0);
      _q.setFromEuler(_e);
      _m.compose(_v.set(Math.sin(ang) * 0.62, 0.14, Math.cos(ang) * 0.62), _q, _sc.set(1, 1, 1));
      r.setMatrixAt(i, _m);
    }
    r.instanceMatrix.needsUpdate = true;
  }

  private buildDrone(): void {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.fx.drone, this.paintMat);
    g.add(body);
    const rot = new THREE.InstancedMesh(this.fx.rotor, this.paintInstMat, 4);
    rot.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    rot.frustumCulled = false;
    g.add(rot);
    this.droneBlurMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, vertexColors: true });
    g.add(new THREE.Mesh(this.fx.blur, this.droneBlurMat));
    this.root.add(g);
    this.drone = g;
    this.droneRotors = rot;
    this.applyShadowFlags(g);
  }

  private updateHeld(k: KartState, t: number, d: number): void {
    const used = this.heldUsed;
    used.banana = 0; used.orb = 0; used.rocket = 0;
    const held = k.held;
    // orbiting shields are spread evenly over however many remain (3 → 120°, 2 → 180°)
    let orbitN = 0;
    for (let i = 0; i < held.length; i++) if (held[i]!.slot > 0 && held[i]!.kind !== 'banana') orbitN++;
    let orbitI = 0;
    if (orbitN > 0) this.orbitSpread += ((Math.PI * 2) / orbitN - this.orbitSpread) * Math.min(1, d * 8);
    for (let i = 0; i < held.length; i++) {
      const h = held[i]!;
      const pool = this.heldPool[h.kind];
      let o = pool[used[h.kind]];
      if (!o) {
        o = createHeldItemMesh(h.kind);
        this.heldGroup.add(o);
        pool.push(o);
        this.applyShadowFlags(o);
      }
      used[h.kind]++;
      o.visible = true;
      const trailing = h.slot === 0 || h.kind === 'banana';
      if (trailing) {
        const n = h.kind === 'banana' ? h.slot : 0;
        const sway = Math.sin(t * 4.2 + n * 1.3) * 0.06;
        const hy = h.kind === 'banana' ? 0.05 + Math.abs(Math.sin(t * 6 + n)) * 0.03 : 0.48 + Math.sin(t * 5) * 0.03;
        o.position.set(sway + k.steerVisual * 0.18 * n, hy, -1.35 - n * 0.62);
        o.rotation.set(Math.sin(t * 5 + n) * 0.12, Math.sin(t * 2 + n) * 0.3, Math.sin(t * 3.3 + n) * 0.1);
        if (h.kind === 'orb') o.rotation.x = -t * 6;
        if (h.kind === 'rocket') o.rotation.set(0, 0, Math.sin(t * 6) * 0.15);
      } else {
        const a = t * 3.4 + (orbitI++) * this.orbitSpread;
        o.position.set(Math.sin(a) * 1.6, 0.45 + Math.sin(t * 5 + h.slot) * 0.06, Math.cos(a) * 1.6);
        if (h.kind === 'rocket') o.rotation.set(0, a + Math.PI / 2, 0);
        else o.rotation.set(t * 5, a, 0);
      }
    }
    for (const kind of HELD_KINDS) {
      const pool = this.heldPool[kind];
      for (let i = used[kind]; i < pool.length; i++) pool[i]!.visible = false;
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    kartCache.release(`${this.charId}:${this.lod}`);
    fxCache.release('fx');
    releaseCharacterAtlas(this.charId);
    this.flameGeo.dispose();
    this.sparks.geometry.dispose();
    this.smoke.geometry.dispose();
    for (const m of [this.paintMat, this.paintInstMat, this.unlitMat, this.flameMat, this.sparkMat, this.smokeMat, this.shadowMat,
      this.shellMat, this.shellFlameMat, this.droneBlurMat]) m?.dispose();
    this.wheels.dispose();
    this.flames.dispose();
    this.merged?.dispose();
    this.droneRotors?.dispose();
    this.driver.dispose();
    for (const pool of Object.values(this.heldPool)) {
      for (const o of pool) (o.userData.release as (() => void) | undefined)?.();
    }
  }
}

let visualSeed = 0;

/**
 * Build a kart + driver visual for a character. Static geometry is cached (ref-counted) per character and
 * tier. The geometry tier follows `quality.level` unless `opts.lod` overrides it (e.g. a close-up showroom
 * that wants the reference model on a low-tier device).
 */
export function createKartVisual(charId: CharacterId, quality: RenderQuality, opts: { lod?: KartLod } = {}): KartVisual & KartVisualExtras {
  return new KartVisualImpl(charId, quality, ++visualSeed, opts.lod ?? quality.level);
}

/** A neutral KartState for menus/showrooms/previews (parked, grounded, no effects). */
export function createDisplayKartState(charId: CharacterId, index = 0): KartState {
  return {
    index, charId, human: -1,
    x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, vy: 0, speed: 0, grounded: true, airTime: 0,
    pitch: 0, roll: 0, driftAngle: 0, steerVisual: 0,
    ti: 0, s: 0, d: 0, progress: 0, lap: 0, lapStartTick: 0, lapTicks: [], finished: false, finishTick: -1,
    position: index + 1, wrongWay: false, lastSafe: { x: 0, y: 0, z: 0, yaw: 0, i: 0, progress: 0 },
    surface: 'road',
    driftDir: 0, driftCharge: 0, driftLevel: 0, hopTime: 0,
    boostTime: 0, boostKind: null, trickReady: false, trickPending: false, trickTime: 0,
    spinTime: 0, tumbleTime: 0, shrinkTime: 0, starTime: 0, inkTime: 0, autopilotTime: 0,
    invulnTime: 0, respawnTime: 0, stallTime: 0,
    item: null, itemUses: 0, rouletteTime: 0, held: [], holding: false, coins: 0,
    prevDrift: false, prevItem: false, throttle: false, throttleStartTick: -1,
    maxSpeed: 29, accel: 14, turnRate: 2.25, mass: 1, speedScale: 1, hitTimer: 99,
  };
}
