/**
 * Deterministic draw-call / triangle sweep: renders every track at fixed chase-camera viewpoints with the
 * 8 karts bunched in front of the camera, and reports full-frame calls / triangles (main vs shadow pass,
 * bloom and overlay passes included), programs, textures and geometries — independent of how fast the
 * software rasteriser happens to run, so before/after comparisons use identical views.
 *   npx tsx tools/perf-views.ts [--url http://127.0.0.1:8244] [--tracks a,b] [--qualities low,medium,high]
 *        [--views 12] [--width 640 --height 360] [--shots 0] [--tag name] [--out test-results/perf]
 * --shots N saves 1280×720-equivalent screenshots of the first N viewpoints (at the given size).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { TRACK_CATALOG } from '../src/sim/tracks/catalog.js';
import { PROBE } from './perf-probe.js';

const args = process.argv.slice(2);
const arg = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : def;
};
const url = arg('url', 'http://127.0.0.1:8244');
const out = arg('out', 'test-results/perf');
const qualities = arg('qualities', 'low,medium,high').split(',').filter(Boolean);
const tracks = arg('tracks', TRACK_CATALOG.map(t => t.id).join(',')).split(',').filter(Boolean);
const nViews = Number(arg('views', '12'));
const shots = Number(arg('shots', '0'));
const tag = arg('tag', 'views');
const width = Number(arg('width', '640')), height = Number(arg('height', '360'));
mkdirSync(out, { recursive: true });

const RACERS = ['kiki', 'pip', 'bruno', 'mochi', 'rex', 'taro', 'hana', 'bolt'];
const config = (trackId: string) => ({
  trackId, mode: 'vs', cc: 150, cpuLevel: 'hard', mirror: false, items: true, seed: 99,
  racers: RACERS.map((c, i) => ({ charId: c, human: i === 7 ? 0 : -1 })),
});

interface ViewStat { k: number; s: number; calls: number; tris: number; shadowCalls: number; shadowTris: number; renderMs: number }

const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; };

async function runConfig(page: Page, track: string, quality: string) {
  await page.evaluate(`window.__turbo.startRace(${JSON.stringify(config(track))}, { autopilotHuman: true })`);
  await page.waitForFunction('window.__turbo.state().inRace && (window.__turbo.view.skipIntro(), !window.__turbo.state().intro)', undefined, { polling: 250, timeout: 900000 });
  // let a couple of real frames run so lazily-built pieces exist, then freeze the game loop
  await page.evaluate(`new Promise(res => { let i = 0; const f = () => (++i >= 3 ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); })`);
  await page.evaluate(PROBE);
  await page.evaluate('window.__perf.install()');
  await page.evaluate('cancelAnimationFrame(window.__turbo.view.raf)');
  const shotsDir = path.join(out, `shots-${tag}`);
  if (shots > 0) mkdirSync(shotsDir, { recursive: true });
  const views: ViewStat[] = [];
  let breakdown: Record<string, { calls: number; tris: number }> = {};
  for (let k = 0; k < nViews; k++) {
    const v = await page.evaluate(`(() => {
      const view = window.__turbo.view, s = view.session, pipe = s.deps.pipeline, r = pipe.renderer, T = s.track, P = window.__perf;
      const n = T.n, k = ${k}, N = ${nViews};
      const i0 = (Math.round(T.startS / T.spacing) + Math.floor((n * k) / N) + n - 20) % n; // view 0 = grid
      const at = j => { j = ((j % n) + n) % n; return { x: T.px[j], y: T.py[j], z: T.pz[j], tx: T.tx[j], tz: T.tz[j], rx: T.rx[j], rz: T.rz[j], hw: T.hw[j] }; };
      // karts: a loose pack 6..40 m ahead of the camera, alternating sides
      s.kartVisuals.forEach((kv, idx) => {
        const p = at(i0 + 8 + idx * 4), side = (idx % 2 ? 1 : -1) * p.hw * 0.35;
        kv.root.position.set(p.x + p.rx * side, p.y + 0.02, p.z + p.rz * side);
        kv.root.rotation.set(0, Math.atan2(p.tx, p.tz), 0);
        kv.root.updateMatrixWorld(true);
      });
      const me = s.kartVisuals[s.humanKarts[0]].root.position;
      const c = at(i0), look = at(i0 + 16);
      const cam = s.cameras[0].camera;
      cam.position.set(c.x - c.tx * 2, c.y + 3.2, c.z - c.tz * 2);
      cam.lookAt(look.x, look.y + 1.2, look.z);
      cam.updateMatrixWorld(true);
      pipe.setShadowFocus(me.x, me.y, me.z);
      s.scenery.update(1 / 60, 10 + k, cam);
      s.trackMesh.update(1 / 60, 10 + k);
      if (s.pickups.setViewers) s.pickups.setViewers([cam]);
      s.pickups.update(s.world.itemBoxes, s.world.coins, 0, 10 + k);
      const size = pipe.resize();
      const views = [{ camera: cam, viewport: { x: 0, y: 0, w: size.width, h: size.height }, speedLines: 0, inkAmount: 0 }];
      pipe.render(s.scene, views, 1 / 60); // warm (uploads / compiles, shadow camera placement)
      P.cur = { sim: 0, vis: 0, submit: 0, audio: 0, shadow: 0, shadowCalls: 0, shadowTris: 0, steps: 0, worldStep: 0 };
      P.breakdown = {};
      const t0 = performance.now();
      pipe.render(s.scene, views, 1 / 60);
      const ms = performance.now() - t0;
      const c1 = P.cur; P.cur = null;
      const bd = P.breakdown; P.breakdown = null;
      window.__lastBreakdown = bd;
      return { k, s: Math.round(i0 * T.spacing), calls: r.info.render.calls, tris: r.info.render.triangles, shadowCalls: c1.shadowCalls, shadowTris: c1.shadowTris, renderMs: Math.round(ms * 10) / 10 };
    })()`) as ViewStat;
    views.push(v);
    if (k === 0) breakdown = await page.evaluate('window.__lastBreakdown') as typeof breakdown;
    if (k < shots) await page.screenshot({ path: path.join(shotsDir, `${track}-${quality}-v${k}.png`), timeout: 240000 });
  }
  const scene = await page.evaluate('window.__perf.sceneStats()') as Record<string, unknown>;
  await page.evaluate(`(() => { const v = window.__turbo.view; v.last = performance.now(); const loop = now => { v.raf = requestAnimationFrame(loop); const dt = Math.min(0.1, Math.max(0, (now - v.last) / 1000)); v.last = now; v.frame(dt); }; v.raf = requestAnimationFrame(loop); v.endRace(); })()`);
  return { views, breakdown, scene };
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const report: Record<string, unknown> = { tag, when: new Date().toISOString(), width, height, runs: [] as unknown[] };
  const runs = report.runs as unknown[];
  for (const q of qualities) {
    const page = await browser.newPage({ viewport: { width, height }, bypassCSP: true });
    page.setDefaultTimeout(900000);
    const errors: string[] = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`));
    await page.goto(`${url}/?debug&quality=${q}`, { waitUntil: 'load' });
    await page.waitForFunction(`window.__turbo && window.__turbo.ready && window.__turbo.state().quality === ${JSON.stringify(q)}`, undefined, { polling: 250 });
    for (const t of tracks) {
      const r = await runConfig(page, t, q);
      const calls = r.views.map(v => v.calls), tris = r.views.map(v => v.tris);
      const sum = {
        track: t, quality: q,
        calls: { med: median(calls), max: Math.max(...calls) },
        tris: { med: median(tris), max: Math.max(...tris) },
        shadowCalls: { med: median(r.views.map(v => v.shadowCalls)), max: Math.max(...r.views.map(v => v.shadowCalls)) },
        shadowTris: { med: median(r.views.map(v => v.shadowTris)), max: Math.max(...r.views.map(v => v.shadowTris)) },
        renderMs: median(r.views.map(v => v.renderMs)),
      };
      const sc = r.scene as { programs: number; memTextures: number; memGeometries: number; casters: number; texMB: number; materials: number };
      runs.push({ ...sum, views: r.views, scene: r.scene, breakdownView0: Object.entries(r.breakdown).sort((a, b) => b[1].tris - a[1].tris).map(([k, v]) => `${k}: ${v.calls} calls, ${v.tris} tris`), errors: errors.splice(0) });
      console.log(`■ ${t} @${q}: calls med ${sum.calls.med} max ${sum.calls.max} (shadow ${sum.shadowCalls.med}/${sum.shadowCalls.max}) | tris med ${(sum.tris.med / 1e6).toFixed(3)}M max ${(sum.tris.max / 1e6).toFixed(3)}M (shadow ${(sum.shadowTris.med / 1e6).toFixed(3)}/${(sum.shadowTris.max / 1e6).toFixed(3)}M) | render ${sum.renderMs}ms | programs ${sc.programs} tex ${sc.memTextures} (${sc.texMB}MB) geo ${sc.memGeometries} mats ${sc.materials} casters ${sc.casters}`);
      writeFileSync(path.join(out, `views-${tag}.json`), JSON.stringify(report, null, 2));
    }
    await page.close();
  }
  await browser.close();
}

void main();
