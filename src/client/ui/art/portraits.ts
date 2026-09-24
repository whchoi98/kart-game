/**
 * Original inline-SVG driver portraits, one per species, painted with each
 * character's colours (src/sim/characters.ts). Flat fills + thick ink outlines,
 * no <defs>/ids so any number of copies can coexist in the DOM.
 */
import { getCharacter } from '../../../sim/characters.js';
import type { CharacterDef, CharacterId, Species } from '../../../sim/types.js';

export const INK = '#1b1036';

/** Mix two #rrggbb colours (t = 0 → a, 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const c = pa.map((v, i) => Math.round(v + (pb[i]! - v) * t));
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1]!, 16) : 0x888888;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

type C = CharacterDef['colors'];
const S = `stroke="${INK}" stroke-linejoin="round" stroke-linecap="round"`;

const HEADS: Record<Species, (c: C) => string> = {
  penguin: c => `
    <path d="M47 25 Q50 17 55 21" fill="none" stroke="${c.fur}" stroke-width="4" stroke-linecap="round"/>
    <ellipse cx="50" cy="51" rx="27" ry="26" fill="${c.fur}" ${S} stroke-width="3"/>
    <path d="M50 40 C44 32 30 35 30 49 C30 63 40 71 50 71 C60 71 70 63 70 49 C70 35 56 32 50 40Z" fill="#fff"/>
    <ellipse cx="41" cy="51" rx="4" ry="5" fill="${INK}"/><circle cx="42.4" cy="49.2" r="1.6" fill="#fff"/>
    <ellipse cx="59" cy="51" rx="4" ry="5" fill="${INK}"/><circle cx="60.4" cy="49.2" r="1.6" fill="#fff"/>
    <ellipse cx="35.5" cy="60" rx="4" ry="2.4" fill="#ff7aa8" opacity=".55"/>
    <ellipse cx="64.5" cy="60" rx="4" ry="2.4" fill="#ff7aa8" opacity=".55"/>
    <path d="M42.5 58.5 Q50 54.5 57.5 58.5 Q50 67 42.5 58.5Z" fill="${c.detail}" ${S} stroke-width="2.2"/>
    <path d="M26 37 Q50 26 74 37" fill="none" stroke="${c.accent}" stroke-width="5" stroke-linecap="round"/>
    <circle cx="40" cy="32.5" r="6" fill="#bfe9ff" ${S} stroke-width="2.4"/>
    <circle cx="60" cy="32.5" r="6" fill="#bfe9ff" ${S} stroke-width="2.4"/>
    <path d="M37.5 30.5 l2.5 -1.5 M57.5 30.5 l2.5 -1.5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`,

  bear: c => {
    const light = mix(c.fur, '#ffffff', 0.45);
    return `
    <circle cx="28" cy="31" r="10" fill="${c.fur}" ${S} stroke-width="3"/><circle cx="28" cy="31" r="5" fill="${light}"/>
    <circle cx="72" cy="31" r="10" fill="${c.fur}" ${S} stroke-width="3"/><circle cx="72" cy="31" r="5" fill="${light}"/>
    <ellipse cx="50" cy="52" rx="28" ry="26" fill="${c.fur}" ${S} stroke-width="3"/>
    <path d="M25 38 Q50 25 75 38" fill="none" stroke="${c.accent}" stroke-width="5" stroke-linecap="round"/>
    <path d="M33 42 L44 44.5 M67 42 L56 44.5" stroke="${c.detail}" stroke-width="3.2" stroke-linecap="round"/>
    <circle cx="39.5" cy="49.5" r="3.6" fill="${INK}"/><circle cx="40.6" cy="48.2" r="1.2" fill="#fff"/>
    <circle cx="60.5" cy="49.5" r="3.6" fill="${INK}"/><circle cx="61.6" cy="48.2" r="1.2" fill="#fff"/>
    <ellipse cx="50" cy="63" rx="13.5" ry="10" fill="${light}" ${S} stroke-width="2.2"/>
    <ellipse cx="50" cy="58.5" rx="5.2" ry="3.7" fill="${c.detail}"/>
    <path d="M50 62 v3.6 M45 66.4 Q50 69.6 55 66.4" fill="none" stroke="${c.detail}" stroke-width="2.2" stroke-linecap="round"/>`;
  },

  rabbit: c => `
    <ellipse cx="38" cy="25" rx="8" ry="20" transform="rotate(-10 38 25)" fill="${c.fur}" ${S} stroke-width="3"/>
    <ellipse cx="38" cy="26" rx="3.8" ry="14" transform="rotate(-10 38 26)" fill="${c.detail}" opacity=".7"/>
    <ellipse cx="62" cy="25" rx="8" ry="20" transform="rotate(10 62 25)" fill="${c.fur}" ${S} stroke-width="3"/>
    <ellipse cx="62" cy="26" rx="3.8" ry="14" transform="rotate(10 62 26)" fill="${c.detail}" opacity=".7"/>
    <ellipse cx="50" cy="56" rx="26" ry="23" fill="${c.fur}" ${S} stroke-width="3"/>
    <path d="M40 37 Q46 33 50 38 Q54 33 60 37" fill="none" stroke="${c.detail}" stroke-width="2.4" stroke-linecap="round" opacity=".8"/>
    <ellipse cx="40" cy="54" rx="4.5" ry="5.6" fill="${INK}"/><circle cx="41.6" cy="51.8" r="1.9" fill="#fff"/>
    <ellipse cx="60" cy="54" rx="4.5" ry="5.6" fill="${INK}"/><circle cx="61.6" cy="51.8" r="1.9" fill="#fff"/>
    <ellipse cx="33.5" cy="62" rx="4.6" ry="2.8" fill="${c.detail}" opacity=".45"/>
    <ellipse cx="66.5" cy="62" rx="4.6" ry="2.8" fill="${c.detail}" opacity=".45"/>
    <path d="M47.4 61 h5.2 l-2.6 3.1z" fill="${c.detail}" ${S} stroke-width="1.4"/>
    <path d="M50 64.2 q-3 4 -6 1.2 M50 64.2 q3 4 6 1.2" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>
    <rect x="48" y="65.6" width="4" height="3.6" rx="1" fill="#fff" ${S} stroke-width="1.2"/>`,

  dino: c => {
    const light = mix(c.fur, '#ffffff', 0.4);
    return `
    <path d="M32 33 L37 18 L45 29 Z M44 28 L50 12 L56 28 Z M55 29 L63 18 L68 33 Z" fill="${c.accent}" ${S} stroke-width="2.6"/>
    <path d="M24 52 C24 35 36 26 50 26 C64 26 76 35 76 52 C76 70 66 78 50 78 C34 78 24 70 24 52Z" fill="${c.fur}" ${S} stroke-width="3"/>
    <circle cx="29.5" cy="55" r="2.6" fill="${c.detail}" opacity=".45"/><circle cx="70.5" cy="55" r="2.6" fill="${c.detail}" opacity=".45"/>
    <circle cx="33" cy="61" r="1.8" fill="${c.detail}" opacity=".45"/><circle cx="67" cy="61" r="1.8" fill="${c.detail}" opacity=".45"/>
    <ellipse cx="50" cy="63.5" rx="19.5" ry="12" fill="${light}" ${S} stroke-width="2.2"/>
    <circle cx="44" cy="59" r="1.9" fill="${c.detail}"/><circle cx="56" cy="59" r="1.9" fill="${c.detail}"/>
    <path d="M36 66.5 Q50 74.5 64 66.5" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M41 68.3 l2.2 3.2 l2 -2.4 Z M55 69.1 l2 2.4 l2.2 -3.2 Z" fill="#fff" ${S} stroke-width="1.3"/>
    <path d="M30.5 37.5 Q38 33 44.5 37.5 M55.5 37.5 Q62 33 69.5 37.5" stroke="${c.detail}" stroke-width="2.8" fill="none" stroke-linecap="round"/>
    <circle cx="38" cy="45.5" r="6.6" fill="#fff" ${S} stroke-width="2.2"/><circle cx="39.6" cy="46" r="3.4" fill="${INK}"/><circle cx="40.6" cy="44.6" r="1.1" fill="#fff"/>
    <circle cx="62" cy="45.5" r="6.6" fill="#fff" ${S} stroke-width="2.2"/><circle cx="60.4" cy="46" r="3.4" fill="${INK}"/><circle cx="61.4" cy="44.6" r="1.1" fill="#fff"/>`;
  },

  fox: c => `
    <path d="M24 42 L27 13 L47 30 Z" fill="${c.fur}" ${S} stroke-width="3"/>
    <path d="M29.5 33 L30.5 20 L39.5 28.5 Z" fill="${c.accent}"/>
    <path d="M76 42 L73 13 L53 30 Z" fill="${c.fur}" ${S} stroke-width="3"/>
    <path d="M70.5 33 L69.5 20 L60.5 28.5 Z" fill="${c.accent}"/>
    <path d="M50 28 C66 28 78 38 78 50 C78 56 74 60 68 64 L54 76 Q50 79 46 76 L32 64 C26 60 22 56 22 50 C22 38 34 28 50 28Z" fill="${c.fur}"/>
    <path d="M23 51 C30 49 41 53 50 63 C59 53 70 49 77 51 C75 57 71 61 67 64.5 L54 75.5 Q50 78.6 46 75.5 L33 64.5 C29 61 25 57 23 51Z" fill="${c.detail}"/>
    <path d="M50 28 C66 28 78 38 78 50 C78 56 74 60 68 64 L54 76 Q50 79 46 76 L32 64 C26 60 22 56 22 50 C22 38 34 28 50 28Z" fill="none" ${S} stroke-width="3"/>
    <path d="M44 34 Q50 30 56 34" fill="none" stroke="${c.detail}" stroke-width="2.4" stroke-linecap="round" opacity=".7"/>
    <path d="M33.5 47 Q40 41.5 46.5 47 Q40 50.5 33.5 47Z" fill="${INK}"/><circle cx="41.4" cy="45.8" r="1.2" fill="#fff"/>
    <path d="M53.5 47 Q60 41.5 66.5 47 Q60 50.5 53.5 47Z" fill="${INK}"/><circle cx="61.4" cy="45.8" r="1.2" fill="#fff"/>
    <path d="M31 43 L40 41 M69 43 L60 41" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>
    <ellipse cx="50" cy="69.5" rx="3.8" ry="2.7" fill="${c.accent}"/>
    <path d="M46 73 Q50 75.5 54 73" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>`,

  raccoon: c => `
    <path d="M25 42 C21 27 27 17 41 26 Z" fill="${c.fur}" ${S} stroke-width="3"/>
    <path d="M29 36 C27.5 29 30.5 24.5 36.5 27.5 Z" fill="${c.detail}"/>
    <path d="M75 42 C79 27 73 17 59 26 Z" fill="${c.fur}" ${S} stroke-width="3"/>
    <path d="M71 36 C72.5 29 69.5 24.5 63.5 27.5 Z" fill="${c.detail}"/>
    <ellipse cx="50" cy="52" rx="28" ry="25" fill="${c.fur}" ${S} stroke-width="3"/>
    <path d="M25 38 Q50 26 75 38" fill="none" stroke="${c.accent}" stroke-width="4.6" stroke-linecap="round"/>
    <path d="M30 51 C34 41 44 41 50 47 C56 41 66 41 70 51 C68 65 58 73 50 73 C42 73 32 65 30 51Z" fill="#f4f4f7"/>
    <path d="M25 48 C30 40 42 40 50 47 C58 40 70 40 75 48 C72 56 62 58.5 56 54.5 Q50 52.5 44 54.5 C38 58.5 28 56 25 48Z" fill="${c.detail}"/>
    <circle cx="39" cy="49" r="3.8" fill="#fff"/><circle cx="39.6" cy="49.6" r="2.1" fill="${INK}"/>
    <circle cx="61" cy="49" r="3.8" fill="#fff"/><circle cx="60.4" cy="49.6" r="2.1" fill="${INK}"/>
    <ellipse cx="50" cy="61" rx="4.2" ry="3.1" fill="${c.detail}"/>
    <path d="M44 66 Q50 70 56 66" fill="none" stroke="${c.detail}" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M55.5 67.2 q2.5 3 5 0.5" fill="none" stroke="${c.detail}" stroke-width="1.8" stroke-linecap="round"/>`,

  cat: c => `
    <path d="M24 45 L27 15 L47 30 Z" fill="${c.fur}" ${S} stroke-width="3"/>
    <path d="M29.5 37 L30.5 23 L40.5 30 Z" fill="#ffb3c7"/>
    <path d="M76 45 L73 15 L53 30 Z" fill="${c.detail}" ${S} stroke-width="3"/>
    <path d="M70.5 37 L69.5 23 L59.5 30 Z" fill="#ffb3c7"/>
    <ellipse cx="50" cy="54" rx="29" ry="24" fill="${c.fur}"/>
    <path d="M52 30.5 C64 30 76 38 78.6 50 C71 49 62 45 55 38 Z" fill="${c.detail}"/>
    <path d="M22 58 C26 60 30 64 31 70 C26 68 23 64 22 58Z" fill="${c.detail}" opacity=".85"/>
    <ellipse cx="50" cy="54" rx="29" ry="24" fill="none" ${S} stroke-width="3"/>
    <ellipse cx="39" cy="52" rx="4.6" ry="5.6" fill="#2bb673" ${S} stroke-width="1.6"/>
    <ellipse cx="39" cy="52.2" rx="1.6" ry="4.1" fill="${INK}"/><circle cx="40.6" cy="50" r="1.2" fill="#fff"/>
    <ellipse cx="61" cy="52" rx="4.6" ry="5.6" fill="#2bb673" ${S} stroke-width="1.6"/>
    <ellipse cx="61" cy="52.2" rx="1.6" ry="4.1" fill="${INK}"/><circle cx="62.6" cy="50" r="1.2" fill="#fff"/>
    <path d="M47.4 60 h5.2 l-2.6 2.7z" fill="#ff7aa0" ${S} stroke-width="1.2"/>
    <path d="M50 62.7 q-2.6 3.6 -5.6 1.4 M50 62.7 q2.6 3.6 5.6 1.4" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M19 57 L33 59 M20 64 L33 62.5 M81 57 L67 59 M80 64 L67 62.5" stroke="${INK}" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M32 35 L24 30 L24.6 40.6 Z M32 35 L40 30 L39.4 40.6 Z" fill="${c.accent}" ${S} stroke-width="2"/>
    <circle cx="32" cy="35.2" r="2.8" fill="${c.accent}" ${S} stroke-width="1.8"/>`,

  robot: c => `
    <path d="M50 27 V15" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
    <circle cx="50" cy="12" r="4.6" fill="${c.detail}" ${S} stroke-width="2.4"/>
    <circle cx="48.6" cy="10.6" r="1.4" fill="#fff" opacity=".8"/>
    <rect x="17" y="42" width="9" height="17" rx="3" fill="${c.accent}" ${S} stroke-width="2.4"/>
    <rect x="74" y="42" width="9" height="17" rx="3" fill="${c.accent}" ${S} stroke-width="2.4"/>
    <rect x="24" y="26" width="52" height="47" rx="14" fill="${c.fur}" ${S} stroke-width="3"/>
    <path d="M30 30 h40" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".55"/>
    <rect x="29.5" y="36" width="41" height="21" rx="9.5" fill="${INK}"/>
    <rect x="35.5" y="42" width="10" height="8" rx="4" fill="${c.accent}"/>
    <rect x="54.5" y="42" width="10" height="8" rx="4" fill="${c.accent}"/>
    <path d="M33 39.5 h9" stroke="#fff" stroke-width="1.8" stroke-linecap="round" opacity=".35"/>
    <path d="M40 63.5 h20 M40 67.8 h20" stroke="${c.body}" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="31.5" cy="65" r="2.6" fill="${c.detail}"/><circle cx="68.5" cy="65" r="2.6" fill="${c.detail}"/>
    <circle cx="29.5" cy="31" r="1.5" fill="${c.body}"/><circle cx="70.5" cy="31" r="1.5" fill="${c.body}"/>`,
};

const cache = new Map<CharacterId, string>();

/** Portrait markup (viewBox 0 0 100 100). */
export function portraitSvg(id: CharacterId): string {
  const hit = cache.get(id);
  if (hit) return hit;
  const ch = getCharacter(id);
  const c = ch.colors;
  const suit = mix(c.accent, c.body, c.accent.toLowerCase() === '#ffffff' ? 0.15 : 0);
  const markup = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${ch.name}">
    <circle cx="50" cy="50" r="48" fill="${c.body}"/>
    <path d="M50 2 A48 48 0 0 0 7 72 L50 50Z" fill="#fff" opacity=".13"/>
    <circle cx="50" cy="50" r="42" fill="none" stroke="#fff" stroke-width="2" opacity=".28" stroke-dasharray="3 6"/>
    <path d="M19 88 C25 77 37 72.5 50 72.5 C63 72.5 75 77 81 88 A48 48 0 0 1 19 88Z" fill="${suit}" ${S} stroke-width="3"/>
    <path d="M43 73.5 L50 83 L57 73.5" fill="none" stroke="${c.body}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
    ${HEADS[ch.species](c)}
    <circle cx="50" cy="50" r="48" fill="none" stroke="${INK}" stroke-width="3"/>
  </svg>`;
  cache.set(id, markup);
  return markup;
}
