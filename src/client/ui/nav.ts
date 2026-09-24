/**
 * Spatial focus navigation for keyboard / gamepad menus. Any element with
 * `data-nav` inside the root is a stop; arrows move to the geometrically nearest stop
 * in that direction. Elements registered with `setAdjust` consume left/right (sliders,
 * segmented pickers). Mouse hover moves focus; focus is shown with `.is-focus`.
 */

export type Dir = 'up' | 'down' | 'left' | 'right';

const adjusters = new WeakMap<Element, (dir: -1 | 1) => boolean | void>();

/** Hover only steals focus after a real mouse movement (not when a new screen appears under a resting cursor). */
let lastMouseMove = -Infinity;
if (typeof window !== 'undefined') {
  window.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse' && (e.movementX !== 0 || e.movementY !== 0)) lastMouseMove = performance.now();
  }, { passive: true, capture: true });
}

/** Let an element consume left/right while focused (return false to fall through to movement). */
export function setAdjust(el: Element, fn: (dir: -1 | 1) => boolean | void): void {
  adjusters.set(el, fn);
  el.setAttribute('data-adjust', '');
}

export interface NavOptions {
  /** Wrap vertically when nothing lies further in that direction. */
  wrap?: boolean;
  onMove?: (el: HTMLElement) => void;
  onFocus?: (el: HTMLElement) => void;
}

export class Nav {
  private current: HTMLElement | null = null;
  private readonly cleanup: Array<() => void> = [];

  constructor(readonly root: HTMLElement, private readonly opts: NavOptions = {}) {
    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || performance.now() - lastMouseMove > 150) return;
      const el = (e.target as Element | null)?.closest<HTMLElement>('[data-nav]');
      if (el && this.root.contains(el) && el !== this.current && this.isUsable(el)) this.focus(el, { sound: true, scroll: false });
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = (e.target as Element | null)?.closest<HTMLElement>('[data-nav]');
      if (el && this.root.contains(el) && el !== this.current) this.focus(el, { sound: false, scroll: true, native: false });
    };
    root.addEventListener('pointerover', onOver);
    root.addEventListener('focusin', onFocusIn);
    this.cleanup.push(() => root.removeEventListener('pointerover', onOver), () => root.removeEventListener('focusin', onFocusIn));
  }

  get focused(): HTMLElement | null {
    return this.current && this.root.contains(this.current) ? this.current : null;
  }

  items(): HTMLElement[] {
    return Array.from(this.root.querySelectorAll<HTMLElement>('[data-nav]')).filter(el => this.isUsable(el));
  }

  private isUsable(el: HTMLElement): boolean {
    if (el.hidden || el.closest('[hidden]') || el.closest('[inert]')) return false;
    return el.getClientRects().length > 0;
  }

  focus(el: HTMLElement | null, o: { sound?: boolean; scroll?: boolean; native?: boolean } = {}): void {
    if (!el) return;
    const prev = this.current;
    if (prev && prev !== el) prev.classList.remove('is-focus');
    this.current = el;
    el.classList.add('is-focus');
    if (o.native !== false && document.activeElement !== el) {
      try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
    if (o.scroll !== false) scrollIntoViewIfNeeded(el);
    if (prev !== el) {
      if (o.sound) this.opts.onMove?.(el);
      this.opts.onFocus?.(el);
    }
  }

  /** Focus `[data-autofocus]`, else the first stop. */
  focusFirst(): void {
    const items = this.items();
    const auto = items.find(el => el.hasAttribute('data-autofocus'));
    this.focus(auto ?? items[0] ?? null, { sound: false });
  }

  /** Re-apply focus after the screen is shown again. */
  restore(): void {
    const f = this.focused;
    if (f && this.isUsable(f)) this.focus(f, { sound: false });
    else this.focusFirst();
  }

  /** Arrow handling. Returns true when something happened. */
  handle(dir: Dir): boolean {
    const cur = this.focused;
    if ((dir === 'left' || dir === 'right') && cur) {
      const adj = adjusters.get(cur);
      if (adj && adj(dir === 'left' ? -1 : 1) !== false) return true;
    }
    return this.move(dir);
  }

  move(dir: Dir): boolean {
    const items = this.items();
    if (items.length === 0) return false;
    const cur = this.focused;
    if (!cur || !items.includes(cur)) {
      this.focus(items[0]!, { sound: true });
      return true;
    }
    const next = pick(cur, items, dir) ?? (this.opts.wrap ? wrapPick(cur, items, dir) : null);
    if (!next) return false;
    this.focus(next, { sound: true });
    return true;
  }

  /** Confirm: activate the focused stop. */
  activate(): boolean {
    const cur = this.focused;
    if (!cur) return false;
    if (cur instanceof HTMLInputElement && (cur.type === 'text' || cur.type === 'search')) {
      cur.focus();
      cur.select();
      return true;
    }
    cur.click();
    return true;
  }

  dispose(): void {
    for (const c of this.cleanup) c();
    this.cleanup.length = 0;
  }
}

interface R { l: number; r: number; t: number; b: number; cx: number; cy: number }
function rect(el: Element): R {
  const b = el.getBoundingClientRect();
  return { l: b.left, r: b.right, t: b.top, b: b.bottom, cx: (b.left + b.right) / 2, cy: (b.top + b.bottom) / 2 };
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

function pick(from: HTMLElement, items: HTMLElement[], dir: Dir): HTMLElement | null {
  const f = rect(from);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === from) continue;
    const c = rect(el);
    let gap: number;
    let ortho: number;
    let ov: number;
    switch (dir) {
      case 'right':
        if (c.cx <= f.cx + 1 || c.r <= f.r - 1) continue;
        gap = Math.max(0, c.l - f.r); ov = overlap(f.t, f.b, c.t, c.b); ortho = Math.abs(c.cy - f.cy);
        break;
      case 'left':
        if (c.cx >= f.cx - 1 || c.l >= f.l + 1) continue;
        gap = Math.max(0, f.l - c.r); ov = overlap(f.t, f.b, c.t, c.b); ortho = Math.abs(c.cy - f.cy);
        break;
      case 'down':
        if (c.cy <= f.cy + 1 || c.b <= f.b - 1) continue;
        gap = Math.max(0, c.t - f.b); ov = overlap(f.l, f.r, c.l, c.r); ortho = Math.abs(c.cx - f.cx);
        break;
      case 'up':
        if (c.cy >= f.cy - 1 || c.t >= f.t + 1) continue;
        gap = Math.max(0, f.t - c.b); ov = overlap(f.l, f.r, c.l, c.r); ortho = Math.abs(c.cx - f.cx);
        break;
    }
    // Strongly prefer stops that overlap on the orthogonal axis (same row / column).
    const score = gap + (ov > 0 ? ortho * 0.3 : 400 + ortho * 2);
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function wrapPick(from: HTMLElement, items: HTMLElement[], dir: Dir): HTMLElement | null {
  if (dir !== 'up' && dir !== 'down') return null;
  const f = rect(from);
  let best: HTMLElement | null = null;
  let bestScore = -Infinity;
  for (const el of items) {
    if (el === from) continue;
    const c = rect(el);
    const ov = overlap(f.l, f.r, c.l, c.r);
    const far = dir === 'down' ? -c.cy : c.cy;
    const score = far + (ov > 0 ? 100000 : -Math.abs(c.cx - f.cx));
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function scrollIntoViewIfNeeded(el: HTMLElement): void {
  const scroller = findScroller(el);
  if (!scroller) return;
  const er = el.getBoundingClientRect();
  const sr = scroller.getBoundingClientRect();
  const margin = 12;
  let dy = 0;
  if (er.top < sr.top + margin) dy = er.top - sr.top - margin;
  else if (er.bottom > sr.bottom - margin) dy = er.bottom - sr.bottom + margin;
  let dx = 0;
  if (er.left < sr.left + margin) dx = er.left - sr.left - margin;
  else if (er.right > sr.right - margin) dx = er.right - sr.right + margin;
  if (dx || dy) scroller.scrollBy({ left: dx, top: dy, behavior: 'auto' });
}

function findScroller(el: HTMLElement): HTMLElement | null {
  let p = el.parentElement;
  while (p) {
    const s = getComputedStyle(p);
    if ((/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1)
      || (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1)) return p;
    p = p.parentElement;
  }
  return null;
}
