/** Chunky UI glyphs (viewBox 0 0 24 24, currentColor). */

const svg = (body: string) => `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
const ST = 'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';

export const ICON = {
  trophy: svg(`<path d="M7 3.5h10v5.2a5 5 0 0 1-10 0Z" fill="currentColor"/><path d="M7 5.5H4.2a3 3 0 0 0 3.2 4.3M17 5.5h2.8a3 3 0 0 1-3.2 4.3" ${ST}/><path d="M12 13.8v3.4M8 20.5h8M9.5 17.2h5l.8 3.3h-6.6Z" ${ST}/>`),
  flag: svg(`<path d="M5 21V3.5" ${ST}/><path d="M5 4h14v9H5Z" fill="currentColor" opacity=".25"/><path d="M5 4h3.5v3H5Zm7 0h3.5v3H12Zm-3.5 3H12v3H8.5Zm7 0H19v3h-3.5ZM5 10h3.5v3H5Zm7 0h3.5v3H12Z" fill="currentColor"/><path d="M5 4h14v9H5" ${ST}/>`),
  stopwatch: svg(`<circle cx="12" cy="13.5" r="7.5" ${ST}/><path d="M12 13.5V9.5M9.5 2.8h5M18.6 6.4l1.5-1.5" ${ST}/><path d="M12 13.5l3.2 2" ${ST}/>`),
  duo: svg(`<circle cx="8" cy="8.5" r="3.4" fill="currentColor"/><circle cx="16.5" cy="8.5" r="3.4" fill="currentColor" opacity=".6"/><path d="M2.5 20c.6-4 2.8-6 5.5-6s4.9 2 5.5 6Z" fill="currentColor"/><path d="M11.5 20c.6-4 2.3-6 5-6s4.4 2 5 6Z" fill="currentColor" opacity=".6"/>`),
  podium: svg(`<path d="M9 9.5h6V21H9Z" fill="currentColor"/><path d="M2.5 13.5H9V21H2.5ZM15 15.5h6.5V21H15Z" fill="currentColor" opacity=".6"/><path d="M12 2.5l1.2 2.4 2.6.4-1.9 1.8.5 2.6L12 8.4l-2.4 1.3.5-2.6-1.9-1.8 2.6-.4Z" fill="currentColor"/>`),
  gear: svg(`<path d="M10.3 2.5h3.4l.5 2.6 1.8.8 2.2-1.5 2.4 2.4-1.5 2.2.8 1.8 2.6.5v3.4l-2.6.5-.8 1.8 1.5 2.2-2.4 2.4-2.2-1.5-1.8.8-.5 2.6h-3.4l-.5-2.6-1.8-.8-2.2 1.5-2.4-2.4 1.5-2.2-.8-1.8-2.6-.5v-3.4l2.6-.5.8-1.8-1.5-2.2 2.4-2.4 2.2 1.5 1.8-.8Z" fill="currentColor"/><circle cx="12" cy="12" r="3.3" fill="#fff" opacity=".9"/>`),
  gamepad: svg(`<path d="M7 7h10a5 5 0 0 1 4.8 6.3l-1 3.6a2.6 2.6 0 0 1-4.4 1.1L14.2 16H9.8l-2.2 2a2.6 2.6 0 0 1-4.4-1.1l-1-3.6A5 5 0 0 1 7 7Z" fill="currentColor"/><path d="M7.5 10v4M5.5 12h4" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="16" cy="10.8" r="1.2" fill="#fff"/><circle cx="18" cy="13" r="1.2" fill="#fff"/>`),
  heart: svg(`<path d="M12 20.5s-8.5-5.1-8.5-11A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8.5 2.5c0 5.9-8.5 11-8.5 11Z" fill="currentColor"/>`),
  lock: svg(`<rect x="5" y="10.5" width="14" height="10.5" rx="2.6" fill="currentColor"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" ${ST}/><circle cx="12" cy="15.5" r="1.6" fill="#fff"/>`),
  back: svg(`<path d="M14.5 5 7.5 12l7 7" ${ST} stroke-width="3"/>`),
  next: svg(`<path d="M9.5 5l7 7-7 7" ${ST} stroke-width="3"/>`),
  play: svg(`<path d="M7 4.5v15l12.5-7.5Z" fill="currentColor"/>`),
  restart: svg(`<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" ${ST}/><path d="M19.8 3.8v4.6h-4.6" ${ST}/>`),
  home: svg(`<path d="M3.5 11 12 3.8l8.5 7.2" ${ST}/><path d="M6 10v10h4.5v-5.5h3V20H18V10" fill="currentColor"/>`),
  ghost: svg(`<path d="M5 20.5V10a7 7 0 0 1 14 0v10.5l-2.4-1.8-2.3 1.8-2.3-1.8-2.3 1.8-2.3-1.8Z" fill="currentColor"/><circle cx="9.4" cy="10.5" r="1.6" fill="#fff"/><circle cx="14.6" cy="10.5" r="1.6" fill="#fff"/>`),
  check: svg(`<path d="M4.5 12.5l5 5 10-11" ${ST} stroke-width="3.2"/>`),
  star: svg(`<path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8Z" fill="currentColor"/>`),
  mirror: svg(`<path d="M11 4 3 19h8Z" fill="currentColor"/><path d="M13 4l8 15h-8Z" ${ST} stroke-width="2"/>`),
  box: svg(`<rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="currentColor"/><path d="M9.8 9.6a2.3 2.3 0 1 1 3.3 2.1c-.8.4-1.1 1-1.1 1.9M12 16.6v.2" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`),
  cpu: svg(`<rect x="4.5" y="6" width="15" height="13" rx="4" fill="currentColor"/><path d="M12 6V3" ${ST}/><circle cx="12" cy="2.6" r="1.4" fill="currentColor"/><rect x="7.5" y="10" width="3" height="3" rx="1.2" fill="#fff"/><rect x="13.5" y="10" width="3" height="3" rx="1.2" fill="#fff"/><path d="M9.5 16h5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`),
  speed: svg(`<path d="M3.5 17a8.5 8.5 0 1 1 17 0" ${ST}/><path d="M12 17l5-6" ${ST} stroke-width="2.8"/><circle cx="12" cy="17" r="1.8" fill="currentColor"/>`),
  music: svg(`<path d="M9 17.5V5.5l10-2v11.5" ${ST}/><circle cx="6.5" cy="17.5" r="2.8" fill="currentColor"/><circle cx="16.5" cy="15" r="2.8" fill="currentColor"/>`),
  volume: svg(`<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" ${ST}/>`),
  keyboard: svg(`<rect x="2.5" y="6" width="19" height="12" rx="2.5" fill="currentColor"/><path d="M6 9.5h1M9 9.5h1M12 9.5h1M15 9.5h1M18 9.5h.1M6 12h1M9 12h1M12 12h1M15 12h1M8 14.8h8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`),
  touch: svg(`<path d="M9.5 11V4.8a1.8 1.8 0 0 1 3.6 0V10l4.3.9a2.5 2.5 0 0 1 2 2.9l-.9 5.4a2.4 2.4 0 0 1-2.4 2H11a2.4 2.4 0 0 1-2-1.1l-3.6-5.5a1.7 1.7 0 0 1 2.6-2.2Z" fill="currentColor"/>`),
  sprout: svg(`<path d="M12 21v-8" ${ST}/><path d="M12 13C12 8 8.5 5.2 3.5 5.5 3.5 10.5 7 13 12 13Z" fill="currentColor"/><path d="M12 11.5c0-4 3-6.8 8.5-6.5 0 4.5-3.5 6.8-8.5 6.5Z" fill="currentColor" opacity=".75"/>`),
  bolt: svg(`<path d="M13.5 2.5 5 13.5h6l-1.5 8 9-11.5h-6Z" fill="currentColor"/>`),
  info: svg(`<circle cx="12" cy="12" r="9.5" fill="currentColor"/><path d="M12 11v6M12 7.3v.2" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>`),
  eye: svg(`<path d="M12 5.5c-5.5 0-9 5-9.5 6.5.5 1.5 4 6.5 9.5 6.5s9-5 9.5-6.5c-.5-1.5-4-6.5-9.5-6.5Z" fill="currentColor"/><circle cx="12" cy="12" r="3.2" fill="#fff"/>`),
  pause: svg(`<rect x="6" y="4.5" width="4.3" height="15" rx="1.5" fill="currentColor"/><rect x="13.7" y="4.5" width="4.3" height="15" rx="1.5" fill="currentColor"/>`),
  crown: svg(`<path d="M3.5 18.5 2.5 7.5l5.2 4.3L12 4.5l4.3 7.3 5.2-4.3-1 11Z" fill="currentColor"/><rect x="3.5" y="19" width="17" height="2.2" rx="1" fill="currentColor"/>`),
  refresh: svg(`<path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3L19.5 9M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4.5 15" ${ST}/><path d="M19.5 4.5V9H15M4.5 19.5V15H9" ${ST}/>`),
  upload: svg(`<path d="M12 16V4.5M7 9l5-5 5 5" ${ST}/><path d="M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" ${ST}/>`),
  sparkle: svg(`<path d="M12 2.5c.8 4.6 2.6 6.9 7.5 9.5-4.9 2.6-6.7 4.9-7.5 9.5-.8-4.6-2.6-6.9-7.5-9.5 4.9-2.6 6.7-4.9 7.5-9.5Z" fill="currentColor"/>`),
  /** Install the app: arrow down into a phone. */
  install: svg(`<rect x="6" y="2.5" width="12" height="19" rx="2.6" ${ST}/><path d="M12 7v7.5M8.8 11.5 12 14.7l3.2-3.2" ${ST}/><path d="M10.5 18.5h3" ${ST}/>`),
  /** iOS Share glyph: a box with an arrow out of the top. */
  share: svg(`<path d="M12 14.5V3M8 6.8 12 3l4 3.8" ${ST}/><path d="M8.5 10H6.5a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 17.5 10h-2" ${ST}/>`),
  /** Offline ready: a cloud with a check. */
  cloud: svg(`<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6A3.8 3.8 0 0 1 17.5 18.5Z" fill="currentColor" opacity=".25"/><path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6A3.8 3.8 0 0 1 17.5 18.5Z" ${ST}/><path d="m9.3 13.6 2 2 3.6-3.8" ${ST}/>`),
  /** No connection: a cloud crossed out. */
  offline: svg(`<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6A3.8 3.8 0 0 1 17.5 18.5Z" ${ST}/><path d="M4 4l16 16" ${ST}/>`),
  trash: svg(`<path d="M4.5 6.5h15M9.5 6.5V4h5v2.5" ${ST}/><path d="M6.5 6.5l1 13.5h9l1-13.5" ${ST}/><path d="M10 10.5v6M14 10.5v6" ${ST}/>`),
  /** Home-screen "add" square. */
  addSquare: svg(`<rect x="3.5" y="3.5" width="17" height="17" rx="3.5" ${ST}/><path d="M12 8v8M8 12h8" ${ST}/>`),
} as const;

export type IconName = keyof typeof ICON;

/** Trophy with a tier colour baked in (for cup cards / results). */
export function trophySvg(tier: 'gold' | 'silver' | 'bronze' | null): string {
  const fill = tier === 'gold' ? '#ffcf33' : tier === 'silver' ? '#d7e1ea' : tier === 'bronze' ? '#e39a5b' : '#6f6a86';
  const shine = tier ? '#fff' : '#9892b0';
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M18 8h28v14a14 14 0 0 1-28 0Z" fill="${fill}" stroke="#1b1036" stroke-width="3.4" stroke-linejoin="round"/>
    <path d="M18 13H9.5a8.5 8.5 0 0 0 9.5 12M46 13h8.5A8.5 8.5 0 0 1 45 25" fill="none" stroke="#1b1036" stroke-width="3.4" stroke-linecap="round"/>
    <path d="M18 13H9.5a8.5 8.5 0 0 0 9.5 12M46 13h8.5A8.5 8.5 0 0 1 45 25" fill="none" stroke="${fill}" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M28 35h8v9h-8Z" fill="${fill}" stroke="#1b1036" stroke-width="3" stroke-linejoin="round"/>
    <path d="M20 44h24l2 10H18Z" fill="${fill}" stroke="#1b1036" stroke-width="3.4" stroke-linejoin="round"/>
    <path d="M24 12v9a8 8 0 0 0 3 6" fill="none" stroke="${shine}" stroke-width="3" stroke-linecap="round" opacity=".7"/>
    ${tier ? '<path d="M32 13.5l2.2 4.5 5 .7-3.6 3.5.9 4.9-4.5-2.4-4.5 2.4.9-4.9-3.6-3.5 5-.7Z" fill="#fff" opacity=".85"/>' : ''}
  </svg>`;
}
