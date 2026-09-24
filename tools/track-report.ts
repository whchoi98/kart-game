/**
 * Track authoring report: geometry stats, validation, and a top-down SVG/PNG plan.
 *   npx tsx tools/track-report.ts [trackId ...] [--png] [--out dir]
 * Exit code 1 when any track fails validation.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildTrack } from '../src/sim/track-builder.js';
import { projectToTrack, surfaceAt } from '../src/sim/track-query.js';
import { TRACK_DEFS } from '../src/sim/tracks/index.js';
import type { BuiltTrack } from '../src/sim/types.js';

export interface TrackReport {
  id: string;
  length: number;
  minRadius: number;
  maxSlopeDeg: number;
  elevation: [number, number];
  problems: string[];
  warnings: string[];
}

export function analyzeTrack(t: BuiltTrack): TrackReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  let maxK = 0;
  let maxSlope = 0;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < t.n; i++) {
    const k = Math.abs(t.curvature[i]!);
    if (k > maxK) maxK = k;
    const th = Math.sqrt(t.tx[i]! ** 2 + t.tz[i]! ** 2);
    const slope = Math.abs(Math.atan2(t.ty[i]!, th)) * 180 / Math.PI;
    if (slope > maxSlope) maxSlope = slope;
    minY = Math.min(minY, t.py[i]!); maxY = Math.max(maxY, t.py[i]!);
    // road must fit inside the inner side of the corner
    const r = k > 1e-6 ? 1 / k : Infinity;
    if (r < t.hw[i]! + 2) problems.push(`sample ${i} (s=${(i * t.spacing).toFixed(0)}): corner radius ${r.toFixed(1)} m < half width + 2`);
  }
  const minRadius = maxK > 0 ? 1 / maxK : Infinity;
  if (t.length < 700) warnings.push(`short lap ${t.length.toFixed(0)} m`);
  if (t.length > 1900) warnings.push(`long lap ${t.length.toFixed(0)} m`);
  if (maxSlope > 16) problems.push(`slope ${maxSlope.toFixed(1)}° exceeds 16°`);

  // corridor overlap: sections far apart along s but close in XZ and not vertically separated
  const step = 3;
  let overlaps = 0;
  for (let i = 0; i < t.n; i += step) {
    for (let j = i + step; j < t.n; j += step) {
      let ds = Math.abs(i - j) * t.spacing;
      ds = Math.min(ds, t.length - ds);
      if (ds < 80) continue;
      const dx = t.px[i]! - t.px[j]!, dz = t.pz[i]! - t.pz[j]!;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const dy = Math.abs(t.py[i]! - t.py[j]!);
      const need = Math.max(t.wallL[i]!, t.wallR[i]!) + Math.max(t.wallL[j]!, t.wallR[j]!) + 3;
      const roadNeed = t.hw[i]! + t.hw[j]! + 2;
      if (dy < 7 && dist < roadNeed) {
        overlaps++;
        if (overlaps <= 6) problems.push(`road overlap between s=${(i * t.spacing).toFixed(0)} and s=${(j * t.spacing).toFixed(0)} (dist ${dist.toFixed(1)} m, dy ${dy.toFixed(1)})`);
      } else if (dy < 7 && dist < need) {
        warnings.push(`corridors touch near s=${(i * t.spacing).toFixed(0)} / s=${(j * t.spacing).toFixed(0)} (dist ${dist.toFixed(1)} m < ${need.toFixed(1)})`);
      }
    }
  }
  // features must sit on the road
  const onRoad = (x: number, z: number, y: number, label: string) => {
    const p = projectToTrack(t, x, z, -1, y);
    const s = surfaceAt(t, p);
    if (!s.onRoad && s.kind !== 'mud') problems.push(`${label} is off-road (d=${p.d.toFixed(1)})`);
  };
  t.grid.forEach((g, k) => onRoad(g.x, g.z, g.y, `grid slot ${k}`));
  t.itemBoxes.forEach((b, k) => onRoad(b.x, b.z, b.y, `item box ${k}`));
  t.boostPads.forEach((b, k) => onRoad(b.x, b.z, b.y, `boost pad ${k}`));
  for (const r of t.ramps) {
    const dStart = Math.abs(((r.s0 - t.startS) % t.length + t.length) % t.length);
    if (dStart < 30 || t.length - dStart < 45) problems.push(`ramp at s=${r.s0.toFixed(0)} too close to the start line`);
  }
  // dedupe warnings
  const uniq = [...new Set(warnings)].slice(0, 12);
  return {
    id: t.def.id, length: t.length, minRadius, maxSlopeDeg: maxSlope,
    elevation: [minY, maxY], problems, warnings: uniq,
  };
}

export function trackSvg(t: BuiltTrack): string {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const L: string[] = [], R: string[] = [], WL: string[] = [], WR: string[] = [], C: string[] = [];
  for (let i = 0; i <= t.n; i++) {
    const k = i % t.n;
    const hx = t.rx[k]!, hz = t.rz[k]!;
    const hl = Math.sqrt(hx * hx + hz * hz) || 1;
    const nx = hx / hl, nz = hz / hl;
    const cx = t.px[k]!, cz = t.pz[k]!;
    const pt = (d: number) => `${(cx + nx * d).toFixed(1)},${(cz + nz * d).toFixed(1)}`;
    L.push(pt(-t.hw[k]!)); R.push(pt(t.hw[k]!));
    WL.push(pt(-t.wallL[k]!)); WR.push(pt(t.wallR[k]!));
    C.push(pt(0));
    minX = Math.min(minX, cx - t.wallL[k]! - 5); maxX = Math.max(maxX, cx + t.wallR[k]! + 5);
    minZ = Math.min(minZ, cz - 30); maxZ = Math.max(maxZ, cz + 30);
  }
  minX -= 20; maxX += 20;
  const w = maxX - minX, h = maxZ - minZ;
  const heightColor = (y: number, lo: number, hi: number) => {
    const f = hi > lo ? (y - lo) / (hi - lo) : 0;
    return `hsl(${220 - f * 200}, 70%, 45%)`;
  };
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < t.n; i++) { lo = Math.min(lo, t.py[i]!); hi = Math.max(hi, t.py[i]!); }
  const segs: string[] = [];
  for (let i = 0; i < t.n; i += 4) {
    const j = (i + 4) % t.n;
    segs.push(`<line x1="${t.px[i]!.toFixed(1)}" y1="${t.pz[i]!.toFixed(1)}" x2="${t.px[j]!.toFixed(1)}" y2="${t.pz[j]!.toFixed(1)}" stroke="${heightColor(t.py[i]!, lo, hi)}" stroke-width="2"/>`);
  }
  const edgeCol = (e: number) => (e === 0 ? '#7cc36e' : e === 1 ? '#555' : '#d33');
  const edgeDots: string[] = [];
  for (let i = 0; i < t.n; i += 6) {
    const hx = t.rx[i]!, hz = t.rz[i]!;
    const hl = Math.sqrt(hx * hx + hz * hz) || 1;
    for (const side of [-1, 1] as const) {
      const d = side < 0 ? -t.wallL[i]! : t.wallR[i]!;
      const e = side < 0 ? t.edgeL[i]! : t.edgeR[i]!;
      edgeDots.push(`<circle cx="${(t.px[i]! + hx / hl * d).toFixed(1)}" cy="${(t.pz[i]! + hz / hl * d).toFixed(1)}" r="1.2" fill="${edgeCol(e)}"/>`);
    }
  }
  const arrows: string[] = [];
  for (let i = 0; i < t.n; i += Math.floor(t.n / 24)) {
    const x = t.px[i]!, z = t.pz[i]!;
    const a = Math.atan2(t.tz[i]!, t.tx[i]!) * 180 / Math.PI;
    arrows.push(`<path d="M-3,-2.5 L3,0 L-3,2.5 Z" fill="#fff" transform="translate(${x.toFixed(1)},${z.toFixed(1)}) rotate(${a.toFixed(1)})"/>`);
  }
  const feat: string[] = [];
  for (const b of t.itemBoxes) feat.push(`<rect x="${(b.x - 1.2).toFixed(1)}" y="${(b.z - 1.2).toFixed(1)}" width="2.4" height="2.4" fill="#ffd400" stroke="#000" stroke-width="0.3"/>`);
  for (const b of t.boostPads) feat.push(`<circle cx="${b.x.toFixed(1)}" cy="${b.z.toFixed(1)}" r="2.2" fill="#ff7b00"/>`);
  for (const c of t.coins) feat.push(`<circle cx="${c.x.toFixed(1)}" cy="${c.z.toFixed(1)}" r="0.8" fill="#e8b400"/>`);
  for (const r of t.ramps) {
    const i = Math.floor(r.s0 / t.spacing) % t.n;
    feat.push(`<circle cx="${t.px[i]!.toFixed(1)}" cy="${t.pz[i]!.toFixed(1)}" r="4" fill="none" stroke="#1ec8ff" stroke-width="1.5"/>`);
  }
  for (const m of t.movers) {
    const i = Math.floor(m.s / t.spacing) % t.n;
    feat.push(`<circle cx="${t.px[i]!.toFixed(1)}" cy="${t.pz[i]!.toFixed(1)}" r="${(m.radius + (m.amplitude ?? 0)).toFixed(1)}" fill="rgba(255,0,0,0.25)" stroke="#f00" stroke-width="0.5"/>`);
  }
  for (const l of t.landmarks) {
    const i = Math.floor(l.s / t.spacing) % t.n;
    const hx = t.rx[i]!, hz = t.rz[i]!;
    const hl = Math.sqrt(hx * hx + hz * hz) || 1;
    const d = l.side === 'over' ? 0 : l.side === 'left' ? -l.dist : l.dist;
    feat.push(`<text x="${(t.px[i]! + hx / hl * d).toFixed(1)}" y="${(t.pz[i]! + hz / hl * d).toFixed(1)}" font-size="6" fill="#222" text-anchor="middle">${l.kind}</text>`);
  }
  t.grid.forEach(g => feat.push(`<circle cx="${g.x.toFixed(1)}" cy="${g.z.toFixed(1)}" r="1" fill="#fff" stroke="#000" stroke-width="0.3"/>`));
  const si = Math.floor(t.startS / t.spacing) % t.n;
  const sx = t.rx[si]!, sz = t.rz[si]!;
  const shl = Math.sqrt(sx * sx + sz * sz) || 1;
  const start = `<line x1="${(t.px[si]! - sx / shl * t.hw[si]!).toFixed(1)}" y1="${(t.pz[si]! - sz / shl * t.hw[si]!).toFixed(1)}" x2="${(t.px[si]! + sx / shl * t.hw[si]!).toFixed(1)}" y2="${(t.pz[si]! + sz / shl * t.hw[si]!).toFixed(1)}" stroke="#fff" stroke-width="3" stroke-dasharray="2,2"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(0)} ${minZ.toFixed(0)} ${w.toFixed(0)} ${h.toFixed(0)}" width="${Math.round(w * 2)}" height="${Math.round(h * 2)}" style="background:#cfe8c8">
<polygon points="${WL.join(' ')} ${[...WR].reverse().join(' ')}" fill="#a8d99a" opacity="0.6"/>
<polygon points="${L.join(' ')} ${[...R].reverse().join(' ')}" fill="#666"/>
${segs.join('\n')}
${edgeDots.join('\n')}
${arrows.join('\n')}
${start}
${feat.join('\n')}
<text x="${(minX + 8).toFixed(0)}" y="${(minZ + 14).toFixed(0)}" font-size="12" font-family="sans-serif">${t.def.nameEn} — ${t.length.toFixed(0)} m</text>
</svg>`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const png = args.includes('--png');
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1]! : 'test-results/tracks';
  const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  const defs = ids.length ? TRACK_DEFS.filter(d => ids.includes(d.id)) : TRACK_DEFS;
  mkdirSync(out, { recursive: true });
  let failed = false;
  const svgs: Array<[string, string]> = [];
  for (const def of defs) {
    for (const mirror of [false, true]) {
      const t = buildTrack(def, { mirror });
      const rep = analyzeTrack(t);
      if (!mirror) {
        console.log(`\n■ ${def.id}  length ${rep.length.toFixed(0)} m  minR ${rep.minRadius.toFixed(1)} m  maxSlope ${rep.maxSlopeDeg.toFixed(1)}°  y ${rep.elevation[0].toFixed(1)}..${rep.elevation[1].toFixed(1)}  boxes ${t.itemBoxes.length} pads ${t.boostPads.length} coins ${t.coins.length} ramps ${t.ramps.length} movers ${t.movers.length}`);
        for (const w of rep.warnings) console.log(`  ⚠ ${w}`);
        const svg = trackSvg(t);
        const file = path.join(out, `${def.id}.svg`);
        writeFileSync(file, svg);
        svgs.push([def.id, svg]);
      }
      for (const p of rep.problems) { console.log(`  ✖ ${mirror ? '[mirror] ' : ''}${p}`); failed = true; }
    }
  }
  if (png && svgs.length) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
    for (const [id, svg] of svgs) {
      await page.setContent(`<html><body style="margin:0">${svg.replace(/width="\d+" height="\d+"/, 'width="1200" height="1200"')}</body></html>`);
      await page.screenshot({ path: path.join(out, `${id}.png`), fullPage: false });
    }
    await browser.close();
    console.log(`PNG plans written to ${out}`);
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  void main();
}
