/**
 * CPU profile of the race-scene build (RaceSession constructor) per track: self-time hot spots.
 *   npx tsx tools/perf-build.ts [--url http://127.0.0.1:8244] [--tracks a,b] [--quality high]
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const arg = (name: string, def: string): string => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1]! : def; };
const url = arg('url', 'http://127.0.0.1:8244');
const quality = arg('quality', 'high');
const tracks = arg('tracks', 'neon-city').split(',');
const RACERS = ['kiki', 'pip', 'bruno', 'mochi', 'rex', 'taro', 'hana', 'bolt'];

interface Node { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount: number; children?: number[] }

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 320, height: 180 }, bypassCSP: true });
  page.setDefaultTimeout(1800000);
  await page.goto(`${url}/?debug&quality=${quality}`);
  await page.waitForFunction(`window.__turbo && window.__turbo.ready && window.__turbo.state().quality === ${JSON.stringify(quality)}`, undefined, { polling: 250 });
  await page.evaluate(`window.__turbo.startRace(${JSON.stringify({ trackId: 'starlight-road', mode: 'vs', cc: 150, cpuLevel: 'hard', mirror: false, items: true, seed: 99, racers: RACERS.map((c, k) => ({ charId: c, human: k === 7 ? 0 : -1 })) })}, { autopilotHuman: true })`);
  await page.waitForFunction('window.__turbo.state().inRace', undefined, { polling: 500 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  for (const t of tracks) {
    await cdp.send('Profiler.start');
    const ms = await page.evaluate(`(() => {
      const s = window.__turbo.view.session, Ctor = s.constructor;
      const opts = { ...s.opts, config: { ...s.opts.config, trackId: ${JSON.stringify(t)} }, ghost: null, onFinish: () => {} };
      const deps = { ...s.deps, audio: { ...s.deps.audio, playMusic() {}, stopRace() {}, setFinalLap() {} }, input: { ...s.deps.input, setMode() {} } };
      const t0 = performance.now(); const n = new Ctor(opts, deps); const dt = performance.now() - t0;
      window.__tm = n.trackMesh.stats; n.dispose(); s.deps.pipeline.applyEnvironment(s.scene, s.scenery.environment); return dt;
    })()`) as number;
    const { profile } = await cdp.send('Profiler.stop') as { profile: { nodes: Node[]; samples: number[]; timeDeltas: number[] } };
    const self = new Map<string, number>(), total = profile.samples.length;
    const byId = new Map(profile.nodes.map(n => [n.id, n]));
    for (const id of profile.samples) {
      const n = byId.get(id)!; const cf = n.callFrame;
      const file = cf.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '').replace(/^.*node_modules\/\.vite\/deps\//, 'three:');
      const k = `${cf.functionName || '(anon)'} ${file}:${cf.lineNumber + 1}`;
      self.set(k, (self.get(k) ?? 0) + 1);
    }
    const tm = await page.evaluate('JSON.stringify(window.__tm && window.__tm.timings)');
    console.log(`■ ${t}: ctor ${Math.round(ms)} ms; trackMesh timings ${tm}`);
    for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log(`   ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`);
  }
  await browser.close();
})();
