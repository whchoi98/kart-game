/**
 * Shared procedural canvas texture generators (no image assets).
 *
 * Every generator returns a NEW texture; the caller owns it and must dispose it.
 * Textures are sRGB colour maps unless noted (data maps such as roughness use
 * NoColorSpace). Canvas sizes stay <= 1024 px. Randomness is seeded so the
 * same inputs always produce the same pixels.
 */
import * as THREE from 'three';
import type { ThemeId } from '../../sim/types.js';
import { THEME_PALETTES } from './theme-palette.js';

// ───────────────────────────── helpers ─────────────────────────────

/** Small seeded PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    let t = (s = (s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  // CPU-backed canvas: the generators read pixels back (grain, alpha shaping) and upload once, so a GPU
  // canvas only adds readback stalls (measured: cold road texture 1.2 s → 30 ms under SwiftShader).
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  return { canvas, ctx };
}

export interface TexOptions {
  repeat?: boolean;          // RepeatWrapping on both axes (default true)
  srgb?: boolean;            // colour map (default true)
  anisotropy?: number;       // default 8
  mipmaps?: boolean;         // default true
}

export function toTexture(canvas: HTMLCanvasElement, o: TexOptions = {}): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  const rep = o.repeat ?? true;
  t.wrapS = t.wrapT = rep ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.colorSpace = (o.srgb ?? true) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = o.anisotropy ?? 8;
  t.generateMipmaps = o.mipmaps ?? true;
  t.minFilter = t.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

// THREE.Color(hex) converts to linear working space; convert back to sRGB bytes.
function srgbBytes(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  const o = { r: 0, g: 0, b: 0 };
  c.getRGB(o, THREE.SRGBColorSpace);
  return [Math.round(o.r * 255), Math.round(o.g * 255), Math.round(o.b * 255)];
}

export function shade(hex: string, k: number): string {
  const [r, g, b] = srgbBytes(hex);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(k >= 1 ? v + (255 - v) * (k - 1) : v * k)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
export function mixHex(a: string, b: string, t: number): string {
  const A = srgbBytes(a), B = srgbBytes(b);
  const m = (i: number) => Math.round(A[i]! + (B[i]! - A[i]!) * t);
  return `rgb(${m(0)},${m(1)},${m(2)})`;
}
export function rgba(hex: string, a: number): string {
  const [r, g, b] = srgbBytes(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Per-pixel value noise overlay (multiplicative brightness jitter). */
function grain(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number, rnd: () => number, x0 = 0, y0 = 0): void {
  const img = ctx.getImageData(x0, y0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = 1 + (rnd() - 0.5) * 2 * amount;
    d[i] = Math.min(255, d[i]! * n); d[i + 1] = Math.min(255, d[i + 1]! * n); d[i + 2] = Math.min(255, d[i + 2]! * n);
  }
  ctx.putImageData(img, x0, y0);
}

/** Soft blotches (wrap-aware so tiling is seamless). */
function blotches(ctx: CanvasRenderingContext2D, w: number, h: number, count: number, rMin: number, rMax: number,
  color: (i: number) => string, rnd: () => number, stretchX = 1, stretchY = 1): void {
  for (let i = 0; i < count; i++) {
    const x = rnd() * w, y = rnd() * h, r = rMin + rnd() * (rMax - rMin);
    const col = color(i);
    for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) {
      const cx = x + ox, cy = y + oy;
      if (cx + r * stretchX < 0 || cx - r * stretchX > w || cy + r * stretchY < 0 || cy - r * stretchY > h) continue;
      ctx.save();
      ctx.translate(cx, cy); ctx.scale(stretchX, stretchY);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    }
  }
}

// ───────────────────────────── road ─────────────────────────────

export interface RoadTextures {
  map: THREE.CanvasTexture;
  /** Glow for markings / glass lanes (night themes). */
  emissiveMap: THREE.CanvasTexture | null;
  /** Data map: markings smoother than asphalt. */
  roughnessMap: THREE.CanvasTexture | null;
  /** Metres along the track covered by one texture repeat. */
  repeatLength: number;
}

/**
 * Road surface: canvas X = across the road (u 0 = left edge, 1 = right edge),
 * canvas Y = along the track (one repeat = `repeatLength` metres).
 */
export function createRoadTextures(theme: ThemeId): RoadTextures {
  const pal = THEME_PALETTES[theme];
  const W = 1024, H = 512;
  const rnd = seededRandom(0x51ad + theme.length * 977);
  const { canvas, ctx } = makeCanvas(W, H);
  const rough = makeCanvas(W, H);
  const glow = (theme === 'city' || theme === 'galaxy' || theme === 'volcano') ? makeCanvas(W, H) : null;
  const rc = rough.ctx;
  rc.fillStyle = 'rgb(210,210,210)'; rc.fillRect(0, 0, W, H);
  if (glow) { glow.ctx.fillStyle = '#000'; glow.ctx.fillRect(0, 0, W, H); }

  const edgeU = 0.035, edgeW = 0.018;     // edge line position/width (fraction of width)

  if (theme === 'galaxy') {
    // Translucent space glass: deep indigo, hex-ish lane grid, rainbow edge.
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, shade(pal.road, 1.25)); g.addColorStop(0.5, pal.road); g.addColorStop(1, shade(pal.road, 1.25));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    blotches(ctx, W, H, 26, 30, 110, () => rgba(pal.roadAlt, 0.55), rnd, 1, 1.6);
    // sparkles (stars seen through the glass)
    for (let i = 0; i < 380; i++) {
      const x = rnd() * W, y = rnd() * H, s = rnd() < 0.1 ? 2.2 : 1.1;
      ctx.fillStyle = `rgba(255,255,255,${0.35 + rnd() * 0.5})`;
      ctx.fillRect(x, y, s, s);
    }
    const gc = glow!.ctx;
    // the glass itself glows faintly, brighter toward the lanes' centres
    const gb = gc.createLinearGradient(0, 0, W, 0);
    gb.addColorStop(0, shade(pal.roadAlt, 0.55)); gb.addColorStop(0.5, shade(pal.roadAlt, 0.3)); gb.addColorStop(1, shade(pal.roadAlt, 0.55));
    gc.fillStyle = gb; gc.fillRect(0, 0, W, H);
    blotches(gc, W, H, 22, 30, 120, () => rgba(pal.roadAlt, 0.5), rnd, 1, 1.8);
    for (let i = 0; i < 260; i++) {
      const x = rnd() * W, y = rnd() * H;
      gc.fillStyle = `rgba(255,255,255,${0.25 + rnd() * 0.6})`;
      gc.fillRect(x, y, rnd() < 0.12 ? 2.4 : 1.2, rnd() < 0.12 ? 2.4 : 1.2);
    }
    // lane lines (3 lanes) + cross tiles
    for (const u of [1 / 3, 2 / 3]) {
      for (const c of [ctx, gc]) {
        c.fillStyle = c === ctx ? 'rgba(160,230,255,0.9)' : 'rgba(90,180,255,0.9)';
        for (let y = 0; y < H; y += 128) c.fillRect(u * W - 3, y + 8, 6, 80);
      }
    }
    for (const c of [ctx, gc]) {
      c.strokeStyle = c === ctx ? 'rgba(140,120,255,0.35)' : 'rgba(110,80,255,0.55)';
      c.lineWidth = 2;
      for (let y = 0; y <= H; y += 64) { c.beginPath(); c.moveTo(0.08 * W, y); c.lineTo(0.92 * W, y); c.stroke(); }
    }
    // rainbow edges
    const hues = ['#ff3b6b', '#ff9a3b', '#ffe63b', '#4dff7a', '#3bd8ff', '#5b6bff', '#c64bff'];
    const bandFrac = 0.045;
    const bandW = (bandFrac * W) / hues.length;
    hues.forEach((h, k) => {
      for (const c of [ctx, gc]) {
        c.globalAlpha = c === gc ? 0.6 : 1;
        c.fillStyle = h;
        c.fillRect(k * bandW, 0, bandW + 0.5, H);
        c.fillRect(W - (k + 1) * bandW, 0, bandW + 0.5, H);
        c.globalAlpha = 1;
      }
    });
    for (const c of [ctx, gc]) {
      c.fillStyle = c === gc ? 'rgba(200,220,255,0.55)' : 'rgba(255,255,255,0.9)';
      c.fillRect(bandFrac * W, 0, 3, H); c.fillRect(W - bandFrac * W - 3, 0, 3, H);
    }
    rc.fillStyle = 'rgb(40,40,40)'; rc.fillRect(0, 0, W, H);
    return {
      map: toTexture(canvas), emissiveMap: toTexture(glow!.canvas),
      roughnessMap: toTexture(rough.canvas, { srgb: false }), repeatLength: 8,
    };
  }

  if (theme === 'jungle') {
    // Weathered flagstone paving with moss in the joints.
    ctx.fillStyle = shade(pal.road, 0.7); ctx.fillRect(0, 0, W, H);
    const rows = 11, rowH = H / rows;
    for (let r = 0; r < rows; r++) {
      let x = -rnd() * 60;
      while (x < W) {
        const w = 44 + rnd() * 56;
        const tone = 0.86 + rnd() * 0.28;
        ctx.fillStyle = shade(rnd() < 0.5 ? pal.road : pal.roadAlt, tone);
        const pad = 4;
        ctx.beginPath();
        ctx.roundRect(x + pad, r * rowH + pad, w - pad * 2, rowH - pad * 2, 8);
        ctx.fill();
        // highlight top edge
        ctx.fillStyle = 'rgba(255,255,240,0.08)';
        ctx.fillRect(x + pad + 4, r * rowH + pad + 2, w - pad * 2 - 8, 5);
        x += w;
      }
    }
    blotches(ctx, W, H, 60, 6, 26, () => 'rgba(70,120,40,0.55)', rnd);
    grain(ctx, W, H, 0.1, rnd);
    rc.fillStyle = 'rgb(225,225,225)'; rc.fillRect(0, 0, W, H);
  } else if (theme === 'volcano') {
    // Dark basalt slabs; a few joints glow with ember heat.
    const gc = glow!.ctx;
    ctx.fillStyle = '#141011'; ctx.fillRect(0, 0, W, H);
    const rows = 8, rowH = H / rows;
    for (let r = 0; r < rows; r++) {
      let x = -rnd() * 80;
      while (x < W) {
        const w = 70 + rnd() * 80;
        const pad = 3;
        ctx.fillStyle = shade(rnd() < 0.5 ? pal.road : pal.roadAlt, 0.85 + rnd() * 0.3);
        ctx.beginPath(); ctx.roundRect(x + pad, r * rowH + pad, w - pad * 2, rowH - pad * 2, 6); ctx.fill();
        ctx.fillStyle = 'rgba(255,220,200,0.05)';
        ctx.fillRect(x + pad + 3, r * rowH + pad + 2, w - pad * 2 - 6, 4);
        if (rnd() < 0.14) {
          // glowing seam on the right joint of this slab
          for (const [c, col, lw] of [[ctx, 'rgba(255,120,40,0.55)', 3], [gc, 'rgba(255,90,20,0.85)', 4]] as const) {
            c.strokeStyle = col; c.lineWidth = lw;
            c.beginPath(); c.moveTo(x + w, r * rowH + pad); c.lineTo(x + w, (r + 1) * rowH - pad); c.stroke();
          }
        }
        x += w;
      }
    }
    blotches(ctx, W, H, 30, 20, 70, () => 'rgba(0,0,0,0.25)', rnd);
    grain(ctx, W, H, 0.14, rnd);
  } else {
    // Asphalt (meadow, beach, canyon, city, snow).
    ctx.fillStyle = pal.road; ctx.fillRect(0, 0, W, H);
    blotches(ctx, W, H, 34, 40, 140, (i) => (i % 3 === 0 ? 'rgba(0,0,0,0.12)' : rgba(pal.roadAlt, 0.5)), rnd, 1.4, 1);
    // repaired patches (rectangular)
    for (let i = 0; i < 3; i++) {
      const w = 60 + rnd() * 120, h = 40 + rnd() * 90, x = 0.12 * W + rnd() * 0.66 * W, y = rnd() * (H - h);
      ctx.fillStyle = rgba(rnd() < 0.5 ? pal.roadAlt : shade(pal.road, 0.88), 0.3);
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 6); ctx.fill();
    }
    // tyre-worn racing lanes (darker streaks along the track)
    for (const u of [0.3, 0.42, 0.58, 0.7]) {
      const g = ctx.createLinearGradient((u - 0.05) * W, 0, (u + 0.05) * W, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(0,0,0,0.12)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect((u - 0.05) * W, 0, 0.1 * W, H);
    }
    // aggregate speckle
    for (let i = 0; i < 9000; i++) {
      const x = rnd() * W, y = rnd() * H;
      ctx.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.16)';
      ctx.fillRect(x, y, 1.5, 1.5);
    }
    // fine cracks
    ctx.strokeStyle = 'rgba(0,0,0,0.16)'; ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      // start high enough that the crack (≤150 px long) never runs off the tile edge (seam every 8 m)
      let x = 0.1 * W + rnd() * 0.8 * W, y = rnd() * (H - 160);
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let k = 0; k < 5; k++) { x += (rnd() - 0.5) * 40; y += rnd() * 30; ctx.lineTo(x, y); }
      ctx.stroke();
    }
    grain(ctx, W, H, 0.07, rnd);
    if (theme === 'city' && glow) {
      // wet asphalt: glossy puddles and soft neon reflections smeared along the travel direction
      const gc = glow.ctx;
      // faint city-glow ambience so the asphalt never goes pitch black under the night sky
      gc.fillStyle = 'rgb(30,27,52)'; gc.fillRect(0, 0, W, H);
      // soft-edged glossy puddles (roughness only dips gently so they never read as hard discs)
      blotches(rc, W, H, 12, 40, 90, () => 'rgba(120,120,120,0.75)', rnd, 0.7, 1.9);
      blotches(ctx, W, H, 12, 40, 90, () => 'rgba(16,12,34,0.22)', rnd, 0.7, 1.9);
      const neon = [pal.curbA, pal.curbB, pal.barrierB];
      // Fewer, broader and softer streaks: thin bright ones aliased into pink "confetti" at kart-eye angles.
      for (let i = 0; i < 30; i++) {
        const nearEdge = i < 22;
        const side = i % 2;
        const u = nearEdge ? 0.07 + rnd() * 0.11 : 0.28 + rnd() * 0.44;
        const x = side && nearEdge ? W - u * W : u * W;
        const y = rnd() * H, w = nearEdge ? 12 + rnd() * 18 : 22 + rnd() * 26, h = 110 + rnd() * 170;
        const colr = nearEdge ? pal.barrierB : neon[Math.floor(rnd() * neon.length)]!;
        // one alpha for all wrapped copies, so a streak crossing the tile edge has no seam
        const a = nearEdge ? 0.2 + rnd() * 0.18 : 0.06 + rnd() * 0.07;
        for (const oy of [-H, 0, H]) {
          const sg = gc.createLinearGradient(0, y + oy, 0, y + oy + h);
          sg.addColorStop(0, rgba(colr, 0)); sg.addColorStop(0.5, rgba(colr, a)); sg.addColorStop(1, rgba(colr, 0));
          gc.fillStyle = sg; gc.fillRect(x - w / 2, y + oy, w, h);
        }
      }
    }
    if (theme === 'beach' || theme === 'snow' || theme === 'canyon') {
      // drifted sand / snow dust / red dust at the edges
      const dust = theme === 'beach' ? '#f2d49b' : theme === 'snow' ? '#ffffff' : '#d9895b';
      for (const side of [0, 1]) {
        const g = ctx.createLinearGradient(side ? W : 0, 0, side ? W - 0.12 * W : 0.12 * W, 0);
        g.addColorStop(0, rgba(dust, theme === 'snow' ? 0.55 : 0.45)); g.addColorStop(1, rgba(dust, 0));
        ctx.fillStyle = g; ctx.fillRect(side ? W - 0.12 * W : 0, 0, 0.12 * W, H);
      }
      // wind-blown drifts hugging the edges only
      for (let i = 0; i < 26; i++) {
        const side = i % 2;
        const x = side ? W - rnd() * 0.1 * W : rnd() * 0.1 * W, y = rnd() * H, r = 8 + rnd() * 26;
        for (const oy of [-H, 0, H]) {
          ctx.save(); ctx.translate(x, y + oy); ctx.scale(1, 2.6);
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
          g.addColorStop(0, rgba(dust, 0.35)); g.addColorStop(1, rgba(dust, 0));
          ctx.fillStyle = g; ctx.fillRect(-r, -r, 2 * r, 2 * r); ctx.restore();
        }
      }
    }
  }

  // Markings (not on galaxy): edge lines + dashed centre line (1 dash per repeat).
  const line = pal.roadLine;
  const drawMarks = (c: CanvasRenderingContext2D, col: string, worn: boolean) => {
    c.fillStyle = col;
    c.fillRect(edgeU * W, 0, edgeW * W, H);
    c.fillRect((1 - edgeU - edgeW) * W, 0, edgeW * W, H);
    const dashW = theme === 'city' ? 0.014 : 0.012;
    if (theme === 'city') {
      // two-lane city road: double centre line + dashed lane dividers
      c.fillRect((0.5 - 0.016) * W, 0, dashW * W, H);
      c.fillRect((0.5 + 0.002) * W, 0, dashW * W, H);
      for (const u of [0.26, 0.74]) c.fillRect((u - 0.006) * W, H * 0.1, 0.012 * W, H * 0.38);
    } else {
      c.fillRect((0.5 - dashW / 2) * W, H * 0.12, dashW * W, H * 0.4);
    }
    if (worn) {
      // chip the paint a little
      c.save(); c.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 500; i++) { c.fillStyle = `rgba(0,0,0,${0.3 + rnd() * 0.5})`; c.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 3, 2 + rnd() * 3); }
      c.restore();
    }
  };
  const marks = makeCanvas(W, H);
  drawMarks(marks.ctx, line, true);
  ctx.globalAlpha = theme === 'jungle' ? 0.75 : 0.95;
  ctx.drawImage(marks.canvas, 0, 0);
  ctx.globalAlpha = 1;
  // markings are smoother (reflective paint)
  rc.globalAlpha = 1; drawMarks(rc, theme === 'city' ? 'rgb(40,40,40)' : 'rgb(120,120,120)', false);
  if (glow && theme === 'city') { glow.ctx.globalAlpha = 0.55; drawMarks(glow.ctx, line, false); glow.ctx.globalAlpha = 1; }

  return {
    map: toTexture(canvas),
    emissiveMap: glow ? toTexture(glow.canvas) : null,
    roughnessMap: toTexture(rough.canvas, { srgb: false }),
    repeatLength: 8,
  };
}

// ───────────────────────────── ground / shoulders ─────────────────────────────

/** Tileable off-road ground (grass, sand, dirt, snow, ash, space dust). 4 m × 4 m per repeat. */
export function createGroundTexture(theme: ThemeId): THREE.CanvasTexture {
  const pal = THEME_PALETTES[theme];
  const S = 512;
  const rnd = seededRandom(0x9e11 + theme.charCodeAt(0) * 31);
  const { canvas, ctx } = makeCanvas(S, S);
  ctx.fillStyle = pal.ground; ctx.fillRect(0, 0, S, S);
  blotches(ctx, S, S, 34, 40, 150, () => rgba(pal.groundAlt, 0.42), rnd);
  blotches(ctx, S, S, 16, 50, 120, () => 'rgba(0,0,0,0.045)', rnd);
  if (theme === 'meadow' || theme === 'jungle') {
    // grass blades
    for (let i = 0; i < 5000; i++) {
      const x = rnd() * S, y = rnd() * S, l = 4 + rnd() * 7;
      ctx.strokeStyle = rnd() < 0.5 ? rgba(pal.groundAlt, 0.7) : 'rgba(20,70,20,0.35)';
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rnd() - 0.5) * 3, y - l); ctx.stroke();
    }
    if (theme === 'meadow') {
      // tiny flowers
      const cols = ['#ffffff', '#ffe066', '#ff8fab'];
      for (let i = 0; i < 70; i++) {
        const x = rnd() * S, y = rnd() * S;
        ctx.fillStyle = cols[i % 3]!;
        ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
      }
    }
  } else if (theme === 'beach' || theme === 'canyon') {
    // ripples + pebbles
    ctx.strokeStyle = 'rgba(120,80,40,0.12)'; ctx.lineWidth = 2;
    for (let y = 0; y < S; y += 18) {
      ctx.beginPath();
      for (let x = 0; x <= S; x += 16) ctx.lineTo(x, y + Math.sin((x / S) * Math.PI * 4 + y) * 4); // periodic in x (2 waves per tile)
      ctx.stroke();
    }
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.25)' : 'rgba(90,50,20,0.25)';
      ctx.beginPath(); ctx.arc(rnd() * S, rnd() * S, 1 + rnd() * 2.5, 0, Math.PI * 2); ctx.fill();
    }
  } else if (theme === 'snow') {
    for (let i = 0; i < 1500; i++) {
      ctx.fillStyle = rnd() < 0.6 ? 'rgba(255,255,255,0.9)' : 'rgba(150,190,225,0.35)';
      ctx.fillRect(rnd() * S, rnd() * S, 2, 2);
    }
  } else {
    // city pavement / volcanic ash / space dust: grit
    for (let i = 0; i < 4000; i++) {
      ctx.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.2)';
      ctx.fillRect(rnd() * S, rnd() * S, 1.6, 1.6);
    }
    if (theme === 'city') {
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 3;
      for (let k = 0; k <= S; k += 128) {
        ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(k, S); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, k); ctx.lineTo(S, k); ctx.stroke();
      }
    }
  }
  grain(ctx, S, S, 0.08, rnd);
  return toTexture(canvas);
}

/**
 * Embankment / cliff face under raised verges and at chasm edges. X = along the track (8 m per repeat),
 * Y = world height (6 m per repeat), so strata stay horizontal. Themed: red rock strata (canyon), snowy
 * rock (snow), grassy bank with exposed soil (meadow), mossy ruin blocks (jungle), layered sandstone
 * (beach), concrete retaining wall (city), basalt with hot cracks (volcano), crystal (galaxy).
 */
export function createCliffTexture(theme: ThemeId): THREE.CanvasTexture {
  const pal = THEME_PALETTES[theme];
  const S = 512;
  const rnd = seededRandom(0xc11f + theme.charCodeAt(1) * 71);
  const { canvas, ctx } = makeCanvas(S, S);
  const strata = (cols: string[], wobble: number, minH: number, maxH: number) => {
    // consecutive bands share their boundary curve, so there are no gaps between them
    ctx.fillStyle = shade(cols[0]!, 0.8); ctx.fillRect(0, 0, S, S);
    const edge = (ph: number, fr: number, x: number) => Math.sin((x / S) * Math.PI * 2 * fr + ph) * wobble;
    let y = 0, k = 0;
    let ph0 = rnd() * 6.28, fr0 = 1 + Math.floor(rnd() * 3);
    while (y < S) {
      const h = Math.min(minH + rnd() * (maxH - minH), S - y);
      const last = y + h >= S - 1;
      // the top boundary of the last band must match the bottom of the first (vertical tiling)
      const ph1 = last ? 0 : rnd() * 6.28, fr1 = last ? 1 : 1 + Math.floor(rnd() * 3);
      const w1 = last ? 0 : 1;
      const col = cols[k++ % cols.length]!;
      ctx.fillStyle = shade(col, 0.9 + rnd() * 0.2);
      ctx.beginPath();
      for (let x = 0; x <= S; x += 16) ctx.lineTo(x, S - y - (y === 0 ? 0 : edge(ph0, fr0, x)));
      for (let x = S; x >= 0; x -= 16) ctx.lineTo(x, S - y - h - edge(ph1, fr1, x) * w1);
      ctx.closePath(); ctx.fill();
      // lit ledge + shadowed underside at the band's top boundary
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,240,220,0.16)';
      ctx.beginPath();
      for (let x = 0; x <= S; x += 16) ctx.lineTo(x, S - y - h - edge(ph1, fr1, x) * w1 + 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.14)';
      ctx.beginPath();
      for (let x = 0; x <= S; x += 16) ctx.lineTo(x, S - y - h - edge(ph1, fr1, x) * w1 - 2);
      ctx.stroke();
      ph0 = ph1; fr0 = fr1;
      y += h;
    }
  };
  const cracks = (count: number, col: string, width: number) => {
    ctx.strokeStyle = col; ctx.lineWidth = width; ctx.lineCap = 'round';
    for (let i = 0; i < count; i++) {
      let x = rnd() * S, y = rnd() * S;
      ctx.beginPath(); ctx.moveTo(x, y);
      const len = 3 + Math.floor(rnd() * 5);
      for (let k = 0; k < len; k++) { x += (rnd() - 0.5) * 18; y += 10 + rnd() * 18; ctx.lineTo(x, y); }
      ctx.stroke();
    }
  };
  const blocks = (a: string, b: string, rows: number, mortar: string) => {
    ctx.fillStyle = mortar; ctx.fillRect(0, 0, S, S);
    const rh = S / rows;
    for (let r = 0; r < rows; r++) {
      let x = r % 2 ? -rh * 0.7 : 0;
      while (x < S) {
        const w = rh * (1.1 + rnd() * 1.1);
        const fill = shade(rnd() < 0.55 ? a : b, 0.82 + rnd() * 0.3); // same colour for the wrapped copy
        for (const ox of [0, S]) {
          ctx.fillStyle = fill;
          ctx.beginPath(); ctx.roundRect(x + 4 - ox, r * rh + 4, w - 8, rh - 8, 10); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(x + 10 - ox, r * rh + 7, w - 20, 5);
          ctx.fillStyle = 'rgba(0,0,0,0.16)'; ctx.fillRect(x + 10 - ox, (r + 1) * rh - 12, w - 20, 5);
        }
        x += w;
      }
    }
  };
  switch (theme) {
    case 'canyon':
      strata(['#b5532f', '#cf7444', '#a44a2a', '#dd935f', '#bd6036', '#e7a577'], 7, 18, 64);
      cracks(26, 'rgba(70,25,10,0.35)', 2.5);
      blotches(ctx, S, S, 24, 20, 70, () => 'rgba(90,40,20,0.18)', rnd, 1.6, 1);
      break;
    case 'beach':
      strata(['#e7cf9f', '#d9b98a', '#efdcb4', '#cfae7c', '#f4e4c1'], 5, 14, 46);
      for (let i = 0; i < 90; i++) { ctx.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.5)' : 'rgba(150,110,70,0.35)'; ctx.beginPath(); ctx.arc(rnd() * S, rnd() * S, 1.5 + rnd() * 3, 0, Math.PI * 2); ctx.fill(); }
      break;
    case 'snow':
      strata(['#7d8ea3', '#8e9fb4', '#6f7f95', '#9aabbf'], 12, 50, 120);
      cracks(16, 'rgba(40,50,70,0.35)', 3);
      // snow caught on ledges
      for (let i = 0; i < 14; i++) {
        const x = rnd() * S, y = rnd() * S, w = 40 + rnd() * 120;
        for (const ox of [-S, 0, S]) {
          const g = ctx.createLinearGradient(0, y - 8, 0, y + 10);
          g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.35, 'rgba(250,253,255,0.95)'); g.addColorStop(1, 'rgba(210,230,245,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x + ox, y, w / 2, 9, 0, 0, Math.PI * 2); ctx.fill();
        }
      }
      break;
    case 'meadow': {
      ctx.fillStyle = '#8a5a3a'; ctx.fillRect(0, 0, S, S);
      strata(['#8a5a3a', '#7a4e32', '#96673f'], 6, 20, 50);
      blotches(ctx, S, S, 40, 30, 110, () => rgba(pal.ground, 0.85), rnd, 1.6, 1);
      blotches(ctx, S, S, 30, 20, 60, () => rgba(pal.groundAlt, 0.6), rnd, 1.4, 1);
      for (let i = 0; i < 120; i++) { ctx.fillStyle = rnd() < 0.5 ? '#a9a39a' : '#8c867c'; ctx.beginPath(); ctx.ellipse(rnd() * S, rnd() * S, 3 + rnd() * 6, 2 + rnd() * 4, 0, 0, Math.PI * 2); ctx.fill(); }
      break;
    }
    case 'jungle':
      blocks('#8d8b7d', '#6b6a5c', 5, '#3e3c33');
      blotches(ctx, S, S, 50, 14, 50, () => 'rgba(60,110,40,0.6)', rnd, 1.5, 1);
      for (let i = 0; i < 40; i++) {
        // hanging vines
        const x = rnd() * S, y = rnd() * S, l = 30 + rnd() * 80;
        ctx.strokeStyle = 'rgba(40,110,40,0.7)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + (rnd() - 0.5) * 20, y + l / 2, x + (rnd() - 0.5) * 10, y + l); ctx.stroke();
      }
      break;
    case 'city': {
      ctx.fillStyle = '#5d6275'; ctx.fillRect(0, 0, S, S);
      blotches(ctx, S, S, 30, 30, 100, () => 'rgba(30,32,45,0.25)', rnd, 1, 2);
      ctx.fillStyle = 'rgba(20,22,32,0.6)';
      for (let x = 0; x < S; x += 128) ctx.fillRect(x, 0, 4, S);
      for (let y = 0; y < S; y += 256) ctx.fillRect(0, y, S, 4);
      // rain streaks
      for (let i = 0; i < 70; i++) { ctx.fillStyle = 'rgba(20,20,30,0.18)'; ctx.fillRect(rnd() * S, rnd() * S, 3, 30 + rnd() * 90); }
      break;
    }
    case 'volcano':
      strata(['#2e2624', '#3b3230', '#252020', '#443a37'], 6, 20, 60);
      cracks(18, 'rgba(255,110,30,0.55)', 2);
      cracks(30, 'rgba(0,0,0,0.4)', 2);
      break;
    default: {
      const g = ctx.createLinearGradient(0, 0, S, S);
      g.addColorStop(0, '#2a1f66'); g.addColorStop(0.5, '#4b2fa0'); g.addColorStop(1, '#1b1446');
      ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
      ctx.strokeStyle = 'rgba(160,220,255,0.35)'; ctx.lineWidth = 2;
      for (let i = 0; i < 30; i++) { ctx.beginPath(); ctx.moveTo(rnd() * S, rnd() * S); ctx.lineTo(rnd() * S, rnd() * S); ctx.stroke(); }
    }
  }
  grain(ctx, S, S, 0.07, rnd);
  return toTexture(canvas);
}

// ───────────────────────────── curbs / markings ─────────────────────────────

/** Rumble strip: X = across (0 inner .. 1 outer), Y = along; two stripes per repeat. */
export function createCurbTexture(a: string, b: string): THREE.CanvasTexture {
  const W = 64, H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  for (let k = 0; k < 2; k++) {
    ctx.fillStyle = k ? b : a;
    ctx.fillRect(0, k * H / 2, W, H / 2);
    // ridges
    for (let y = 0; y < H / 2; y += 16) {
      ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(0, k * H / 2 + y + 11, W, 5);
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(0, k * H / 2 + y, W, 3);
    }
  }
  // bevel shading on the inner lip and outer edge
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(0,0,0,0.25)'); g.addColorStop(0.18, 'rgba(0,0,0,0)');
  g.addColorStop(0.85, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.2)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  return toTexture(canvas);
}

/** Black/white checker, 2 × 2 squares per repeat. */
export function createCheckerTexture(a = '#141414', b = '#f7f7f7'): THREE.CanvasTexture {
  const S = 128;
  const { canvas, ctx } = makeCanvas(S, S);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    ctx.fillStyle = (x + y) % 2 ? a : b; ctx.fillRect(x * S / 2, y * S / 2, S / 2, S / 2);
  }
  const rnd = seededRandom(77);
  grain(ctx, S, S, 0.05, rnd);
  const t = toTexture(canvas);
  t.magFilter = THREE.NearestFilter;
  return t;
}

/** Chevron arrows pointing toward +Y (texture v increases along travel). */
export function createChevronTexture(base: string, stripe: string, opts: { count?: number; glow?: boolean } = {}): THREE.CanvasTexture {
  const W = 256, H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.fillStyle = base; ctx.fillRect(0, 0, W, H);
  const count = opts.count ?? 2;
  const step = H / count;
  for (let k = 0; k < count; k++) {
    const y0 = k * step;
    ctx.fillStyle = stripe;
    ctx.beginPath();
    // chevron: tip at high y (forward)
    ctx.moveTo(W * 0.08, y0 + step * 0.1);
    ctx.lineTo(W * 0.5, y0 + step * 0.62);
    ctx.lineTo(W * 0.92, y0 + step * 0.1);
    ctx.lineTo(W * 0.92, y0 + step * 0.42);
    ctx.lineTo(W * 0.5, y0 + step * 0.94);
    ctx.lineTo(W * 0.08, y0 + step * 0.42);
    ctx.closePath();
    ctx.fill();
  }
  if (opts.glow) {
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.35)'); g.addColorStop(0.2, 'rgba(255,255,255,0)');
    g.addColorStop(0.8, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,0.35)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  return toTexture(canvas);
}

/** Boost-pad arrows (bright on dark), pointing toward +Y when flipY = false. */
export function createBoostArrowTexture(color: string, rails = true): THREE.CanvasTexture {
  const W = 256, H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.fillStyle = mixHex('#15131f', color, 0.18); ctx.fillRect(0, 0, W, H);
  // side rails
  if (rails) for (const x of [W * 0.03, W * 0.91]) {
    ctx.fillStyle = shade(color, 1.2); ctx.fillRect(x, 0, W * 0.06, H);
  }
  for (let k = 0; k < 2; k++) {
    const y0 = k * H / 2;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(W * 0.16, y0 + H * 0.06);
      ctx.lineTo(W * 0.5, y0 + H * 0.3);
      ctx.lineTo(W * 0.84, y0 + H * 0.06);
      ctx.lineTo(W * 0.84, y0 + H * 0.2);
      ctx.lineTo(W * 0.5, y0 + H * 0.44);
      ctx.lineTo(W * 0.16, y0 + H * 0.2);
      ctx.closePath();
    };
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = 18;
    const g = ctx.createLinearGradient(0, y0, 0, y0 + H * 0.44);
    g.addColorStop(0, shade(color, 0.95)); g.addColorStop(1, shade(color, 1.7));
    ctx.fillStyle = g; path(); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 4; path(); ctx.stroke();
  }
  return toTexture(canvas);
}

/**
 * Trick / boost ramp surface: vivid panel in `color` with bright chevrons (two per repeat) and lane rails.
 * Chevrons point toward +Y when flipY = false. The emissive map lights the chevrons fully and the panel dimly.
 */
export function createBoostRampTextures(color: string): { map: THREE.CanvasTexture; emissiveMap: THREE.CanvasTexture } {
  const W = 256, H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  const glow = makeCanvas(W, H);
  const gc = glow.ctx;
  // panel: vivid centre, deeper toward the rails
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, shade(color, 0.62)); g.addColorStop(0.5, shade(color, 1.05)); g.addColorStop(1, shade(color, 0.62));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const gg = gc.createLinearGradient(0, 0, W, 0);
  gg.addColorStop(0, shade(color, 0.12)); gg.addColorStop(0.5, shade(color, 0.36)); gg.addColorStop(1, shade(color, 0.12));
  gc.fillStyle = gg; gc.fillRect(0, 0, W, H);
  // lane rails with hazard ticks
  for (const x0 of [0, W - 16]) {
    for (const c of [ctx, gc]) {
      c.fillStyle = c === ctx ? '#23252f' : '#000000'; c.fillRect(x0, 0, 16, H);
      c.fillStyle = c === ctx ? '#ffffff' : shade(color, 0.7);
      for (let y = 0; y < H; y += 32) c.fillRect(x0 + 4, y + 4, 8, 16);
    }
  }
  const chevron = (c: CanvasRenderingContext2D, y0: number) => {
    c.beginPath();
    c.moveTo(W * 0.14, y0 + H * 0.04);
    c.lineTo(W * 0.5, y0 + H * 0.3);
    c.lineTo(W * 0.86, y0 + H * 0.04);
    c.lineTo(W * 0.86, y0 + H * 0.2);
    c.lineTo(W * 0.5, y0 + H * 0.46);
    c.lineTo(W * 0.14, y0 + H * 0.2);
    c.closePath();
  };
  for (let k = 0; k < 2; k++) {
    const y0 = k * H / 2;
    // Chevrons stay tinted (pure white + wide halos averaged to cream at grazing kart-eye angles).
    ctx.save();
    ctx.shadowColor = rgba(color, 0.9); ctx.shadowBlur = 8;
    const cg = ctx.createLinearGradient(0, y0, 0, y0 + H * 0.46);
    cg.addColorStop(0, mixHex(color, '#fff4c0', 0.55)); cg.addColorStop(1, mixHex(color, '#ffffff', 0.85));
    ctx.fillStyle = cg; chevron(ctx, y0); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = shade(color, 0.38); ctx.lineWidth = 6; chevron(ctx, y0); ctx.stroke();
    gc.save();
    gc.shadowColor = color; gc.shadowBlur = 10;
    gc.fillStyle = mixHex(color, '#ffffff', 0.5); chevron(gc, y0); gc.fill();
    gc.restore();
  }
  return { map: toTexture(canvas), emissiveMap: toTexture(glow.canvas) };
}

/** Radial soft glow (white → transparent), for additive halos. */
export function createGlowTexture(): THREE.CanvasTexture {
  const S = 128;
  const { canvas, ctx } = makeCanvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  return toTexture(canvas, { repeat: false });
}

/** Rectangular soft panel glow: bright centre fading to 0 at the borders (for pads). */
export function createPanelGlowTexture(): THREE.CanvasTexture {
  const S = 128;
  const { canvas, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = Math.abs(x / (S - 1) * 2 - 1), v = Math.abs(y / (S - 1) * 2 - 1);
    const e = Math.max(u, v);
    const a = Math.pow(Math.max(0, 1 - e), 0.8) * (0.55 + 0.45 * (1 - Math.min(1, Math.hypot(u, v))));
    const i = (y * S + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = Math.round(a * 255);
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(canvas, { repeat: false });
}

/** Neon tube pulses along +Y on a dim base (emissive map). */
export function createNeonPulseTexture(): THREE.CanvasTexture {
  const W = 16, H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgb(90,90,90)');
  g.addColorStop(0.55, 'rgb(90,90,90)');
  g.addColorStop(0.78, 'rgb(255,255,255)');
  g.addColorStop(0.84, 'rgb(255,255,255)');
  g.addColorStop(1, 'rgb(90,90,90)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  return toTexture(canvas, { srgb: false });
}

/** Rainbow bands along Y (hue cycle), for galaxy trims. */
export function createRainbowTexture(): THREE.CanvasTexture {
  const W = 8, H = 512;
  const { canvas, ctx } = makeCanvas(W, H);
  for (let y = 0; y < H; y++) {
    ctx.fillStyle = `hsl(${(y / H) * 360}, 100%, 62%)`;
    ctx.fillRect(0, y, W, 1);
  }
  return toTexture(canvas);
}

// ───────────────────────────── barriers ─────────────────────────────

/** Stone blocks: X = along the wall (4 m / repeat), Y = up (1.2 m). Optional glowing mortar; moss patches
 *  by default on non-glowing stone (pass moss = false for snow / volcanic / urban stone). */
export function createStoneTexture(a: string, b: string, glowMortar: boolean, moss = !glowMortar): { map: THREE.CanvasTexture; emissiveMap: THREE.CanvasTexture | null } {
  const W = 512, H = 256;
  const rnd = seededRandom(0x5701 + (glowMortar ? 1 : 0));
  const { canvas, ctx } = makeCanvas(W, H);
  const glow = glowMortar ? makeCanvas(W, H) : null;
  const mortar = glowMortar ? '#1a1212' : shade(b, 0.7);
  ctx.fillStyle = mortar; ctx.fillRect(0, 0, W, H);
  if (glow) {
    // heat from below: mortar glows near the foot of the wall only
    const g = glow.ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#000000'); g.addColorStop(0.55, '#000000'); g.addColorStop(0.8, '#3a1604'); g.addColorStop(1, '#ff7a1a');
    glow.ctx.fillStyle = g; glow.ctx.fillRect(0, 0, W, H);
  }
  const rows = 3, rowH = H / rows;
  const stoneB = glowMortar ? shade(a, 0.8) : b;
  for (let r = 0; r < rows; r++) {
    let x = r % 2 ? -64 : 0;
    while (x < W) {
      const w = 110 + rnd() * 70;
      const tone = 0.8 + rnd() * 0.35;
      const colr = shade(rnd() < 0.6 ? a : stoneB, tone);
      const pad = glowMortar ? 3.5 : 5;
      for (const ox of [0, W]) {
        ctx.fillStyle = colr;
        ctx.beginPath(); ctx.roundRect(x + pad - ox, r * rowH + pad, w - pad * 2, rowH - pad * 2, 14); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x + pad + 6 - ox, r * rowH + pad + 3, w - pad * 2 - 12, 6);
        ctx.fillStyle = 'rgba(0,0,0,0.15)';
        ctx.fillRect(x + pad + 6 - ox, (r + 1) * rowH - pad - 8, w - pad * 2 - 12, 5);
        if (glow) { glow.ctx.fillStyle = '#000'; glow.ctx.beginPath(); glow.ctx.roundRect(x + pad - ox, r * rowH + pad, w - pad * 2, rowH - pad * 2, 14); glow.ctx.fill(); }
      }
      x += w;
    }
  }
  if (moss) blotches(ctx, W, H, 18, 8, 30, () => 'rgba(60,110,40,0.45)', rnd);
  else if (!glowMortar) blotches(ctx, W, H, 14, 10, 34, () => 'rgba(0,0,0,0.12)', rnd); // weathering instead
  grain(ctx, W, H, 0.1, rnd);
  return { map: toTexture(canvas), emissiveMap: glow ? toTexture(glow.canvas) : null };
}

/** Horizontal wooden planks: X = along (4 m), Y = up. */
export function createPlankTexture(wood: string): THREE.CanvasTexture {
  const W = 512, H = 256;
  const rnd = seededRandom(0x3a7c);
  const { canvas, ctx } = makeCanvas(W, H);
  const rows = 4, rowH = H / rows;
  for (let r = 0; r < rows; r++) {
    ctx.fillStyle = shade(wood, 0.85 + rnd() * 0.3);
    ctx.fillRect(0, r * rowH, W, rowH);
    ctx.strokeStyle = 'rgba(60,30,10,0.18)'; ctx.lineWidth = 1.5;
    for (let k = 0; k < 6; k++) {
      const y = r * rowH + 6 + rnd() * (rowH - 12);
      ctx.beginPath(); ctx.moveTo(0, y);
      for (let x = 0; x <= W; x += 32) ctx.lineTo(x, y + Math.sin((x / W) * Math.PI * 4 + k) * 2); // periodic in x (2 waves per tile)
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(40,20,5,0.45)'; ctx.fillRect(0, r * rowH, W, 4);
    ctx.fillStyle = 'rgba(255,240,210,0.18)'; ctx.fillRect(0, r * rowH + 4, W, 3);
    // butt joints + nails
    const jx = (r * 173) % W;
    ctx.fillStyle = 'rgba(40,20,5,0.45)'; ctx.fillRect(jx, r * rowH, 4, rowH);
    ctx.fillStyle = 'rgba(40,40,40,0.7)';
    for (const x of [jx - 10, jx + 14]) { ctx.beginPath(); ctx.arc(x, r * rowH + rowH / 2, 3, 0, Math.PI * 2); ctx.fill(); }
  }
  grain(ctx, W, H, 0.06, rnd);
  return toTexture(canvas);
}

/** Leafy hedge / foliage: tileable. */
export function createLeafTexture(base: string, light: string): THREE.CanvasTexture {
  const S = 256;
  const rnd = seededRandom(0x1eaf);
  const { canvas, ctx } = makeCanvas(S, S);
  ctx.fillStyle = shade(base, 0.7); ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 900; i++) {
    const x = rnd() * S, y = rnd() * S, r = 4 + rnd() * 7;
    ctx.fillStyle = rnd() < 0.5 ? mixHex(base, light, rnd()) : shade(base, 0.8 + rnd() * 0.3);
    const rot = rnd() * Math.PI; // one rotation for all wrapped copies (seamless tiling)
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      if (x + ox + r < 0 || x + ox - r > S || y + oy + r < 0 || y + oy - r > S) continue;
      ctx.beginPath(); ctx.ellipse(x + ox, y + oy, r, r * 0.6, rot, 0, Math.PI * 2); ctx.fill();
    }
  }
  return toTexture(canvas);
}

/** Lumpy snow: white with soft blue shading and sparkles. */
export function createSnowTexture(shadow: string): THREE.CanvasTexture {
  const S = 256;
  const rnd = seededRandom(0x5a0f);
  const { canvas, ctx } = makeCanvas(S, S);
  ctx.fillStyle = '#f7fbff'; ctx.fillRect(0, 0, S, S);
  blotches(ctx, S, S, 30, 12, 50, () => rgba(shadow, 0.28), rnd);
  for (let i = 0; i < 600; i++) {
    ctx.fillStyle = 'rgba(255,255,255,1)'; ctx.fillRect(rnd() * S, rnd() * S, 1.5, 1.5);
  }
  return toTexture(canvas);
}

/** Galvanised W-beam guardrail: X = along, Y = profile. */
export function createMetalTexture(): THREE.CanvasTexture {
  const W = 256, H = 64;
  const rnd = seededRandom(0x3e7a);
  const { canvas, ctx } = makeCanvas(W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#dfe5ea'); g.addColorStop(0.3, '#9aa4ad'); g.addColorStop(0.5, '#eef2f5'); g.addColorStop(0.7, '#98a2ab'); g.addColorStop(1, '#d5dbe0');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  blotches(ctx, W, H, 10, 6, 20, () => 'rgba(80,90,100,0.15)', rnd);
  ctx.fillStyle = 'rgba(40,40,40,0.6)';
  for (const x of [8, 136]) { ctx.beginPath(); ctx.arc(x, H / 2, 3, 0, Math.PI * 2); ctx.fill(); }
  return toTexture(canvas);
}

// ───────────────────────────── surface zones ─────────────────────────────

/** Ice: pale blue with white crack network (alpha via material opacity). */
export function createIceTexture(): THREE.CanvasTexture {
  const S = 512;
  const rnd = seededRandom(0x1ce);
  const { canvas, ctx } = makeCanvas(S, S);
  const g = ctx.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, '#cfefff'); g.addColorStop(0.5, '#a9dcf7'); g.addColorStop(1, '#d8f4ff');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  blotches(ctx, S, S, 20, 30, 90, () => 'rgba(255,255,255,0.35)', rnd, 1.8, 1);
  blotches(ctx, S, S, 12, 20, 70, () => 'rgba(90,160,210,0.25)', rnd);
  const crack = (x: number, y: number, a: number, len: number, depth: number) => {
    ctx.beginPath(); ctx.moveTo(x, y);
    let cx = x, cy = y;
    const steps = 6;
    for (let k = 0; k < steps; k++) {
      a += (rnd() - 0.5) * 0.9;
      cx += Math.cos(a) * len / steps; cy += Math.sin(a) * len / steps;
      ctx.lineTo(cx, cy);
      if (depth > 0 && rnd() < 0.3) { ctx.stroke(); crack(cx, cy, a + (rnd() - 0.5) * 2, len * 0.5, depth - 1); ctx.beginPath(); ctx.moveTo(cx, cy); }
    }
    ctx.stroke();
  };
  ctx.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.6 + rnd() * 1.4;
    crack(rnd() * S, rnd() * S, rnd() * Math.PI * 2, 90 + rnd() * 120, 2);
  }
  ctx.strokeStyle = 'rgba(60,120,170,0.35)'; ctx.lineWidth = 1;
  for (let i = 0; i < 10; i++) crack(rnd() * S, rnd() * S, rnd() * Math.PI * 2, 60 + rnd() * 80, 1);
  return toTexture(canvas);
}

/** Mud: wet dark-brown puddles with alpha (transparent between patches). */
export function createMudTexture(): THREE.CanvasTexture {
  const S = 512;
  const rnd = seededRandom(0x3d0d);
  const { canvas, ctx } = makeCanvas(S, S);
  ctx.clearRect(0, 0, S, S);
  blotches(ctx, S, S, 26, 50, 130, () => 'rgba(66,40,20,0.97)', rnd, 1.3, 1);
  blotches(ctx, S, S, 30, 20, 60, () => 'rgba(52,32,16,0.9)', rnd);
  // harden alpha so patches have crisp, organic edges
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]! / 255;
    const k = Math.min(1, Math.max(0, (a - 0.28) / 0.22));
    d[i + 3] = Math.round(k * 248);
    if (a > 0) { d[i] = Math.min(255, d[i]! / Math.max(a, 0.01)); d[i + 1] = Math.min(255, d[i + 1]! / Math.max(a, 0.01)); d[i + 2] = Math.min(255, d[i + 2]! / Math.max(a, 0.01)); }
  }
  ctx.putImageData(img, 0, 0);
  // glossy highlights
  blotches(ctx, S, S, 18, 6, 20, () => 'rgba(150,120,95,0.35)', rnd, 2, 1);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(canvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  return toTexture(canvas);
}

/** Dirt / sand band: sandy granular with soft alpha noise. */
export function createDirtTexture(): THREE.CanvasTexture {
  const S = 512;
  const rnd = seededRandom(0xd127);
  const { canvas, ctx } = makeCanvas(S, S);
  ctx.fillStyle = '#c89a62'; ctx.fillRect(0, 0, S, S);
  blotches(ctx, S, S, 30, 30, 100, () => 'rgba(226,186,130,0.6)', rnd);
  blotches(ctx, S, S, 30, 20, 60, () => 'rgba(120,80,40,0.25)', rnd, 1, 2);
  // tyre tracks
  ctx.strokeStyle = 'rgba(90,60,30,0.25)'; ctx.lineWidth = 10;
  for (const x of [120, 170, 330, 380]) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.bezierCurveTo(x + 20, S * 0.3, x - 20, S * 0.7, x, S); ctx.stroke(); }
  for (let i = 0; i < 3000; i++) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(255,240,210,0.3)' : 'rgba(80,50,20,0.3)';
    ctx.fillRect(rnd() * S, rnd() * S, 2, 2);
  }
  grain(ctx, S, S, 0.08, rnd);
  return toTexture(canvas);
}

// ───────────────────────────── text / signage ─────────────────────────────

export interface BannerSpec {
  text: string;
  bg: string;
  fg: string;
  /** Outline colour for the lettering. */
  outline?: string;
  /** Decorative end caps: 'checker' | 'stripes' | 'none'. */
  ends?: 'checker' | 'stripes' | 'none';
  sub?: string;
}

export interface BannerAtlas {
  texture: THREE.CanvasTexture;
  /** UV rect (u0, v0, u1, v1) per banner index; aspect 8:1. */
  rects: Array<[number, number, number, number]>;
}

const BANNER_FONT = '"Black Han Sans", "Arial Black", "Helvetica Neue", Arial, sans-serif';

/** Banner atlas: up to 8 rows of 1024×128 banners (8:1). */
export function createBannerAtlas(specs: BannerSpec[]): BannerAtlas {
  const W = 1024, RH = 128;
  const rows = Math.min(8, specs.length);
  const { canvas, ctx } = makeCanvas(W, RH * 8);
  const rects: BannerAtlas['rects'] = [];
  for (let k = 0; k < rows; k++) {
    const sp = specs[k]!;
    const y0 = k * RH;
    // background with rounded inner panel + gloss
    ctx.fillStyle = shade(sp.bg, 0.7); ctx.fillRect(0, y0, W, RH);
    ctx.fillStyle = sp.bg;
    ctx.beginPath(); ctx.roundRect(6, y0 + 6, W - 12, RH - 12, 18); ctx.fill();
    const gl = ctx.createLinearGradient(0, y0, 0, y0 + RH);
    gl.addColorStop(0, 'rgba(255,255,255,0.28)'); gl.addColorStop(0.5, 'rgba(255,255,255,0.02)'); gl.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = gl; ctx.fillRect(6, y0 + 6, W - 12, RH - 12);
    let x0 = 24, x1 = W - 24;
    if (sp.ends === 'checker') {
      const sq = 20;
      for (const side of [0, 1]) {
        const bx = side ? W - 18 - sq * 4 : 18;
        for (let cx = 0; cx < 4; cx++) for (let cy = 0; cy < 5; cy++) {
          ctx.fillStyle = (cx + cy) % 2 ? '#111' : '#fff';
          ctx.fillRect(bx + cx * sq, y0 + 14 + cy * sq, sq, sq);
        }
      }
      x0 = 18 + sq * 4 + 16; x1 = W - 18 - sq * 4 - 16;
    } else if (sp.ends === 'stripes') {
      for (const side of [0, 1]) {
        ctx.save();
        ctx.beginPath(); ctx.rect(side ? W - 90 : 12, y0 + 12, 78, RH - 24); ctx.clip();
        for (let s = -4; s < 8; s++) {
          ctx.fillStyle = s % 2 ? sp.fg : 'rgba(0,0,0,0)';
          ctx.beginPath();
          const bx = (side ? W - 90 : 12) + s * 22;
          ctx.moveTo(bx, y0 + RH); ctx.lineTo(bx + 11, y0 + RH); ctx.lineTo(bx + 11 + RH, y0); ctx.lineTo(bx + RH, y0); ctx.fill();
        }
        ctx.restore();
      }
      x0 = 104; x1 = W - 104;
    }
    // text: fit width
    const maxW = x1 - x0;
    let size = sp.sub ? 74 : 86;
    ctx.font = `900 ${size}px ${BANNER_FONT}`;
    while (ctx.measureText(sp.text).width > maxW && size > 30) { size -= 2; ctx.font = `900 ${size}px ${BANNER_FONT}`; }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const ty = y0 + RH / 2 + (sp.sub ? -12 : 4);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 12; ctx.strokeStyle = sp.outline ?? 'rgba(0,0,0,0.55)';
    ctx.strokeText(sp.text, (x0 + x1) / 2, ty + 3);
    ctx.fillStyle = sp.fg;
    ctx.fillText(sp.text, (x0 + x1) / 2, ty);
    if (sp.sub) {
      ctx.font = `800 26px ${BANNER_FONT}`;
      ctx.fillStyle = sp.fg; ctx.globalAlpha = 0.9;
      ctx.fillText(sp.sub, (x0 + x1) / 2, y0 + RH - 26);
      ctx.globalAlpha = 1;
    }
    // canvas Y down → texture v up (flipY): v0 = 1 - (y0+RH)/H
    const H = RH * 8;
    rects.push([0, 1 - (y0 + RH) / H, 1, 1 - y0 / H]);
  }
  const texture = toTexture(canvas, { repeat: false });
  return { texture, rects };
}

/** Starting-grid slot markings: 4×2 atlas cells, each a U-bracket + slot number. */
export function createGridSlotAtlas(color = '#ffffff'): THREE.CanvasTexture {
  const CW = 128, CH = 256;
  const { canvas, ctx } = makeCanvas(CW * 4, CH * 2);
  ctx.clearRect(0, 0, CW * 4, CH * 2);
  for (let k = 0; k < 8; k++) {
    const cx = (k % 4) * CW, cy = Math.floor(k / 4) * CH;
    ctx.fillStyle = color;
    // bracket: front bar at top (canvas top = +v = forward), two side legs going back
    const lw = 12;
    ctx.fillRect(cx + 10, cy + 10, CW - 20, lw);
    ctx.fillRect(cx + 10, cy + 10, lw, CH * 0.4);
    ctx.fillRect(cx + CW - 10 - lw, cy + 10, lw, CH * 0.4);
    ctx.font = `900 64px ${BANNER_FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.save();
    ctx.translate(cx + CW / 2, cy + CH * 0.72);
    ctx.fillText(String(k + 1), 0, 0);
    ctx.restore();
  }
  // worn paint
  const rnd = seededRandom(0x6d1);
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 700; i++) { ctx.fillStyle = `rgba(0,0,0,${0.3 + rnd() * 0.6})`; ctx.fillRect(rnd() * CW * 4, rnd() * CH * 2, 2 + rnd() * 3, 2 + rnd() * 3); }
  ctx.globalCompositeOperation = 'source-over';
  return toTexture(canvas, { repeat: false });
}

/** Striped fabric (canopies, inflatables): vertical stripes along X. */
export function createStripeTexture(a: string, b: string, stripes = 8): THREE.CanvasTexture {
  const W = 256, H = 64;
  const { canvas, ctx } = makeCanvas(W, H);
  for (let k = 0; k < stripes; k++) {
    ctx.fillStyle = k % 2 ? b : a; ctx.fillRect((k * W) / stripes, 0, W / stripes + 1, H);
  }
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(255,255,255,0.15)'); g.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  return toTexture(canvas);
}
