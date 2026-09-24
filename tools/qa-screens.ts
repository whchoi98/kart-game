/**
 * End-to-end visual QA for the integrated game.
 *   npx tsx tools/qa-screens.ts [--url http://127.0.0.1:8200] [--tracks id,id] [--out test-results/qa] [--quality high]
 *
 * Uses the debug hook exposed by main.ts when the page URL contains `?debug`:
 *   window.__turbo = { view, startRace(config, ghost?), state() }
 * Captures intro / countdown / racing / finish screenshots per track, console errors and
 * renderer stats, and writes a JSON report.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { TRACK_CATALOG } from '../src/sim/tracks/catalog.js';

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : def;
};
const url = arg('url', 'http://127.0.0.1:8200');
const out = arg('out', 'test-results/qa');
const quality = arg('quality', 'high');
const tracks = arg('tracks', TRACK_CATALOG.map(t => t.id).join(',')).split(',').filter(Boolean);
const width = Number(arg('width', '1280')), height = Number(arg('height', '720'));
mkdirSync(out, { recursive: true });

interface TrackReport { track: string; shots: string[]; errors: string[]; stats: unknown[]; hud: unknown }

async function waitFor(page: Page, fn: string, timeout = 30000): Promise<void> {
  await page.waitForFunction(fn, undefined, { timeout, polling: 200 });
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const reports: TrackReport[] = [];
  for (const track of tracks) {
    const page = await browser.newPage({ viewport: { width, height }, bypassCSP: true });
    page.setDefaultTimeout(240000);
    const errors: string[] = [];
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
    page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`));
    await page.goto(`${url}/?debug&quality=${quality}`, { waitUntil: 'load' });
    await waitFor(page, 'window.__turbo && window.__turbo.ready');
    const shots: string[] = [];
    const stats: unknown[] = [];
    const shot = async (name: string) => {
      const file = path.join(out, `${track}-${name}.png`);
      await page.screenshot({ path: file, timeout: 240000 });
      shots.push(file);
      stats.push({ name, ...(await page.evaluate('window.__turbo.state()') as object) });
    };
    await page.evaluate(`window.__turbo.startRace({ trackId: ${JSON.stringify(track)}, mode: 'vs', cc: 150, cpuLevel: 'hard', mirror: false, items: true, seed: 99,
      racers: ['kiki','pip','bruno','mochi','rex','taro','hana','bolt'].map((c, i) => ({ charId: c, human: i === 7 ? 0 : -1 })) }, { autopilotHuman: true })`);
    await page.waitForTimeout(2500);
    await shot('intro');
    await page.evaluate('window.__turbo.view.skipIntro()');
    await page.waitForTimeout(1600);
    await shot('countdown');
    await waitFor(page, 'window.__turbo.state().raceSeconds > 6', 90000);
    await shot('race-early');
    await waitFor(page, 'window.__turbo.state().raceSeconds > 20', 180000);
    await shot('race-mid');
    const hud = await page.evaluate('window.__turbo.view.hud(0)');
    reports.push({ track, shots, errors, stats, hud });
    console.log(`■ ${track}: ${shots.length} shots, ${errors.length} console errors/warnings`);
    for (const e of errors.slice(0, 8)) console.log('   ', e);
    await page.close();
  }
  await browser.close();
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(reports, null, 2));
}

void main();
