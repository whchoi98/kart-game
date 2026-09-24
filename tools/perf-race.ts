/**
 * Performance & resource-hygiene probe for real races (8 karts, bots driving every kart).
 *   npx tsx tools/perf-race.ts [--url http://127.0.0.1:8244] [--tracks a,b] [--qualities low,medium,high]
 *        [--seconds 6] [--heap 0] [--cycles 0] [--alloc 0] [--governor 0] [--shadow 0] [--out test-results/perf]
 *
 * Everything is instrumented from the outside (method wrapping in the page); nothing ships in the game.
 * Per track × tier it reports, for the full frame (main + shadow + bloom/overlay passes):
 *   draw calls / triangles (split main vs shadow pass), programs, textures, geometries,
 *   CPU ms per frame split into sim stepping (per tick) / visual updates / audio / render submission,
 *   JS heap allocation per frame, scene build time and a per-object draw-call breakdown.
 * Optional: --heap N  → N race-seconds heap trace (sawtooth depth, alloc MB/s)
 *           --cycles N → N start/end cycles; geometries/textures/programs/heap after each end
 *           --alloc 1  → CDP sampling heap profile of the race loop (allocation hot spots)
 *           --governor 1 → drives the auto-quality governor with a fake clock (step down/up, hysteresis)
 *           --shadow 1 → checks the shadow camera is texel-snapped while following the player
 *           --build 1  → cold scene-build time (RaceSession constructor, first build of each track) per track
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
const seconds = Number(arg('seconds', '6'));
const heapSeconds = Number(arg('heap', '0'));
const cycles = Number(arg('cycles', '0'));
const alloc = arg('alloc', '0') === '1';
const governor = arg('governor', '0') === '1';
const shadowCheck = arg('shadow', '0') === '1';
const buildCheck = arg('build', '0') === '1';
const tag = arg('tag', 'run');
const width = Number(arg('width', '1280')), height = Number(arg('height', '720'));
mkdirSync(out, { recursive: true });

const RACERS = ['kiki', 'pip', 'bruno', 'mochi', 'rex', 'taro', 'hana', 'bolt'];
const config = (trackId: string) => ({
  trackId, mode: 'vs', cc: 150, cpuLevel: 'hard', mirror: false, items: true, seed: 99,
  racers: RACERS.map((c, i) => ({ charId: c, human: i === 7 ? 0 : -1 })),
});


interface FrameRec {
  sim: number; vis: number; submit: number; audio: number; shadow: number; shadowCalls: number; shadowTris: number;
  steps: number; worldStep: number; total: number; calls: number; tris: number; frameAlloc: number; loopAlloc: number; rs: number;
}

const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; };
const pct = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]!; };
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

const verbose = arg('verbose', '0') === '1';
async function waitFor(page: Page, fn: string, timeout = 1800000): Promise<void> {
  const t0 = Date.now();
  const tick = verbose ? setInterval(() => {
    page.evaluate('JSON.stringify(window.__turbo && window.__turbo.state())').then(s => console.log(`   … ${Math.round((Date.now() - t0) / 1000)}s waiting ${fn.slice(0, 60)} state=${s}`)).catch(() => {});
  }, 20000) : null;
  try { await page.waitForFunction(fn, undefined, { timeout, polling: 100 }); } finally { if (tick) clearInterval(tick); }
}

async function openPage(browser: import('playwright').Browser, quality: string): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height }, bypassCSP: true });
  page.setDefaultTimeout(1800000);
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`));
  await page.goto(`${url}/?debug&quality=${quality}`, { waitUntil: 'load' });
  await waitFor(page, 'window.__turbo && window.__turbo.ready');
  await waitFor(page, `window.__turbo.state().quality === ${JSON.stringify(quality)}`);
  await page.evaluate(PROBE);
  return { page, errors };
}

/** Starts a race; returns scene build ms (constructor) and ms until the first race frame was rendered. */
async function startRace(page: Page, trackId: string): Promise<{ buildMs: number; firstFrameMs: number }> {
  return await page.evaluate(`(async () => {
    const view = window.__turbo.view;
    const pipe = view.pipeline, o = pipe.render;
    const t0 = performance.now();
    let built = 0, first = 0;
    const done = new Promise(res => {
      // first rendered frame of the new scene (includes shader compilation / texture upload)
      pipe.render = function (scene, ...a) {
        const s = view.session;
        if (s && scene === s.scene && !built) built = performance.now();
        const r = o.call(this, scene, ...a);
        if (s && scene === s.scene) { first = performance.now(); pipe.render = o; res(); }
        return r;
      };
    });
    window.__turbo.startRace(${JSON.stringify(config(trackId))}, { autopilotHuman: true });
    await done;
    return { buildMs: built - t0, firstFrameMs: first - t0 };
  })()`) as { buildMs: number; firstFrameMs: number };
}

/** Precise constructor time: build a second RaceSession off-screen from the live one and dispose it. */
async function ctorTime(page: Page): Promise<{ ctorMs: number; compileMs: number }> {
  return await page.evaluate(`(() => {
    const s = window.__turbo.view.session;
    const Ctor = s.constructor;
    const opts = { ...s.opts, onFinish: () => {} };
    const deps = { ...s.deps, audio: { ...s.deps.audio, playMusic() {}, stopRace() {}, setFinalLap() {} }, input: { ...s.deps.input, setMode() {} } };
    const t0 = performance.now();
    const n = new Ctor(opts, deps);
    const t1 = performance.now();
    // compile cost is what the first render of a fresh scene pays; programs are cached by now, so measure compile() only
    const r = s.deps.pipeline.renderer;
    const t2 = performance.now();
    try { r.compile(n.scene, s.cameras[0].camera); } catch (e) {}
    const t3 = performance.now();
    n.dispose();
    // the scratch session re-parented the shared environment group; put it back into the live scene
    s.deps.pipeline.applyEnvironment(s.scene, s.scenery.environment);
    return { ctorMs: t1 - t0, compileMs: t3 - t2 };
  })()`) as { ctorMs: number; compileMs: number };
}

async function measure(page: Page, secs: number): Promise<{ frames: FrameRec[]; breakdown: Record<string, { calls: number; tris: number }> }> {
  await page.evaluate('window.__perf.install()');
  await waitFor(page, 'window.__turbo.state().raceSeconds > 3');
  const start = await page.evaluate('window.__turbo.state().raceSeconds') as number;
  await page.evaluate('window.__perf.frames = []; window.__perf.recording = true; window.__perf.wantBreakdown = true');
  await waitFor(page, `window.__turbo.state().raceSeconds > ${start + secs}`, 600000);
  await page.evaluate('window.__perf.recording = false');
  const frames = await page.evaluate('window.__perf.frames') as FrameRec[];
  const breakdown = await page.evaluate('window.__perf.lastBreakdown || {}') as Record<string, { calls: number; tris: number }>;
  return { frames, breakdown };
}

function summarize(frames: FrameRec[]) {
  const f = frames.filter(x => x.calls > 0);
  const perTick = f.filter(x => x.steps > 0).map(x => x.sim / x.steps);
  const worldTick = f.filter(x => x.steps > 0).map(x => x.worldStep / x.steps);
  const vis = f.map(x => x.vis), sub = f.map(x => x.submit), shadow = f.map(x => x.shadow), aud = f.map(x => x.audio);
  const allocs = f.map(x => x.frameAlloc).filter(x => x > 0);
  const loop = f.map(x => x.loopAlloc).filter(x => x > 0);
  const cpu60 = median(perTick) + median(vis) + median(sub);
  return {
    frames: f.length,
    calls: { med: median(f.map(x => x.calls)), max: Math.max(...f.map(x => x.calls)) },
    tris: { med: median(f.map(x => x.tris)), max: Math.max(...f.map(x => x.tris)) },
    shadowCalls: median(f.map(x => x.shadowCalls)), shadowTris: median(f.map(x => x.shadowTris)),
    simTickMs: r2(median(perTick)), worldTickMs: r2(median(worldTick)),
    visMs: r2(median(vis)), visP95: r2(pct(vis, 0.95)),
    submitMs: r2(median(sub)), submitP95: r2(pct(sub, 0.95)), shadowMs: r2(median(shadow)), audioMs: r2(median(aud)),
    cpuAt60Ms: r2(cpu60),
    frameAllocKB: r1(median(allocs) / 1024), loopAllocKB: r1(median(loop) / 1024),
  };
}

async function heapTrace(page: Page, secs: number) {
  await page.evaluate('window.__perf.install()');
  await page.evaluate(`window.__heapT = []; window.__heapRec = true; (function loop(){ if(!window.__heapRec) return; window.__heapT.push([performance.now(), performance.memory.usedJSHeapSize, window.__turbo.state().raceSeconds]); requestAnimationFrame(loop); })()`);
  const start = await page.evaluate('window.__turbo.state().raceSeconds') as number;
  await waitFor(page, `window.__turbo.state().raceSeconds > ${start + secs} || window.__turbo.state().phase === 'done'`, 1800000);
  await page.evaluate('window.__heapRec = false');
  const tr = await page.evaluate('window.__heapT') as Array<[number, number, number]>;
  let allocated = 0, gcs = 0, minH = Infinity, maxH = 0;
  const drops: number[] = [];
  for (let i = 1; i < tr.length; i++) {
    const d = tr[i]![1] - tr[i - 1]![1];
    if (d >= 0) allocated += d; else { gcs++; drops.push(-d); }
    minH = Math.min(minH, tr[i]![1]); maxH = Math.max(maxH, tr[i]![1]);
  }
  const wall = (tr[tr.length - 1]![0] - tr[0]![0]) / 1000;
  const race = tr[tr.length - 1]![2] - tr[0]![2];
  const firstQ = tr.slice(0, Math.max(2, tr.length >> 2)).map(x => x[1]);
  const lastQ = tr.slice(-Math.max(2, tr.length >> 2)).map(x => x[1]);
  return {
    samples: tr.length, wallS: r1(wall), raceS: r1(race), frames: tr.length,
    allocMB: r1(allocated / 1048576), allocKBPerFrame: r1(allocated / 1024 / Math.max(1, tr.length)),
    gcs, sawtoothMB: r2(median(drops) / 1048576), minMB: r1(minH / 1048576), maxMB: r1(maxH / 1048576),
    floorStartMB: r1(Math.min(...firstQ) / 1048576), floorEndMB: r1(Math.min(...lastQ) / 1048576),
  };
}

async function allocProfile(page: Page, secs: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await page.evaluate('window.__perf.install()');
  const start = await page.evaluate('window.__turbo.state().raceSeconds') as number;
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true } as never);
  await waitFor(page, `window.__turbo.state().raceSeconds > ${start + secs}`, 900000);
  const frames = await page.evaluate('window.__perf.frames.length') as number;
  const { profile } = await cdp.send('HeapProfiler.stopSampling') as { profile: { head: Node } };
  interface Node { callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; selfSize: number; children: Node[] }
  const self = new Map<string, number>();
  const incl = new Map<string, number>();
  let total = 0;
  const walk = (n: Node, stack: string[]) => {
    const cf = n.callFrame;
    const file = cf.url.replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '');
    const key = `${cf.functionName || '(anon)'} ${file}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + n.selfSize);
    total += n.selfSize;
    const st = stack.includes(key) ? stack : [...stack, key];
    if (n.selfSize) for (const k of st) incl.set(k, (incl.get(k) ?? 0) + n.selfSize);
    for (const c of n.children) walk(c, st);
  };
  walk(profile.head, []);
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => ({ k, kb: r1(v / 1024) }));
  const topIncl = [...incl.entries()].filter(([k]) => /src\//.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => ({ k, kb: r1(v / 1024) }));
  const endRs = await page.evaluate('window.__turbo.state().raceSeconds') as number;
  return { totalMB: r2(total / 1048576), raceS: r1(endRs - start), top, topIncl, frames };
}

async function disposeCycles(page: Page, trackIds: string[], n: number) {
  const snap = async (label: string) => await page.evaluate(`(() => {
    if (window.gc) { window.gc(); window.gc(); }
    const r = window.__turbo.view.pipeline.renderer;
    return { label: ${JSON.stringify(label)}, geometries: r.info.memory.geometries, textures: r.info.memory.textures, programs: r.info.programs.length,
      heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10, sceneChildren: window.__turbo.view.showroom?.scene?.children?.length ?? -1 };
  })()`);
  const waitFrames = async (k: number) => page.evaluate(`new Promise(res => { let i = 0; const f = () => (++i >= ${k} ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); })`);
  await waitFrames(5);
  const rows: unknown[] = [await snap('baseline (showroom)')];
  for (let i = 0; i < n; i++) {
    const t = trackIds[i % trackIds.length]!;
    await startRace(page, t);
    await page.evaluate('window.__turbo.view.skipIntro()');
    await waitFor(page, 'window.__turbo.state().raceSeconds > 1.5', 600000);
    rows.push(await snap(`in race ${i + 1} (${t})`));
    await page.evaluate('window.__turbo.view.endRace()');
    await waitFrames(5);
    rows.push(await snap(`after end ${i + 1}`));
  }
  return rows;
}

async function governorTest(page: Page) {
  // Fake clock: drive pipeline.render() with synthetic frame times; views = [] keeps GPU work at zero.
  return await page.evaluate(`(() => {
    const view = window.__turbo.view;
    const pipe = view.pipeline;
    cancelAnimationFrame(view.raf); // stop the real loop while the clock is faked
    const realNow = performance.now.bind(performance);
    let t = realNow();
    performance.now = () => t;
    pipe.setQuality('auto');
    const scene = view.showroom.scene;
    const log = [];
    let lastKey = '';
    const run = (ms, fps) => {
      const n = Math.round(ms / (1000 / fps));
      for (let i = 0; i < n; i++) {
        t += 1000 / fps;
        pipe.render(scene, [], 1 / fps);
        const g = pipe._gov();
        const key = pipe.quality.level + '@' + pipe.pixelRatio;
        if (key !== lastKey) { log.push({ atMs: Math.round(t), fps, rung: g.rung, level: pipe.quality.level, pr: pipe.pixelRatio, upBackoff: g.upBackoff }); lastKey = key; }
      }
    };
    const phases = [[3000, 60], [4000, 30], [3000, 45], [8000, 60], [2000, 50], [12000, 60], [3000, 58], [20000, 60], [4000, 20], [30000, 60]];
    for (const [ms, fps] of phases) { log.push({ phase: ms + 'ms@' + fps + 'fps' }); run(ms, fps); }
    performance.now = realNow;
    return log;
  })()`);
}

async function shadowSnapTest(page: Page) {
  await page.evaluate('window.__perf.install()');
  return await page.evaluate(`new Promise(res => {
    const s = window.__turbo.view.session; let sun = null;
    s.scene.traverse(o => { if (o.isDirectionalLight) sun = o; });
    const cam = sun.shadow.camera; const texel = (cam.right - cam.left) / sun.shadow.mapSize.x;
    const samples = []; let n = 0;
    const V = s.scene.position.constructor;
    const p = new V(0, 0, 0);
    const tick = () => {
      // shadow camera matrices are updated inside shadowMap.render; read after the frame
      p.set(0, 0, 0).applyMatrix4(cam.matrixWorldInverse);
      const fx = p.x / texel, fy = p.y / texel;
      samples.push({ fx: Math.abs(fx - Math.round(fx)), fy: Math.abs(fy - Math.round(fy)), cx: +cam.position.x.toFixed(2), cz: +cam.position.z.toFixed(2) });
      if (++n < 40) requestAnimationFrame(tick); else res({ texel, maxFrac: Math.max(...samples.map(q => Math.max(q.fx, q.fy))), moved: new Set(samples.map(q => q.cx + ',' + q.cz)).size, samples: samples.slice(0, 5) });
    };
    requestAnimationFrame(tick);
  })`);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
  });
  const report: Record<string, unknown> = { tag, when: new Date().toISOString(), width, height, runs: [] as unknown[] };
  const runs = report.runs as unknown[];
  const save = () => writeFileSync(path.join(out, `perf-${tag}.json`), JSON.stringify(report, null, 2));

  if (buildCheck) {
    // one live race provides the RaceSession class and its deps; every other track is then built cold
    const { page } = await openPage(browser, qualities[0]!);
    await startRace(page, tracks[0]!);
    const rows: unknown[] = [];
    for (const t of tracks) {
      const row = await page.evaluate(`(() => {
        const s = window.__turbo.view.session;
        const Ctor = s.constructor;
        const opts = { ...s.opts, config: { ...s.opts.config, trackId: ${JSON.stringify(t)} }, ghost: null, onFinish: () => {} };
        const deps = { ...s.deps, audio: { ...s.deps.audio, playMusic() {}, stopRace() {}, setFinalLap() {} }, input: { ...s.deps.input, setMode() {} } };
        const t0 = performance.now();
        const n = new Ctor(opts, deps);
        const t1 = performance.now();
        const warm = new Ctor(opts, deps);
        const t2 = performance.now();
        const tm = n.trackMesh && n.trackMesh.stats ? n.trackMesh.stats.buildMs : -1;
        n.dispose(); warm.dispose();
        s.deps.pipeline.applyEnvironment(s.scene, s.scenery.environment);
        return { track: ${JSON.stringify(t)}, coldMs: Math.round(t1 - t0), warmMs: Math.round(t2 - t1), trackMeshMs: tm };
      })()`);
      console.log('build', JSON.stringify(row));
      rows.push(row);
    }
    report.build = rows;
    await page.close();
    save();
  }
  if (governor) {
    const { page } = await openPage(browser, 'high');
    report.governor = await governorTest(page);
    console.log('governor', JSON.stringify(report.governor));
    await page.close();
    save();
  }
  if (cycles > 0) {
    const { page, errors } = await openPage(browser, qualities[0]!);
    await page.evaluate(PROBE);
    report.cycles = await disposeCycles(page, tracks, cycles);
    console.log('cycles', JSON.stringify(report.cycles, null, 1));
    if (errors.length) console.log(errors.slice(0, 5));
    await page.close();
    save();
  }

  if (seconds > 0 || heapSeconds > 0 || alloc || shadowCheck) {
    for (const q of qualities) {
      for (const t of tracks) {
        const { page, errors } = await openPage(browser, q);
        const st = await startRace(page, t);
        await page.evaluate('window.__turbo.view.skipIntro()');
        await page.evaluate('window.__perf.install()');
        const run: Record<string, unknown> = { track: t, quality: q, buildMs: Math.round(st.buildMs), firstFrameMs: Math.round(st.firstFrameMs) };
        if (seconds > 0) {
          const m = await measure(page, seconds);
          run.summary = summarize(m.frames);
          run.scene = await page.evaluate('window.__perf.sceneStats()');
          run.breakdown = Object.entries(m.breakdown).sort((a, b) => b[1].tris - a[1].tris)
            .map(([k, v]) => `${k}: ${v.calls} calls, ${v.tris} tris`);
          const ct = await ctorTime(page);
          run.ctorMs = Math.round(ct.ctorMs); run.compileMs = Math.round(ct.compileMs);
        }
        if (shadowCheck) run.shadowSnap = await shadowSnapTest(page);
        if (heapSeconds > 0) run.heap = await heapTrace(page, heapSeconds);
        if (alloc) run.alloc = await allocProfile(page, Math.max(4, seconds));
        run.errors = errors.slice(0, 10);
        runs.push(run);
        const s = run.summary as ReturnType<typeof summarize> | undefined;
        const sc = run.scene as { programs: number; memTextures: number; memGeometries: number; casters: number; texMB: number } | undefined;
        console.log(`■ ${t} @${q}: build ${run.buildMs}ms (ctor ${run.ctorMs}ms, first frame ${run.firstFrameMs}ms)`
          + (s ? ` | calls ${s.calls.med} (max ${s.calls.max}, shadow ${s.shadowCalls}) tris ${(s.tris.med / 1e6).toFixed(3)}M (shadow ${(s.shadowTris / 1e6).toFixed(3)}M)`
            + ` | sim/tick ${s.simTickMs} vis ${s.visMs} submit ${s.submitMs} (shadow ${s.shadowMs}) audio ${s.audioMs} → cpu@60 ${s.cpuAt60Ms}ms | alloc/frame ${s.frameAllocKB}KB loop ${s.loopAllocKB}KB` : '')
          + (sc ? ` | programs ${sc.programs} tex ${sc.memTextures} (${sc.texMB}MB) geo ${sc.memGeometries} casters ${sc.casters}` : '')
          + (errors.length ? ` | ${errors.length} errors` : ''));
        if (run.heap) console.log('   heap', JSON.stringify(run.heap));
        if (run.shadowSnap) console.log('   shadow', JSON.stringify(run.shadowSnap));
        if (run.alloc) console.log('   alloc', JSON.stringify((run.alloc as { top: unknown[] }).top.slice(0, 15)));
        save();
        await page.close();
      }
    }
  }
  await browser.close();
  save();
}

void main();
