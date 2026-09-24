/**
 * Original SVG icons for all 14 items, coloured from ITEMS (src/sim/item-defs.ts).
 * viewBox 0 0 64 64; flat fills + ink outlines; no ids.
 */
import { ITEMS } from '../../../sim/item-defs.js';
import type { ItemId } from '../../../sim/types.js';
import { INK } from './portraits.js';

const S = `stroke="${INK}" stroke-linejoin="round" stroke-linecap="round"`;

function banana(c: string, c2: string): string {
  return `
    <path d="M13 39 C17 51 35 55 48 45 C55 40 57 31 54.5 22.5 C52 29.5 46 37.5 36 40 C27.5 42 19.5 42 13 39Z" fill="${c}" ${S} stroke-width="3"/>
    <path d="M18.5 43.5 C27 47.5 39 47 46.5 40.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity=".65"/>
    <path d="M51 23.5 L53 14.5 L58 16.5 L55.5 24.5Z" fill="${c2}" ${S} stroke-width="2.6"/>
    <path d="M11.5 37.5 L15.5 40.5" stroke="${c2}" stroke-width="4" stroke-linecap="round"/>`;
}

function orb(c: string, c2: string): string {
  return `
    <circle cx="32" cy="32" r="21" fill="${c}"/>
    <path d="M11.5 29 C21 38.5 43 38.5 52.5 29" fill="none" stroke="${c2}" stroke-width="5.5"/>
    <path d="M11.5 29 C21 38.5 43 38.5 52.5 29" fill="none" stroke="#fff" stroke-width="1.4" opacity=".35" transform="translate(0 -3.2)"/>
    <ellipse cx="23.5" cy="21" rx="7" ry="4.4" transform="rotate(-32 23.5 21)" fill="#fff" opacity=".75"/>
    <circle cx="32" cy="32" r="21" fill="none" ${S} stroke-width="3"/>`;
}

function rocket(c: string, c2: string): string {
  return `<g transform="rotate(38 32 32)">
    <path d="M26 46 L32 60 L38 46Z" fill="#ffb020" ${S} stroke-width="2.4"/>
    <path d="M29 46 L32 53.5 L35 46Z" fill="#fff3a0"/>
    <path d="M22.5 35 L14 48 L22.5 46Z M41.5 35 L50 48 L41.5 46Z" fill="${c2}" ${S} stroke-width="2.6"/>
    <path d="M32 4.5 C40.5 11 42 23 42 35 L42 46.5 L22 46.5 L22 35 C22 23 23.5 11 32 4.5Z" fill="${c}" ${S} stroke-width="3"/>
    <path d="M26.5 32 V42" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity=".45"/>
    <circle cx="32" cy="23.5" r="5.2" fill="#bfe9ff" ${S} stroke-width="2.4"/>
    <path d="M22 38.5 H42" stroke="${c2}" stroke-width="3"/>
  </g>`;
}

function nitro(c: string, c2: string): string {
  return `
    <rect x="26" y="7" width="12" height="10" rx="3" fill="#9aa0b8" ${S} stroke-width="2.6"/>
    <rect x="19.5" y="15.5" width="25" height="41" rx="8.5" fill="${c}" ${S} stroke-width="3"/>
    <path d="M24.5 22 V49" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".45"/>
    <path d="M35 22.5 L27 37.5 H33 L29.5 50.5 L39.5 33.5 H33.5 L37 22.5Z" fill="${c2}" ${S} stroke-width="2.2"/>`;
}

function triple(inner: string): string {
  return `<g transform="translate(13.4 1.5) scale(.58)">${inner}</g>
    <g transform="translate(0 26.5) scale(.58)">${inner}</g>
    <g transform="translate(26.8 26.5) scale(.58)">${inner}</g>`;
}

function star(c: string, c2: string): string {
  return `
    <path d="M54.5 5.5 l1.6 4.2 4.2 1.6 -4.2 1.6 -1.6 4.2 -1.6 -4.2 -4.2 -1.6 4.2 -1.6z" fill="${c2}"/>
    <path d="M9 45.5 l1.2 3.1 3.1 1.2 -3.1 1.2 -1.2 3.1 -1.2 -3.1 -3.1 -1.2 3.1 -1.2z" fill="${c2}"/>
    <path d="M32 5 L39.6 22.4 L58.4 24.2 L44.2 36.7 L48.4 55.2 L32 45.5 L15.6 55.2 L19.8 36.7 L5.6 24.2 L24.4 22.4Z" fill="${c}" ${S} stroke-width="3.2"/>
    <path d="M32 13 L36.4 23.6 L47.5 24.8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity=".7"/>
    <ellipse cx="27" cy="32.5" rx="2.5" ry="3.8" fill="${INK}"/><ellipse cx="37" cy="32.5" rx="2.5" ry="3.8" fill="${INK}"/>
    <path d="M28 40 Q32 43.5 36 40" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`;
}

function thunder(c: string, c2: string): string {
  return `
    <path d="M16 39 C7 39 7 26 16.5 25 C17.5 14.5 31 11.5 36 19.5 C40.5 13.5 53 16 51.5 26 C60 26.5 60.5 39 51.5 39 Z" fill="${c}" ${S} stroke-width="3"/>
    <path d="M17.5 30.5 C18.5 24.5 23.5 21.5 29 22.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity=".75"/>
    <path d="M34 33 L24.5 48.5 H31.5 L27 61 L41.5 43 H34.5 L39 33Z" fill="${c2}" ${S} stroke-width="2.6"/>`;
}

function ink(c: string, c2: string): string {
  return `
    <circle cx="32" cy="32" r="29" fill="${c2}" opacity=".35"/>
    <path d="M20 37 C18 45 12 49 14 56 M27 37.5 C26 47 23.5 52 26 58.5 M37 37.5 C38 47 40.5 52 38 58.5 M44 37 C46 45 52 49 50 56" fill="none" stroke="${INK}" stroke-width="8.5" stroke-linecap="round"/>
    <path d="M20 37 C18 45 12 49 14 56 M27 37.5 C26 47 23.5 52 26 58.5 M37 37.5 C38 47 40.5 52 38 58.5 M44 37 C46 45 52 49 50 56" fill="none" stroke="${c}" stroke-width="4.5" stroke-linecap="round"/>
    <path d="M32 5 C44.5 5 50.5 17 48.5 29.5 L46.5 39 L17.5 39 L15.5 29.5 C13.5 17 19.5 5 32 5Z" fill="${c}" ${S} stroke-width="3"/>
    <circle cx="32" cy="13.5" r="3" fill="${c2}"/><circle cx="24" cy="18" r="2" fill="${c2}"/><circle cx="40" cy="17.5" r="2.2" fill="${c2}"/>
    <circle cx="25" cy="28" r="5.2" fill="#fff" ${S} stroke-width="2"/><circle cx="26.2" cy="29" r="2.5" fill="${INK}"/>
    <circle cx="39" cy="28" r="5.2" fill="#fff" ${S} stroke-width="2"/><circle cx="37.8" cy="29" r="2.5" fill="${INK}"/>
    <path d="M55 42 C55 42 61 49.5 61 53.5 C61 57 58.3 59.6 55 59.6 C51.7 59.6 49 57 49 53.5 C49 49.5 55 42 55 42Z" fill="${INK}"/>
    <ellipse cx="53" cy="52" rx="1.4" ry="2.4" fill="${c2}" opacity=".8"/>`;
}

function autopilot(c: string, c2: string): string {
  return `<circle cx="32" cy="32" r="29" fill="${c2}" opacity=".22"/><g transform="rotate(-18 32 32)">
    <path d="M12.5 26.5 L1.5 32 L12.5 37.5Z" fill="#ffb020" ${S} stroke-width="2.2"/>
    <path d="M12.5 29 L6 32 L12.5 35Z" fill="#fff3a0"/>
    <rect x="11.5" y="24.5" width="7" height="15" rx="1.5" fill="#9aa0b8" ${S} stroke-width="2.4"/>
    <path d="M18.5 22 L10 13 L15 26Z M18.5 42 L10 51 L15 38Z" fill="${c2}" ${S} stroke-width="2.4"/>
    <path d="M18.5 21.5 H40 C52.5 21.5 60 27.5 60 32 C60 36.5 52.5 42.5 40 42.5 H18.5 Z" fill="${c}" ${S} stroke-width="3"/>
    <rect x="24" y="22.5" width="5" height="19" fill="${c2}"/>
    <rect x="32" y="22.5" width="5" height="19" fill="${c2}"/>
    <path d="M24 26.5 H45" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".35"/>
    <circle cx="47.5" cy="32" r="4.6" fill="#bfe9ff" ${S} stroke-width="2.2"/>
  </g>`;
}

function skybomb(c: string, c2: string): string {
  return `
    <path d="M16.5 31 C7 22 3.5 29.5 1.5 35 C7.5 34.5 11.5 36 16.5 39Z" fill="${c2}" ${S} stroke-width="2.6"/>
    <path d="M47.5 31 C57 22 60.5 29.5 62.5 35 C56.5 34.5 52.5 36 47.5 39Z" fill="${c2}" ${S} stroke-width="2.6"/>
    <path d="M32 15 C32 9 37.5 6.5 40.5 4.5" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M42 0.8 l1.6 3.1 3.3 .9 -2.8 1.9 .4 3.4 -2.5 -2.2 -3.2 1.1 1.3 -3.1 -1.8 -2.9 3.4 .3z" fill="#ffd23f" ${S} stroke-width="1"/>
    <rect x="26.5" y="14" width="11" height="7.5" rx="2.2" fill="#9aa0b8" ${S} stroke-width="2.4"/>
    <circle cx="32" cy="37" r="17.5" fill="${c}" ${S} stroke-width="3"/>
    <ellipse cx="24.5" cy="29" rx="5.4" ry="3.2" transform="rotate(-35 24.5 29)" fill="#fff" opacity=".55"/>
    <path d="M23.5 35 L30 37 M40.5 35 L34 37" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>
    <circle cx="27" cy="40" r="2.3" fill="#fff"/><circle cx="37" cy="40" r="2.3" fill="#fff"/>`;
}

function coins(c: string, c2: string): string {
  return `
    <path d="M24 25 C22.5 17 28.5 13.5 32 17.5 C35.5 13.5 41.5 17 40 25Z" fill="${c2}" ${S} stroke-width="2.6"/>
    <path d="M21.5 25.5 C11.5 35.5 11 56.5 32 56.5 C53 56.5 52.5 35.5 42.5 25.5 Z" fill="${c2}" ${S} stroke-width="3"/>
    <path d="M22.5 26 Q32 31 41.5 26" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
    <path d="M19.5 38 C19 45 21.5 50.5 27 52.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".35"/>
    <circle cx="31" cy="42.5" r="6.4" fill="${c}" ${S} stroke-width="2.2"/>
    <circle cx="46.5" cy="48.5" r="9" fill="${c}" ${S} stroke-width="2.6"/>
    <circle cx="46.5" cy="48.5" r="5.2" fill="none" stroke="${c2}" stroke-width="1.8"/>
    <circle cx="14.5" cy="52" r="6.5" fill="${c}" ${S} stroke-width="2.4"/>
    <path d="M13 49.5 v5" stroke="${c2}" stroke-width="1.8" stroke-linecap="round"/>`;
}

const DRAW: Record<ItemId, (c: string, c2: string) => string> = {
  banana, banana3: (c, c2) => triple(banana(c, c2)),
  orb, orb3: (c, c2) => triple(orb(c, c2)),
  rocket, rocket3: (c, c2) => triple(rocket(c, c2)),
  nitro, nitro3: (c, c2) => triple(nitro(c, c2)),
  star, thunder, ink, autopilot, skybomb, coins,
};

const cache = new Map<ItemId, string>();

export function itemSvg(id: ItemId): string {
  const hit = cache.get(id);
  if (hit) return hit;
  const def = ITEMS[id];
  const markup = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${def.name}">${DRAW[id](def.color, def.color2)}</svg>`;
  cache.set(id, markup);
  return markup;
}

/** Gold coin used by the HUD coin counter. */
export const COIN_SVG = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <ellipse cx="32" cy="35" rx="24" ry="24" fill="#b8860b" ${S} stroke-width="4"/>
  <circle cx="32" cy="31" r="24" fill="#ffc300" ${S} stroke-width="4"/>
  <circle cx="32" cy="31" r="16" fill="none" stroke="#e29b00" stroke-width="3"/>
  <path d="M32 20 l3.2 7 7.6 .7 -5.8 5 1.8 7.4 -6.8 -4 -6.8 4 1.8 -7.4 -5.8 -5 7.6 -.7z" fill="#fff6c2"/>
</svg>`;
