/**
 * Shadow-camera stability check: moves the shadow focus in sub-texel steps (like a kart driving) with the
 * game loop frozen, renders, and verifies the light-space position of fixed world points moves by whole
 * shadow-map texels only (texel snapping → no shimmering), and that the box stays centred on the focus.
 *   npx tsx tools/perf-shadow.ts [--url http://127.0.0.1:8244] [--quality high]
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const arg = (name: string, def: string): string => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1]! : def; };
const url = arg('url', 'http://127.0.0.1:8244');
const quality = arg('quality', 'high');
const RACERS = ['kiki', 'pip', 'bruno', 'mochi', 'rex', 'taro', 'hana', 'bolt'];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 320, height: 180 }, bypassCSP: true });
  page.setDefaultTimeout(1800000);
  await page.goto(`${url}/?debug&quality=${quality}`);
  await page.waitForFunction(`window.__turbo && window.__turbo.ready && window.__turbo.state().quality === ${JSON.stringify(quality)}`, undefined, { polling: 250 });
  await page.evaluate(`window.__turbo.startRace(${JSON.stringify({ trackId: 'sunny-meadow', mode: 'vs', cc: 150, cpuLevel: 'hard', mirror: false, items: true, seed: 99, racers: RACERS.map((c, k) => ({ charId: c, human: k === 7 ? 0 : -1 })) })}, { autopilotHuman: true })`);
  await page.waitForFunction('window.__turbo.state().inRace && (window.__turbo.view.skipIntro(), !window.__turbo.state().intro)', undefined, { polling: 500 });
  const res = await page.evaluate(`(() => {
    const v = window.__turbo.view; cancelAnimationFrame(v.raf);
    const s = v.session, pipe = s.deps.pipeline;
    let sun = null; s.scene.traverse(o => { if (o.isDirectionalLight) sun = o; });
    const cam = s.cameras[0].camera, sc = sun.shadow.camera;
    const texel = (sc.right - sc.left) / sun.shadow.mapSize.x;
    const V = cam.position.constructor;
    const pts = [new V(0, 0, 0), new V(137.3, 2.1, -58.9), new V(-311.7, 7.5, 222.2)];
    const size = pipe.resize();
    const views = [{ camera: cam, viewport: { x: 0, y: 0, w: size.width, h: size.height }, speedLines: 0, inkAmount: 0 }];
    const g = s.track.grid[0];
    let maxFrac = 0, maxCentreErr = 0, moves = 0, last = null;
    const q = new V();
    for (let f = 0; f < 48; f++) {
      const fx = g.x + f * 0.173, fz = g.z + f * 0.091; // ≈ 12 m/s at 60 fps: sub-texel steps
      cam.position.set(fx - 6, g.y + 3, fz - 6); cam.lookAt(fx + 10, g.y, fz + 10); cam.updateMatrixWorld();
      pipe.setShadowFocus(fx, g.y, fz);
      pipe.render(s.scene, views, 1 / 60);
      for (const p of pts) {
        q.copy(p).applyMatrix4(sc.matrixWorldInverse);
        const ax = (q.x - sc.left) / texel, ay = (q.y - sc.bottom) / texel;
        // the fractional texel position of a fixed world point must never change (whole-texel moves only)
        const key = [ax % 1, ay % 1].map(x => ((x % 1) + 1) % 1);
        if (!p.__k) p.__k = key; else maxFrac = Math.max(maxFrac, Math.min(Math.abs(key[0] - p.__k[0]), 1 - Math.abs(key[0] - p.__k[0])), Math.min(Math.abs(key[1] - p.__k[1]), 1 - Math.abs(key[1] - p.__k[1])));
      }
      // focus (+ look-ahead) must stay well inside the box
      q.set(fx, g.y, fz).applyMatrix4(sc.matrixWorldInverse);
      maxCentreErr = Math.max(maxCentreErr, Math.hypot(q.x, q.y));
      const cp = sc.position.x.toFixed(3) + ',' + sc.position.z.toFixed(3);
      if (last !== null && cp !== last) moves++;
      last = cp;
    }
    return { texel: +texel.toFixed(5), mapSize: sun.shadow.mapSize.x, subTexelDriftTexels: +maxFrac.toFixed(5), boxMoves: moves, maxFocusOffsetM: +maxCentreErr.toFixed(2), halfExtentM: sc.right };
  })()`);
  console.log(JSON.stringify(res));
  await browser.close();
})();
