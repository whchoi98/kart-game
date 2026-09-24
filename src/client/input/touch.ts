/**
 * On-screen touch controls: a floating thumb-stick on the left half and a cluster of
 * action buttons on the right. Multi-touch safe (Pointer Events, one pointer per control,
 * fingers may slide between buttons). Styled by ./touch.css.
 */
import './touch.css';
import { touchSteer } from './steering.js';

export type TouchButton = 'throttle' | 'brake' | 'drift' | 'item' | 'back';

export interface TouchState {
  steer: number;
  throttle: boolean;
  brake: boolean;
  drift: boolean;
  item: boolean;
  back: boolean;
}

const BUTTONS: Array<{ id: TouchButton; label: string; cls: string }> = [
  { id: 'throttle', label: '가속', cls: 'tc-btn--accel' },
  { id: 'brake', label: '브레이크', cls: 'tc-btn--brake' },
  { id: 'drift', label: '드리프트', cls: 'tc-btn--drift' },
  { id: 'item', label: '아이템', cls: 'tc-btn--item' },
  { id: 'back', label: '뒤보기', cls: 'tc-btn--back' },
];

const ICONS: Record<TouchButton, string> = {
  throttle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18 12 5l7 13-7-3.5Z" fill="currentColor"/></svg>',
  brake: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor"/></svg>',
  drift: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16c3-7 9-9 15-8m0 0-3.5-3M19 8l-3.5 3" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  item: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M10 9.5a2.2 2.2 0 1 1 3.2 2c-.8.5-1.2 1-1.2 2M12 16.4v.2" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6c-5 0-8.5 4.2-9 6 .5 1.8 4 6 9 6s8.5-4.2 9-6c-.5-1.8-4-6-9-6Z" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="12" cy="12" r="2.8" fill="currentColor"/></svg>',
};

export class TouchControls {
  readonly root: HTMLDivElement;
  private readonly zone: HTMLDivElement;
  private readonly stick: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly cluster: HTMLDivElement;
  private readonly btnEls = new Map<TouchButton, HTMLElement>();
  private readonly pointerButton = new Map<number, TouchButton>();
  private steerPointer: number | null = null;
  private originX = 0;
  private originY = 0;
  private steerValue = 0;
  private shown = false;

  constructor(private readonly onPause: () => void) {
    const root = document.createElement('div');
    root.className = 'tc';
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');

    const zone = document.createElement('div');
    zone.className = 'tc-steer';
    const stick = document.createElement('div');
    stick.className = 'tc-stick';
    const rail = document.createElement('div');
    rail.className = 'tc-stick__rail';
    rail.innerHTML = '<span class="tc-stick__arrow tc-stick__arrow--l"></span><span class="tc-stick__arrow tc-stick__arrow--r"></span>';
    const knob = document.createElement('div');
    knob.className = 'tc-stick__knob';
    stick.append(rail, knob);
    const hint = document.createElement('div');
    hint.className = 'tc-steer__hint';
    hint.textContent = '좌우로 드래그해 조향';
    zone.append(stick, hint);

    const cluster = document.createElement('div');
    cluster.className = 'tc-cluster';
    for (const b of BUTTONS) {
      const el = document.createElement('div');
      el.className = `tc-btn ${b.cls}`;
      el.dataset.btn = b.id;
      el.setAttribute('role', 'button');
      el.innerHTML = `${ICONS[b.id]}<span class="tc-btn__label">${b.label}</span>`;
      cluster.append(el);
      this.btnEls.set(b.id, el);
    }

    const pause = document.createElement('div');
    pause.className = 'tc-pause';
    pause.setAttribute('role', 'button');
    pause.setAttribute('aria-label', '일시 정지');
    pause.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="1.4" fill="currentColor"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.4" fill="currentColor"/></svg>';
    pause.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      this.onPause();
    });

    root.append(zone, cluster, pause);
    this.root = root;
    this.zone = zone;
    this.stick = stick;
    this.knob = knob;
    this.cluster = cluster;

    zone.addEventListener('pointerdown', this.onZoneDown);
    zone.addEventListener('pointermove', this.onZoneMove);
    zone.addEventListener('pointerup', this.onZoneUp);
    zone.addEventListener('pointercancel', this.onZoneUp);
    zone.addEventListener('lostpointercapture', this.onZoneUp);

    cluster.addEventListener('pointerdown', this.onBtnDown);
    cluster.addEventListener('pointermove', this.onBtnMove);
    cluster.addEventListener('pointerup', this.onBtnUp);
    cluster.addEventListener('pointercancel', this.onBtnUp);
    cluster.addEventListener('lostpointercapture', this.onBtnUp);

    // No scrolling, pinch-zoom, double-tap zoom, long-press menus or text selection.
    const block = (e: Event) => { if (e.cancelable) e.preventDefault(); };
    root.addEventListener('touchstart', block, { passive: false });
    root.addEventListener('touchmove', block, { passive: false });
    root.addEventListener('touchend', block, { passive: false });
    root.addEventListener('contextmenu', block);
    root.addEventListener('selectstart', block);
    root.addEventListener('dblclick', block);

    document.body.append(root);
  }

  get visible(): boolean {
    return this.shown;
  }

  setShown(shown: boolean): void {
    if (this.shown === shown) return;
    this.shown = shown;
    this.root.hidden = !shown;
    document.documentElement.classList.toggle('touch-controls-on', shown);
    if (!shown) this.releaseAll();
  }

  setAutoAccelerate(on: boolean): void {
    this.root.classList.toggle('tc--auto', on);
    const el = this.btnEls.get('throttle');
    const label = el?.querySelector('.tc-btn__label');
    if (label) label.textContent = on ? '자동 가속' : '가속';
  }

  /** Raw finger state. Auto-accelerate is applied by the InputManager (for every device). */
  state(): TouchState {
    const pressed = new Set(this.pointerButton.values());
    return {
      steer: this.steerValue,
      throttle: pressed.has('throttle'),
      brake: pressed.has('brake'),
      drift: pressed.has('drift'),
      item: pressed.has('item'),
      back: pressed.has('back'),
    };
  }

  dispose(): void {
    this.releaseAll();
    this.root.remove();
    document.documentElement.classList.remove('touch-controls-on');
  }

  private releaseAll(): void {
    this.pointerButton.clear();
    this.steerPointer = null;
    this.steerValue = 0;
    this.stick.classList.remove('is-active');
    this.stick.style.transform = '';
    this.knob.style.transform = '';
    for (const el of this.btnEls.values()) el.classList.remove('is-down');
  }

  // ── steering ──

  private radius(): number {
    return Math.max(36, Math.min(110, Math.min(window.innerWidth, window.innerHeight) * 0.13));
  }

  private readonly onZoneDown = (e: PointerEvent): void => {
    if (this.steerPointer !== null) return;
    e.preventDefault();
    this.steerPointer = e.pointerId;
    try { this.zone.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const r = this.zone.getBoundingClientRect();
    const rad = this.radius();
    this.originX = Math.max(r.left + rad * 1.2, Math.min(r.right - rad * 1.2, e.clientX));
    this.originY = Math.max(r.top + rad, Math.min(r.bottom - rad * 0.8, e.clientY));
    const restLeft = r.left + r.width * 0.5;
    const restTop = r.top + r.height * 0.62;
    this.stick.style.transform = `translate(${(this.originX - restLeft).toFixed(1)}px, ${(this.originY - restTop).toFixed(1)}px)`;
    this.stick.classList.add('is-active');
    this.updateSteer(e.clientX);
  };

  private readonly onZoneMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.steerPointer) return;
    e.preventDefault();
    this.updateSteer(e.clientX);
  };

  private readonly onZoneUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.steerPointer) return;
    this.steerPointer = null;
    this.steerValue = 0;
    this.stick.classList.remove('is-active');
    this.stick.style.transform = '';
    this.knob.style.transform = '';
  };

  private updateSteer(x: number): void {
    const rad = this.radius();
    let dx = x - this.originX;
    // Floating stick: dragging past the rim drags the origin along.
    if (Math.abs(dx) > rad) {
      this.originX += dx - Math.sign(dx) * rad;
      dx = Math.sign(dx) * rad;
      const r = this.zone.getBoundingClientRect();
      const restLeft = r.left + r.width * 0.5;
      const restTop = r.top + r.height * 0.62;
      this.stick.style.transform = `translate(${(this.originX - restLeft).toFixed(1)}px, ${(this.originY - restTop).toFixed(1)}px)`;
    }
    this.steerValue = touchSteer(dx, rad);
    this.knob.style.transform = `translateX(${dx.toFixed(1)}px)`;
  }

  // ── buttons ──

  private buttonAt(x: number, y: number): TouchButton | null {
    const hit = document.elementFromPoint(x, y);
    const el = hit instanceof Element ? hit.closest<HTMLElement>('[data-btn]') : null;
    if (!el || !this.cluster.contains(el)) return null;
    return (el.dataset.btn as TouchButton | undefined) ?? null;
  }

  private readonly onBtnDown = (e: PointerEvent): void => {
    e.preventDefault();
    try { this.cluster.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const b = this.buttonAt(e.clientX, e.clientY);
    if (b) this.pointerButton.set(e.pointerId, b);
    this.refreshButtons();
  };

  private readonly onBtnMove = (e: PointerEvent): void => {
    if (!this.pointerButton.has(e.pointerId) && e.buttons === 0) return;
    const b = this.buttonAt(e.clientX, e.clientY);
    const prev = this.pointerButton.get(e.pointerId) ?? null;
    if (b === prev) return;
    // Sliding off every button keeps the last one held (thumbs drift); sliding onto another switches.
    if (b) {
      this.pointerButton.set(e.pointerId, b);
      this.refreshButtons();
    }
  };

  private readonly onBtnUp = (e: PointerEvent): void => {
    if (this.pointerButton.delete(e.pointerId)) this.refreshButtons();
  };

  private refreshButtons(): void {
    const pressed = new Set(this.pointerButton.values());
    for (const [id, el] of this.btnEls) el.classList.toggle('is-down', pressed.has(id));
  }
}
