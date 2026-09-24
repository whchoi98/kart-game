/**
 * Rasterise the SVG app icons into the PNG sizes platforms require
 * (Android/Chrome install: 192 + 512, maskable 512; iOS home screen: 180).
 *   npx tsx tools/gen-icons.ts        → public/icons/*.png
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = 'public/icons';

/** Full-bleed artwork: the brand gradient + racing stripes with the round emblem centred
 *  at 62 % (well inside the maskable safe zone, a circle of radius 40 %). */
function composedMaskable(): string {
  const emblem = readFileSync('public/favicon.svg', 'utf8').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7b3dff"/><stop offset=".55" stop-color="#ff3d8b"/><stop offset="1" stop-color="#ff8a1f"/>
  </linearGradient></defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g opacity=".16" stroke="#fff" stroke-width="30" stroke-linecap="round">
    <path d="M-40 150 L150 -40"/><path d="M-40 330 L330 -40"/><path d="M180 552 L552 180"/><path d="M360 552 L552 360"/>
  </g>
  <g transform="translate(96 96) scale(5)">${emblem}</g>
</svg>`;
}
const jobs: Array<{ src: string; size: number; out: string; pad?: number; bg?: string; svg?: () => string }> = [
  // "any" icons: the round emblem on a transparent square
  { src: 'public/favicon.svg', size: 192, out: 'icon-192.png', pad: 0.04 },
  { src: 'public/favicon.svg', size: 512, out: 'icon-512.png', pad: 0.04 },
  // maskable: full-bleed artwork (safe zone is the inner 80 %)
  { src: '', svg: composedMaskable, size: 512, out: 'icon-maskable-512.png' },
  { src: '', svg: composedMaskable, size: 192, out: 'icon-maskable-192.png' },
  // iOS ignores transparency and rounds corners itself: use the full-bleed art
  { src: '', svg: composedMaskable, size: 180, out: 'apple-touch-icon.png' },
];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const j of jobs) {
    const svg = j.svg ? j.svg() : readFileSync(j.src, 'utf8');
    const inset = Math.round(j.size * (j.pad ?? 0));
    await page.setViewportSize({ width: j.size, height: j.size });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:${j.bg ?? 'transparent'}">
      <div style="width:${j.size}px;height:${j.size}px;padding:${inset}px;box-sizing:border-box">
        ${svg.replace('<svg ', `<svg width="${j.size - inset * 2}" height="${j.size - inset * 2}" `)}
      </div></body></html>`);
    await page.screenshot({ path: `${OUT}/${j.out}`, omitBackground: true, clip: { x: 0, y: 0, width: j.size, height: j.size } });
    console.log(`${OUT}/${j.out}`);
  }
  await browser.close();
}

void main();
