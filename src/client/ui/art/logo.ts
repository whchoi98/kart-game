/** "TURBO PALS / GRAND PRIX" wordmark built from styled text (crisp at any size). */
import { h } from '../dom.js';

export function logo(size: 'hero' | 'small' = 'hero'): HTMLElement {
  const el = h('div', `logo logo--${size}`);
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'TURBO PALS GRAND PRIX · 터보 팰즈 그랑프리');
  const word = (text: string, cls: string) => {
    const w = h('span', `logo__word ${cls}`);
    w.dataset.text = text;
    w.textContent = text;
    return w;
  };
  const top = h('div', 'logo__line', word('TURBO', 'logo__turbo'), h('span', 'logo__bolt'), word('PALS', 'logo__pals'));
  const gp = h('div', 'logo__gp', h('span', 'logo__flag'), h('span', 'logo__gp-text', 'GRAND PRIX'), h('span', 'logo__flag logo__flag--r'));
  const ko = h('div', 'logo__ko', '터보 팰즈 그랑프리');
  el.append(h('div', 'logo__speed'), top, gp, ko);
  return el;
}
