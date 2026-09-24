// Live PWA check against the deployed site with a real (headless) browser:
//   node tools/verify-live-pwa.mjs [https://my-kart.whchoi.net]
// Release builds carry no ?debug hook, so this drives the real UI only.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const site = (process.argv[2] ?? 'https://my-kart.whchoi.net').replace(/\/$/, '');
const out = 'test-results/live-pwa';
mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`); };

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.setDefaultTimeout(240000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

const resp = await page.goto(`${site}/`, { waitUntil: 'domcontentloaded' });
const tls = await resp.securityDetails();
check('Site loads over HTTPS with a valid certificate', resp.status() === 200 && !!tls, `${resp.status()} ${tls?.protocol} ${tls?.subjectName}`);
await page.waitForFunction(() => (document.getElementById('ui')?.innerText ?? '').includes('TURBO'));
check('Release build has no debug hook', await page.evaluate(() => typeof window.__turbo === 'undefined'));
// the worker registers after the title is shown and precaches the whole game
const t0 = Date.now();
const cacheState = () => page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  const keys = await caches.keys();
  const name = keys.find(k => k.startsWith('turbo-pals-') && /-[a-f0-9]{16,64}$/.test(k));
  const complete = name ? !!(await (await caches.open(name)).match('/__turbo_pals_offline_complete__')) : false;
  return { active: !!reg?.active, name, complete };
});
for (let i = 0; i < 240; i++) {
  const st = await cacheState();
  if (st.active && st.complete) break;
  await page.waitForTimeout(1000);
}
const cached = await page.evaluate(async () => {
  const keys = await caches.keys();
  const name = keys.find(k => k.startsWith('turbo-pals-') && /-[a-f0-9]{16,64}$/.test(k));
  return { name, entries: (await (await caches.open(name)).keys()).length };
});
check('Service worker precached the whole game', cached.entries > 150, `${cached.name}: ${cached.entries} entries in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!navigator.serviceWorker.controller);
check('Page is controlled by the service worker after reload', true);
await page.waitForFunction(() => /오프라인 플레이/.test(document.getElementById('ui')?.innerText ?? ''), undefined, { timeout: 60000 }).catch(() => null);
const chip = await page.evaluate(() => (document.getElementById('ui')?.innerText ?? '').match(/오프라인[^\n]*/)?.[0] ?? '');
check('Offline readiness is shown to the player', /오프라인 플레이/.test(chip), chip);
await page.screenshot({ path: `${out}/title-online.png` });

// go offline and cold-reload: the whole game shell must come from the worker
await ctx.setOffline(true);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (document.getElementById('ui')?.innerText ?? '').includes('TURBO'));
const offlineCanvas = await page.evaluate(() => !!document.querySelector('#view canvas'));
check('Offline cold reload shows the game (title + 3D canvas)', offlineCanvas);
// leave the title like a player would (click, then Enter as a fallback) and wait for the main menu items
const inMenu = () => page.evaluate(() => { const t = document.getElementById('ui')?.innerText ?? ''; return /VS 레이스/.test(t) && /타임 어택/.test(t) && /2인 대전/.test(t); });
for (let i = 0; i < 20 && !(await inMenu()); i++) {
  if (i % 2 === 0) await page.mouse.click(640, 520); else await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
}
const menu = await page.evaluate(() => document.getElementById('ui')?.innerText ?? '');
check('Main menu works offline', await inMenu(), menu.replace(/\s+/g, ' ').slice(0, 110));
await page.screenshot({ path: `${out}/menu-offline.png` });
await ctx.setOffline(false);

const unexpected = errors.filter(e => !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED|fetch/i.test(e));
check('No unexpected console errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} PWA checks passed`);
process.exitCode = failed ? 1 : 0;
