/** Reusable menu widgets. All interactive rows are `[data-nav]` stops. */
import type { CharacterId, CharacterStats } from '../../sim/types.js';
import type { UiSound } from '../contracts.js';
import type { App } from './app.js';
import { ICON, type IconName } from './art/icons.js';
import { portraitSvg } from './art/portraits.js';
import { h, svg } from './dom.js';
import { setAdjust } from './nav.js';

export function icon(name: IconName, cls = 'ico'): HTMLSpanElement {
  return svg(ICON[name], cls);
}

export function portrait(charId: CharacterId, cls = 'portrait'): HTMLSpanElement {
  const el = svg(portraitSvg(charId), cls);
  el.dataset.char = charId;
  return el;
}

export interface ButtonOpts {
  label: string;
  sub?: string;
  icon?: IconName;
  variant?: 'primary' | 'secondary' | 'mode' | 'ghost' | 'danger' | 'go';
  cls?: string;
  sound?: UiSound | null;
  locked?: () => string | null;
  autofocus?: boolean;
  onClick: () => void;
}

export function button(app: App, o: ButtonOpts): HTMLButtonElement {
  const b = h('button', `btn btn--${o.variant ?? 'secondary'} ${o.cls ?? ''}`);
  b.type = 'button';
  b.dataset.nav = '';
  if (o.autofocus) b.dataset.autofocus = '';
  if (o.icon) b.append(icon(o.icon, 'btn__ico'));
  const text = h('span', 'btn__text', h('span', 'btn__label', o.label));
  if (o.sub) text.append(h('span', 'btn__sub', o.sub));
  b.append(text);
  const refreshLock = () => {
    const reason = o.locked?.() ?? null;
    b.classList.toggle('is-locked', !!reason);
    b.setAttribute('aria-disabled', reason ? 'true' : 'false');
    let lock = b.querySelector('.btn__lock');
    if (reason && !lock) { lock = icon('lock', 'ico btn__lock'); b.append(lock); }
    if (!reason && lock) lock.remove();
  };
  refreshLock();
  b.addEventListener('click', () => {
    const reason = o.locked?.() ?? null;
    if (reason) {
      app.sound('error');
      app.notify(reason, 'info');
      shake(b);
      return;
    }
    if (o.sound !== null) app.sound(o.sound ?? 'select');
    o.onClick();
  });
  return b;
}

export function shake(el: HTMLElement): void {
  el.classList.remove('is-shake');
  // Restart the CSS animation on the next frame (no forced reflow).
  requestAnimationFrame(() => {
    el.classList.add('is-shake');
    setTimeout(() => el.classList.remove('is-shake'), 420);
  });
}

function rowShell(label: string, iconName?: IconName, cls = ''): { row: HTMLDivElement; control: HTMLDivElement; valueText: HTMLSpanElement } {
  const row = h('div', `row ${cls}`);
  row.dataset.nav = '';
  row.tabIndex = 0;
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', label);
  const lab = h('div', 'row__label', iconName ? icon(iconName, 'row__ico') : null, h('span', null, label));
  const valueText = h('span', 'row__value');
  const control = h('div', 'row__control');
  row.append(lab, control);
  return { row, control, valueText };
}

export interface ChoiceOption<T> { value: T; label: string; sub?: string; locked?: string | null }

export interface Choice<T> { el: HTMLDivElement; get(): T; set(v: T, silent?: boolean): void; refresh(options?: ChoiceOption<T>[]): void }

/** Segmented picker (radio pills). Left/right cycle, click a pill to pick. */
export function choice<T>(app: App, o: {
  label: string; icon?: IconName; options: ChoiceOption<T>[]; value: T; cls?: string;
  onChange(v: T): void; wrap?: boolean;
}): Choice<T> {
  const { row, control } = rowShell(o.label, o.icon, `row--choice ${o.cls ?? ''}`);
  let options = o.options;
  let value = o.value;
  const pills = h('div', 'pills');
  control.append(pills);
  const render = () => {
    pills.replaceChildren();
    for (const opt of options) {
      const p = h('button', 'pill', h('span', 'pill__label', opt.label), opt.sub ? h('span', 'pill__sub', opt.sub) : null);
      p.type = 'button';
      p.tabIndex = -1;
      if (opt.locked) { p.classList.add('is-locked'); p.append(icon('lock', 'ico pill__lock')); }
      if (opt.value === value) p.classList.add('is-on');
      p.setAttribute('aria-pressed', opt.value === value ? 'true' : 'false');
      p.addEventListener('click', e => {
        e.stopPropagation();
        if (opt.locked) { app.sound('error'); app.notify(opt.locked, 'info'); shake(p); return; }
        if (opt.value !== value) { app.sound('toggle'); api.set(opt.value); }
        row.focus({ preventScroll: true });
      });
      pills.append(p);
    }
  };
  const step = (dir: -1 | 1): boolean => {
    const idx = options.findIndex(x => x.value === value);
    for (let k = 1; k <= options.length; k++) {
      let j = idx + dir * k;
      if (o.wrap === false) { if (j < 0 || j >= options.length) break; } else j = (j + options.length) % options.length;
      const opt = options[j]!;
      if (opt.locked) continue;
      if (opt.value === value) return false;
      app.sound('toggle');
      api.set(opt.value);
      return true;
    }
    app.sound('error');
    return true;
  };
  setAdjust(row, step);
  row.addEventListener('click', e => { if (e.target === row || !(e.target as Element).closest('.pill')) step(1); });
  const api: Choice<T> = {
    el: row,
    get: () => value,
    set(v: T, silent = false) {
      value = v;
      render();
      if (!silent) o.onChange(v);
    },
    refresh(next?: ChoiceOption<T>[]) {
      if (next) options = next;
      render();
    },
  };
  render();
  return api;
}

export interface Toggle { el: HTMLDivElement; get(): boolean; set(v: boolean, silent?: boolean): void }

export function toggle(app: App, o: {
  label: string; icon?: IconName; value: boolean; onChange(v: boolean): void;
  locked?: () => string | null; on?: string; off?: string;
}): Toggle {
  const { row, control } = rowShell(o.label, o.icon, 'row--toggle');
  let value = o.value;
  const sw = h('span', 'switch', h('span', 'switch__knob'));
  const text = h('span', 'switch__text');
  control.append(text, sw);
  const render = () => {
    const lockReason = o.locked?.() ?? null;
    row.classList.toggle('is-on', value);
    row.classList.toggle('is-locked', !!lockReason);
    row.setAttribute('aria-checked', value ? 'true' : 'false');
    text.textContent = lockReason ? '잠김' : value ? (o.on ?? '켜짐') : (o.off ?? '꺼짐');
    let lock = row.querySelector('.row__lock');
    if (lockReason && !lock) { lock = icon('lock', 'ico row__lock'); control.prepend(lock); }
    if (!lockReason && lock) lock.remove();
  };
  row.setAttribute('role', 'switch');
  const flip = (next: boolean) => {
    const lockReason = o.locked?.() ?? null;
    if (lockReason) { app.sound('error'); app.notify(lockReason, 'info'); shake(row); return; }
    if (next === value) return;
    value = next;
    app.sound('toggle');
    render();
    o.onChange(value);
  };
  row.addEventListener('click', () => flip(!value));
  setAdjust(row, dir => { flip(dir > 0); return true; });
  render();
  return { el: row, get: () => value, set(v, silent = false) { value = v; render(); if (!silent) o.onChange(v); } };
}

export interface Slider { el: HTMLDivElement; get(): number; set(v: number): void }

export function slider(app: App, o: {
  label: string; icon?: IconName; value: number; step?: number; onChange(v: number): void; format?: (v: number) => string;
}): Slider {
  const { row, control } = rowShell(o.label, o.icon, 'row--slider');
  const step = o.step ?? 0.05;
  let value = clamp01(o.value);
  const fill = h('span', 'slider__fill');
  const knob = h('span', 'slider__knob');
  const bar = h('span', 'slider', h('span', 'slider__track', fill), knob);
  const text = h('span', 'slider__text');
  control.append(bar, text);
  row.setAttribute('role', 'slider');
  row.setAttribute('aria-valuemin', '0');
  row.setAttribute('aria-valuemax', '100');
  const fmt = o.format ?? (v => `${Math.round(v * 100)}`);
  const render = () => {
    const pct = `${(value * 100).toFixed(1)}%`;
    fill.style.width = pct;
    knob.style.left = pct;
    text.textContent = fmt(value);
    row.setAttribute('aria-valuenow', String(Math.round(value * 100)));
  };
  const setValue = (v: number, sound: boolean) => {
    const nv = Math.round(clamp01(v) / step) * step;
    const next = clamp01(Number(nv.toFixed(4)));
    if (next === value) return;
    value = next;
    if (sound) app.sound('move');
    render();
    o.onChange(value);
  };
  setAdjust(row, dir => { setValue(value + dir * step, true); return true; });
  let dragging = false;
  const fromPointer = (e: PointerEvent) => {
    const r = bar.getBoundingClientRect();
    setValue((e.clientX - r.left) / Math.max(1, r.width), false);
  };
  bar.addEventListener('pointerdown', e => {
    dragging = true;
    try { bar.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    fromPointer(e);
    e.preventDefault();
  });
  bar.addEventListener('pointermove', e => { if (dragging) fromPointer(e); });
  const end = () => { if (dragging) { dragging = false; app.sound('toggle'); } };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  render();
  return { el: row, get: () => value, set(v) { value = clamp01(v); render(); } };
}

export interface Stepper { el: HTMLDivElement; get(): number; set(v: number, silent?: boolean): void; setMax(max: number): void }

export function stepper(app: App, o: {
  label: string; icon?: IconName; min: number; max: number; value: number; onChange(v: number): void; format?: (v: number) => string;
}): Stepper {
  const { row, control } = rowShell(o.label, o.icon, 'row--stepper');
  let value = o.value;
  let max = o.max;
  const minus = h('button', 'stepper__btn', '−');
  const plus = h('button', 'stepper__btn', '+');
  minus.type = plus.type = 'button';
  minus.tabIndex = plus.tabIndex = -1;
  const text = h('span', 'stepper__value');
  const dots = h('span', 'stepper__dots');
  control.append(minus, h('span', 'stepper__mid', text, dots), plus);
  const render = () => {
    text.textContent = o.format ? o.format(value) : String(value);
    minus.disabled = value <= o.min;
    plus.disabled = value >= max;
    dots.replaceChildren(...Array.from({ length: o.max - o.min }, (_, i) =>
      h('i', i < value - o.min ? 'is-on' : i >= max - o.min ? 'is-off' : '')));
  };
  const change = (d: number) => {
    const nv = Math.max(o.min, Math.min(max, value + d));
    if (nv === value) { app.sound('error'); return; }
    value = nv;
    app.sound('toggle');
    render();
    o.onChange(value);
  };
  minus.addEventListener('click', e => { e.stopPropagation(); change(-1); });
  plus.addEventListener('click', e => { e.stopPropagation(); change(1); });
  row.addEventListener('click', e => { if (!(e.target as Element).closest('.stepper__btn')) change(value >= max ? o.min - value : 1); });
  setAdjust(row, dir => { change(dir); return true; });
  render();
  return {
    el: row,
    get: () => value,
    set(v, silent = false) { value = Math.max(o.min, Math.min(max, v)); render(); if (!silent) o.onChange(value); },
    setMax(m) { max = m; if (value > max) { value = max; o.onChange(value); } render(); },
  };
}

export interface TextRow { el: HTMLDivElement; input: HTMLInputElement; get(): string; set(v: string): void; setError(msg: string | null): void }

/** Text entry row: the row is the nav stop; confirm focuses the input, Enter/Esc returns. */
export function textRow(app: App, o: {
  label: string; icon?: IconName; value: string; placeholder?: string; maxLength: number;
  onInput?(v: string): void; onCommit?(v: string): void;
}): TextRow {
  const { row, control } = rowShell(o.label, o.icon, 'row--text');
  const input = h('input', 'textfield');
  input.type = 'text';
  input.value = o.value;
  input.placeholder = o.placeholder ?? '';
  input.maxLength = o.maxLength * 2; // allow IME composition; validated separately
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('enterkeyhint', 'done');
  input.setAttribute('aria-label', o.label);
  const err = h('span', 'row__error');
  err.hidden = true;
  control.append(input);
  row.append(err);
  row.addEventListener('click', e => {
    if (e.target !== input) { input.focus(); input.select(); }
  });
  input.addEventListener('focus', () => row.classList.add('is-editing'));
  input.addEventListener('blur', () => {
    row.classList.remove('is-editing');
    o.onCommit?.(input.value);
  });
  input.addEventListener('input', () => o.onInput?.(input.value));
  input.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === 'Escape') && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      input.blur();
      row.focus({ preventScroll: true });
      app.sound(e.key === 'Enter' ? 'select' : 'back');
    }
  }, true);
  return {
    el: row, input,
    get: () => input.value,
    set(v) { input.value = v; },
    setError(msg) { err.hidden = !msg; err.textContent = msg ?? ''; row.classList.toggle('is-invalid', !!msg); },
  };
}

export interface Tabs { el: HTMLDivElement; set(id: string, silent?: boolean): void; get(): string; step(dir: -1 | 1): void }

export function tabs(app: App, o: { items: Array<{ id: string; label: string; sub?: string }>; active: string; onChange(id: string): void; cls?: string }): Tabs {
  const el = h('div', `tabs ${o.cls ?? ''}`);
  el.setAttribute('role', 'tablist');
  const prev = h('span', 'tabs__hint tabs__hint--prev', h('kbd', 'glyph glyph--tabprev'));
  const next = h('span', 'tabs__hint tabs__hint--next', h('kbd', 'glyph glyph--tabnext'));
  const list = h('div', 'tabs__list');
  el.append(prev, list, next);
  let active = o.active;
  const btns = new Map<string, HTMLButtonElement>();
  for (const it of o.items) {
    const b = h('button', 'tab', h('span', 'tab__label', it.label), it.sub ? h('span', 'tab__sub', it.sub) : null);
    b.type = 'button';
    b.tabIndex = -1;
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => { if (it.id !== active) { app.sound('toggle'); api.set(it.id); } });
    btns.set(it.id, b);
    list.append(b);
  }
  const render = () => {
    for (const [id, b] of btns) {
      b.classList.toggle('is-on', id === active);
      b.setAttribute('aria-selected', id === active ? 'true' : 'false');
      if (id === active) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };
  const api: Tabs = {
    el,
    get: () => active,
    set(id, silent = false) { active = id; render(); if (!silent) o.onChange(id); },
    step(dir) {
      const ids = o.items.map(i => i.id);
      const idx = ids.indexOf(active);
      const nid = ids[(idx + dir + ids.length) % ids.length]!;
      app.sound('toggle');
      api.set(nid);
    },
  };
  prev.addEventListener('click', () => api.step(-1));
  next.addEventListener('click', () => api.step(1));
  render();
  return api;
}

export const STAT_LABELS: Array<[keyof CharacterStats, string]> = [
  ['speed', '속도'], ['accel', '가속'], ['weight', '무게'], ['handling', '핸들링'],
];

export function statBars(stats: CharacterStats): { el: HTMLElement; set(s: CharacterStats): void } {
  const el = h('div', 'stats');
  const rows = STAT_LABELS.map(([k, label]) => {
    const segs = Array.from({ length: 5 }, () => h('i', 'stats__seg'));
    const row = h('div', `stats__row stats__row--${k}`, h('span', 'stats__label', label), h('span', 'stats__bar', ...segs));
    el.append(row);
    return { k, segs };
  });
  const set = (s: CharacterStats) => {
    for (const r of rows) r.segs.forEach((seg, i) => seg.classList.toggle('is-on', i < s[r.k]));
  };
  set(stats);
  return { el, set };
}

export const WEIGHT_LABEL: Record<'light' | 'medium' | 'heavy', string> = { light: '경량급', medium: '중간급', heavy: '중량급' };

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}
