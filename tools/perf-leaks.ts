/**
 * GPU-resource leak finder: tracks every geometry / texture the renderer uploads (three.js registers a
 * 'dispose' listener on first upload) and lists the ones still alive after race start → end cycles.
 *   npx tsx tools/perf-leaks.ts [--url http://127.0.0.1:8244] [--quality medium] [--tracks a,b,c]
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const arg = (name: string, def: string): string => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1]! : def; };
const url = arg('url', 'http://127.0.0.1:8244');
const quality = arg('quality', 'medium');
const tracks = arg('tracks', 'sunny-meadow,neon-city,sunny-meadow').split(',');
const RACERS = ['kiki', 'pip', 'bruno', 'mochi', 'rex', 'taro', 'hana', 'bolt'];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 480, height: 270 }, bypassCSP: true });
  page.setDefaultTimeout(900000);
  await page.goto(`${url}/?debug&quality=${quality}`);
  await page.waitForFunction(`window.__turbo && window.__turbo.ready && window.__turbo.state().quality === ${JSON.stringify(quality)}`, undefined, { polling: 250 });
  await page.evaluate(`(() => {
    const r = window.__turbo.view.pipeline.renderer;
    let geo = null; window.__turbo.view.showroom.scene.traverse(o => { if (!geo && o.geometry) geo = o.geometry; });
    let ED = Object.getPrototypeOf(geo); while (Object.getPrototypeOf(ED) && Object.getPrototypeOf(ED) !== Object.prototype) ED = Object.getPrototypeOf(ED);
    const live = window.__live = new Map(); let seq = 0; window.__phase = 'menu';
    const born = () => (new Error().stack || '').split(String.fromCharCode(10)).filter(l => (/\\.ts[?:]/.test(l) && !l.includes('/node_modules/'))).slice(0, 3)
      .map(l => l.trim().replace(/^at /, '').replace(/\\(?https?:\\/\\/[^/]+\\//, '').replace(/\\?[^:]*/, '').replace(/\\)$/, '')).join(' < ');
    // creation sites: geometries get attributes when built, textures get needsUpdate when filled
    let GP = Object.getPrototypeOf(geo); while (GP && !Object.prototype.hasOwnProperty.call(GP, 'setAttribute')) GP = Object.getPrototypeOf(GP);
    const setAttr = GP.setAttribute;
    GP.setAttribute = function (...a) { if (!this.__born) this.__born = born(); return setAttr.apply(this, a); };
    let tex = null; window.__turbo.view.showroom.scene.traverse(o => { const m = o.material; if (!tex && m && m.map) tex = m.map; });
    if (tex) {
      let TP = Object.getPrototypeOf(tex); while (TP && !Object.getOwnPropertyDescriptor(TP, 'needsUpdate')) TP = Object.getPrototypeOf(TP);
      const d = Object.getOwnPropertyDescriptor(TP, 'needsUpdate');
      Object.defineProperty(TP, 'needsUpdate', { configurable: true, get: d.get, set(v) { if (!this.__born) this.__born = born(); d.set.call(this, v); } });
    }
    const add = ED.addEventListener;
    ED.addEventListener = function (type, fn) {
      if (type === 'dispose' && (this.isBufferGeometry || this.isTexture) && !live.has(this)) {
        // first frames of OUR code on the stack (three.js internals skipped)
        const st = (new Error().stack || '').split(String.fromCharCode(10)).filter(l => (/\\.ts[?:]/.test(l) && !l.includes('/node_modules/'))).slice(0, 4)
          .map(l => l.trim().replace(/^at /, '').replace(/\\(?https?:\\/\\/[^/]+\\//, '').replace(/\\?[^:]*/, '').replace(/\\)$/, '')).join(' < ');
        live.set(this, { id: seq++, kind: this.isTexture ? 'tex' : 'geo', name: this.name || (this.isTexture ? (this.image && this.image.width + 'x' + this.image.height) : this.type), phase: window.__phase, st: this.__born || st });
        const self = this;
        add.call(this, 'dispose', () => live.delete(self));
      }
      return add.call(this, type, fn);
    };
  })()`);
  const frames = (n: number) => page.evaluate(`new Promise(res => { let i = 0; const f = () => (++i >= ${n} ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); })`);
  await frames(5);
  let i = 0;
  for (const t of tracks) {
    i++;
    await page.evaluate(`window.__phase = 'race${i}:${t}'`);
    await page.evaluate(`window.__turbo.startRace(${JSON.stringify({ trackId: t, mode: 'vs', cc: 150, cpuLevel: 'hard', mirror: false, items: true, seed: 99, racers: RACERS.map((c, k) => ({ charId: c, human: k === 7 ? 0 : -1 })) })}, { autopilotHuman: true })`);
    await page.waitForFunction('window.__turbo.state().inRace && (window.__turbo.view.skipIntro(), window.__turbo.state().raceSeconds > 1)', undefined, { polling: 500 });
    await page.evaluate(`window.__phase = 'end${i}'; window.__turbo.view.endRace()`);
    await frames(5);
    const s = await page.evaluate(`(() => { const out = {}; for (const v of window.__live.values()) { if (v.phase === 'menu') continue; const k = v.phase + ' ' + v.kind + ' ' + v.name + ' @ ' + v.st; out[k] = (out[k] || 0) + 1; } return out; })()`) as Record<string, number>;
    const info = await page.evaluate('(() => { const m = window.__turbo.view.pipeline.renderer.info.memory; return m.geometries + " geo / " + m.textures + " tex"; })()');
    console.log(`after end ${i} (${t}): renderer ${info}; still alive from races:`);
    for (const [k, n] of Object.entries(s).sort((a, b) => b[1] - a[1])) console.log(`   ${n}× ${k}`);
  }
  await browser.close();
})();
