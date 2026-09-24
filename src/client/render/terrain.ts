/**
 * Shared terrain generator for theme scenery.
 *
 * A vertex-coloured height-field that meets the track corridor: close to the
 * road it sits just below the road/shoulder mesh; further away it blends into
 * rolling procedural hills. Near sections whose edge is a 'pit' (bridges over
 * water/lava/chasms/space) the ground falls away. Where the track crosses
 * itself, the LOWEST nearby road wins so under-passes are never buried.
 */
import * as THREE from 'three';
import { Rng } from '../../sim/rng.js';
import type { BuiltTrack } from '../../sim/types.js';

export interface TerrainOptions {
  /** Colours for the vertex gradient. */
  ground: string;
  groundAlt: string;
  /** Hill amplitude far from the track (m). */
  hills?: number;
  /** Extra distance around the track bounds (m). */
  margin?: number;
  /** Grid cell size (m). */
  cell?: number;
  /** How far below the road the ground drops at 'pit' edges (m). */
  pitDepth?: number;
  seed?: number;
  /** Flat terrain height far from the track (defaults to the track's lowest point − 1). */
  baseHeight?: number;
  /** Colour applied where the terrain drops into pits. */
  pitColor?: string;
}

export interface Terrain {
  readonly mesh: THREE.Mesh;
  /** Terrain height at world XZ (same function used to build the mesh). */
  heightAt(x: number, z: number): number;
  /** Distance (m) from XZ to the nearest track centreline sample, and that sample's index. */
  nearestTrack(x: number, z: number): { dist: number; i: number };
  /** True when XZ lies inside any track corridor (between barriers) — keep props out. */
  inCorridor(x: number, z: number, pad?: number): boolean;
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  dispose(): void;
}

/** Spatial hash of centreline samples for fast nearest queries. */
class SampleGrid {
  private readonly cell = 24;
  private readonly map = new Map<number, number[]>();
  constructor(private readonly t: BuiltTrack) {
    for (let i = 0; i < t.n; i += 2) {
      const key = this.key(Math.floor(t.px[i]! / this.cell), Math.floor(t.pz[i]! / this.cell));
      let arr = this.map.get(key);
      if (!arr) { arr = []; this.map.set(key, arr); }
      arr.push(i);
    }
  }
  private key(cx: number, cz: number): number { return (cx + 4096) * 8192 + (cz + 4096); }
  /** Samples within `radius` (m). */
  near(x: number, z: number, radius: number, out: number[]): number[] {
    out.length = 0;
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const arr = this.map.get(this.key(cx + dx, cz + dz));
        if (arr) for (const i of arr) out.push(i);
      }
    }
    return out;
  }
}

function hash2(x: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const fx = x - xi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(xi, zi, seed), b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed), d = hash2(xi + 1, zi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x: number, z: number, seed: number, octaves = 4): number {
  let amp = 0.5, freq = 1, sum = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * (valueNoise(x * freq, z * freq, seed + o * 1013) * 2 - 1);
    amp *= 0.5; freq *= 2.03;
  }
  return sum;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export function buildTerrain(track: BuiltTrack, opts: TerrainOptions): Terrain {
  const margin = opts.margin ?? 320;
  const cell = opts.cell ?? 5;
  const hills = opts.hills ?? 14;
  const pitDepth = opts.pitDepth ?? 30;
  const seed = opts.seed ?? track.def.scenerySeed;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity;
  for (let i = 0; i < track.n; i++) {
    minX = Math.min(minX, track.px[i]!); maxX = Math.max(maxX, track.px[i]!);
    minZ = Math.min(minZ, track.pz[i]!); maxZ = Math.max(maxZ, track.pz[i]!);
    minY = Math.min(minY, track.py[i]!);
  }
  const base = opts.baseHeight ?? minY - 1;
  minX -= margin; maxX += margin; minZ -= margin; maxZ += margin;
  const grid = new SampleGrid(track);
  const scratch: number[] = [];

  const corridorInfo = (x: number, z: number) => {
    const cand = grid.near(x, z, 90, scratch);
    let bestDist = Infinity, bestI = -1;
    let roadH = Infinity; // lowest road height whose corridor is near
    let blend = 0;       // 1 = hug the road, 0 = free terrain
    let pit = 0;
    for (const i of cand) {
      const dx = x - track.px[i]!, dz = z - track.pz[i]!;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < bestDist) { bestDist = dist; bestI = i; }
      const rx = track.rx[i]!, rz = track.rz[i]!;
      const rh = Math.sqrt(rx * rx + rz * rz) || 1;
      const side = (dx * rx + dz * rz) / rh;
      const wall = side >= 0 ? track.wallR[i]! : track.wallL[i]!;
      const edge = side >= 0 ? track.edgeR[i]! : track.edgeL[i]!;
      const influence = 1 - smooth(wall + 2, wall + 55, dist);
      if (influence <= 0) continue;
      if (edge === 2) {
        pit = Math.max(pit, 1 - smooth(track.hw[i]! + 1, track.hw[i]! + 40, dist));
      }
      if (dist < wall + 55) {
        // road / verge surface at this lateral offset: on a banked road the low edge (and its flat verge) sits
        // up to ry·hw below the centreline, so a plain py − 0.35 poked grass through the low side of the curve
        const hwi = track.hw[i]!;
        const h = track.py[i]! + track.ry[i]! * Math.max(-hwi, Math.min(hwi, side)) - 0.35;
        if (h < roadH) roadH = h;
        if (influence > blend) blend = influence;
      }
    }
    return { bestDist, bestI, roadH, blend, pit };
  };

  const heightFrom = (x: number, z: number, c: ReturnType<typeof corridorInfo>): number => {
    const free = base + hills * (0.55 * fbm(x / 220, z / 220, seed, 4) + 0.45 * Math.max(0, fbm(x / 90, z / 90, seed + 7, 3)))
      + hills * 1.6 * smooth(0.25, 1, Math.max(0, fbm(x / 400, z / 400, seed + 31, 2)));
    if (c.roadH === Infinity) return free;
    // never rise above the road next to it
    const freeNear = Math.min(free, c.roadH + 6);
    let h = c.roadH * c.blend + freeNear * (1 - c.blend);
    if (c.pit > 0) h -= pitDepth * c.pit;
    return h;
  };
  const heightAt = (x: number, z: number): number => heightFrom(x, z, corridorInfo(x, z));

  const nx = Math.ceil((maxX - minX) / cell), nz = Math.ceil((maxZ - minZ) / cell);
  const geo = new THREE.PlaneGeometry(nx * cell, nz * cell, nx, nz);
  geo.rotateX(-Math.PI / 2);
  geo.translate(minX + (nx * cell) / 2, 0, minZ + (nz * cell) / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const cA = new THREE.Color(opts.ground), cB = new THREE.Color(opts.groundAlt);
  const cPit = new THREE.Color(opts.pitColor ?? opts.ground).multiplyScalar(0.6);
  const tmp = new THREE.Color();
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v), z = pos.getZ(v);
    const c = corridorInfo(x, z);
    pos.setY(v, heightFrom(x, z, c));
    const n = 0.5 + 0.5 * fbm(x / 35, z / 35, seed + 99, 3);
    tmp.copy(cA).lerp(cB, n);
    if (c.pit > 0.05) tmp.lerp(cPit, Math.min(1, c.pit * 1.2));
    const shade = 0.92 + 0.08 * fbm(x / 9, z / 9, seed + 5, 2);
    colors[v * 3] = tmp.r * shade; colors[v * 3 + 1] = tmp.g * shade; colors[v * 3 + 2] = tmp.b * shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';

  const inCorridor = (x: number, z: number, pad = 2): boolean => {
    const cand = grid.near(x, z, 60, scratch);
    for (const i of cand) {
      const dx = x - track.px[i]!, dz = z - track.pz[i]!;
      const rx = track.rx[i]!, rz = track.rz[i]!;
      const rh = Math.sqrt(rx * rx + rz * rz) || 1;
      const side = (dx * rx + dz * rz) / rh;
      const along = Math.abs(dx * track.tx[i]! + dz * track.tz[i]!);
      const wall = side >= 0 ? track.wallR[i]! : track.wallL[i]!;
      if (along < 3 && Math.abs(side) < wall + pad) return true;
    }
    return false;
  };

  return {
    mesh,
    heightAt,
    nearestTrack(x, z) {
      const c = corridorInfo(x, z);
      if (c.bestI >= 0) return { dist: c.bestDist, i: c.bestI };
      // far away: brute force
      let best = Infinity, bi = 0;
      for (let i = 0; i < track.n; i += 4) {
        const d = (x - track.px[i]!) ** 2 + (z - track.pz[i]!) ** 2;
        if (d < best) { best = d; bi = i; }
      }
      return { dist: Math.sqrt(best), i: bi };
    },
    inCorridor,
    bounds: { minX, maxX, minZ, maxZ },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

/** Deterministic scatter helper for props: returns candidate points outside the corridor. */
export function scatter(
  terrain: Terrain, count: number, seed: number,
  opts: { minDist?: number; maxDist?: number; pad?: number } = {},
): Array<{ x: number; y: number; z: number; r: number; s: number }> {
  const rng = new Rng(seed);
  const out: Array<{ x: number; y: number; z: number; r: number; s: number }> = [];
  const { minX, maxX, minZ, maxZ } = terrain.bounds;
  const minD = opts.minDist ?? 0, maxD = opts.maxDist ?? Infinity;
  let guard = count * 12;
  while (out.length < count && guard-- > 0) {
    const x = rng.range(minX, maxX), z = rng.range(minZ, maxZ);
    const near = terrain.nearestTrack(x, z);
    if (near.dist < minD || near.dist > maxD) continue;
    if (terrain.inCorridor(x, z, opts.pad ?? 3)) continue;
    out.push({ x, y: terrain.heightAt(x, z), z, r: rng.range(0, Math.PI * 2), s: rng.range(0.75, 1.3) });
  }
  return out;
}
