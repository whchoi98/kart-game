/**
 * App shell: screen stack with animated transitions, menu input routing, modals,
 * notifications, button-hint bar, music/backdrop management and settings.
 * Entry point: `startApp(deps)`.
 */
import '@fontsource/black-han-sans/400.css';
import '@fontsource/jua/400.css';
import '../styles.css';
import './ui.css';
import './screens-menu.css';
import './screens-extra.css';
import './hud.css';
import './pwa.css';

import type { CharacterId, CpuLevel, CupId, SpeedClass } from '../../sim/types.js';
import type {
  AudioSystem, GameView, InputManager, MenuAction, MusicCue, Settings, UiSound,
} from '../contracts.js';
import type { PwaManager, PwaStatus } from '../pwa.js';
import { createStorage, type GameStorage, type PendingRun } from '../storage.js';
import { ICON } from './art/icons.js';
import { animate, h, prefersReducedMotion, svg, wait } from './dom.js';
import { restoreMemory } from './memory.js';
import { Nav } from './nav.js';
import { updateVisible } from './pwa-state.js';
import type { HintKey, HintSpec, InputKind, MenuSource, Screen } from './screen.js';
import { createBootScreen } from './screens/boot.js';
import { createMainMenu } from './screens/main-menu.js';
import { APP_VERSION, createTitleScreen } from './screens/title.js';
import { button } from './widgets.js';

export interface AppDeps {
  root: HTMLElement; view: GameView; audio: AudioSystem; input: InputManager;
  /** Progressive Web App manager (production entry only; the UI preview runs without one). */
  pwa?: PwaManager | null;
}

/** App-wide change notifications screens subscribe to (`app.on`). */
export type AppEvent = 'pwa' | 'net' | 'pending' | 'race';

/** sessionStorage key carrying state across an update reload (same tab only). */
const RELOAD_KEY = 'tpgp.v1.reload';

/** Last choices, remembered for the session so setup flows start where the player left off. */
export interface SetupMemory {
  cc: SpeedClass;
  ttCc: SpeedClass;
  cpuLevel: CpuLevel;
  mirror: boolean;
  charId: CharacterId;
  p2CharId: CharacterId;
  trackId: string;
  cup: CupId;
  items: boolean;
  cpuCount: number;
  duoCpuCount: number;
  ttGhost: 'none' | 'best' | 'world';
  lbTrack: string;
  lbCc: SpeedClass;
}

export interface ModalButton<T> { label: string; value: T; variant?: 'primary' | 'secondary' | 'danger' | 'go'; icon?: keyof typeof ICON }
export interface ModalSpec<T> {
  title: string;
  message?: string;
  body?: Node;
  buttons: ModalButton<T>[];
  /** Value resolved on back / Esc (omit to make the modal non-dismissable). */
  dismiss?: T;
  tone?: 'info' | 'danger' | 'good';
}

interface ModalHandle {
  el: HTMLElement;
  nav: Nav;
  dismiss(): void;
  dismissable: boolean;
}

let instance: App | null = null;

export function startApp(deps: AppDeps): App {
  const app = new App(deps);
  instance = app;
  void app.boot();
  return app;
}

/** The running app (debug / QA hooks only). */
export function currentApp(): App | null {
  return instance;
}

export class App {
  readonly root: HTMLElement;
  readonly view: GameView;
  readonly audio: AudioSystem;
  readonly input: InputManager;
  readonly storage: GameStorage;
  settings: Settings;
  readonly memory: SetupMemory = {
    cc: 100, ttCc: 150, cpuLevel: 'normal', mirror: false,
    charId: 'kiki', p2CharId: 'pip', trackId: 'sunny-meadow', cup: 'sprout',
    items: true, cpuCount: 7, duoCpuCount: 6, ttGhost: 'best', lbTrack: 'sunny-meadow', lbCc: 150,
  };

  private readonly screensLayer: HTMLElement;
  private readonly modalLayer: HTMLElement;
  private readonly notifyLayer: HTMLElement;
  private readonly hintBar: HTMLElement;
  private readonly stack: Screen[] = [];
  private readonly shown = new WeakSet<Screen>();
  private readonly modals: ModalHandle[] = [];
  private music: MusicCue | null = null;
  private backdropKey = '';
  private audioHolds = new Set<string>();
  private audioSuspended = false;
  private inputKind: InputKind = 'keyboard';
  private booted = false;
  mainMenu: Screen | null = null;
  readonly pwa: PwaManager | null;
  private pwaSnapshot: PwaStatus | null = null;
  private readonly bus = new EventTarget();
  /** Race screens with a race in progress (from startRace until the player leaves the results). */
  private readonly raceOwners = new Set<object>();
  /** Applied to the 3D view only, never saved (e.g. the QA hook's ?quality=). */
  private viewOverride: Partial<Settings> = {};
  /** Waiting runs removed at start-up because they were recorded by another app version. */
  droppedPending: PendingRun[] = [];
  /** Version this tab ran before an update reload (shows a "updated" toast once). */
  private updatedFrom: string | null = null;
  private resolveReady: () => void = () => undefined;
  /** Resolves once boot finished and the title screen is up. */
  readonly whenReady: Promise<void> = new Promise(resolve => { this.resolveReady = resolve; });

  /** True once boot finished and the title screen is up. */
  get ready(): boolean {
    return this.booted;
  }

  constructor(deps: AppDeps) {
    this.root = deps.root;
    this.view = deps.view;
    this.audio = deps.audio;
    this.input = deps.input;
    this.pwa = deps.pwa ?? null;
    this.storage = createStorage();
    this.settings = this.storage.loadSettings();
    this.droppedPending = this.storage.dropStalePendingRuns(APP_VERSION);
    this.restoreAfterReload();

    this.root.classList.add('tp');
    this.root.replaceChildren();
    this.screensLayer = h('div', 'tp-screens');
    this.modalLayer = h('div', 'tp-modals');
    this.notifyLayer = h('div', 'tp-notify');
    this.notifyLayer.setAttribute('aria-live', 'polite');
    this.hintBar = h('footer', 'hintbar');
    this.root.append(this.screensLayer, this.hintBar, this.modalLayer, this.notifyLayer);

    this.applySettings(this.settings);
    this.inputKind = this.input.touchDetected ? 'touch' : 'keyboard';
    document.documentElement.dataset.input = this.inputKind;

    this.input.onMenu((action: MenuAction, source: MenuSource, player?: number) => this.onMenu(action, source, player ?? 0));

    // Unlock audio on the first real user gesture anywhere (gamepad presses are not gestures).
    const unlock = () => {
      if (this.audio.unlocked) return;
      this.audio.unlock().then(() => {
        if (this.music) this.audio.playMusic(this.music);
      }).catch(() => undefined);
    };
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('pointerdown', unlock, true);
    // touch user activation is granted on pointerup/click (not pointerdown)
    window.addEventListener('pointerup', unlock, true);
    window.addEventListener('click', unlock, true);

    window.addEventListener('pointerdown', e => {
      this.setInputKind(e.pointerType === 'mouse' ? 'mouse' : 'touch');
    }, { capture: true, passive: true });
    window.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse' && (Math.abs(e.movementX) + Math.abs(e.movementY) > 3)) this.setInputKind('mouse');
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
      const hidden = document.visibilityState === 'hidden';
      this.holdAudio('hidden', hidden);
      const top = this.top as (Screen & { onHidden?: () => void }) | null;
      if (hidden) top?.onHidden?.();
    });

    window.addEventListener('resize', () => this.updateViewportClass());
    this.updateViewportClass();

    const net = () => this.onNetChange();
    window.addEventListener('online', net);
    window.addEventListener('offline', net);
    // Browsers do not always fire online/offline (e.g. DevTools / emulated or flaky links): poll too.
    window.setInterval(net, 2500);
    this.pwa?.onChange(s => this.onPwaChange(s));
  }

  async boot(): Promise<void> {
    const boot = createBootScreen(this);
    this.push(boot);
    const fontsReady = (async () => {
      try {
        await Promise.all([
          document.fonts.load('400 48px "Black Han Sans"', 'TURBO PALS 터보 팰즈 그랑프리'),
          document.fonts.load('400 24px "Jua"', '그랑프리 레이스 설정 가속'),
        ]);
        await document.fonts.ready;
      } catch { /* fonts are optional */ }
    })();
    await Promise.race([Promise.all([fontsReady, wait(650)]), wait(3000)]);
    try { this.view.showBackdrop('title'); } catch (err) { console.error('[ui] backdrop failed', err); }
    this.backdropKey = 'title';
    await wait(prefersReducedMotion() ? 0 : 250);
    this.booted = true;
    this.mainMenu = createMainMenu(this);
    this.resetTo(createTitleScreen(this));
    if (this.updatedFrom) {
      const from = this.updatedFrom;
      this.updatedFrom = null;
      setTimeout(() => this.notify(from === APP_VERSION ? '최신 버전으로 업데이트했어요!' : `새 버전 v${APP_VERSION}(으)로 업데이트했어요!`, 'good', 4200), 600);
    }
    this.resolveReady();
  }

  // ───────────────────────── app events / PWA / race lifecycle ─────────────────────────

  /** Subscribe to app-wide changes; returns unsubscribe. */
  on(type: AppEvent, fn: () => void): () => void {
    const listener = () => { try { fn(); } catch (err) { console.error('[ui] listener failed', err); } };
    this.bus.addEventListener(type, listener);
    return () => this.bus.removeEventListener(type, listener);
  }

  private emit(type: AppEvent): void {
    this.bus.dispatchEvent(new Event(type));
  }

  /** Latest service-worker status (null without a PwaManager). */
  get pwaStatus(): Readonly<PwaStatus> | null {
    return this.pwaSnapshot;
  }

  get online(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  }

  /** A race is in progress: from startRace until the player leaves the results screen. */
  get raceActive(): boolean {
    return this.raceOwners.size > 0 || this.view.inRace;
  }

  /** RaceScreen reports its lifecycle so an update can never reload the page mid-race. */
  setRaceActive(owner: object, on: boolean): void {
    const before = this.raceActive;
    if (on) this.raceOwners.add(owner); else this.raceOwners.delete(owner);
    this.pwa?.setInRace(this.raceActive);
    if (before !== this.raceActive) this.emit('race');
  }

  /** The update banner may show (an update is waiting and no race is in progress). */
  get updateAvailable(): boolean {
    const s = this.pwaSnapshot;
    return !!s && updateVisible(s, this.raceActive);
  }

  /** Waiting time-trial runs changed (queued, submitted, deleted). */
  pendingChanged(): void {
    this.emit('pending');
  }

  private onPwaChange(s: PwaStatus): void {
    const prev = this.pwaSnapshot;
    this.pwaSnapshot = s;
    this.emit('pwa');
    if (!prev || !this.booted) return;
    const menuTop = this.top === this.mainMenu || !!this.top?.el.classList.contains('title');
    if (s.updateReady && !prev.updateReady && !this.raceActive && !menuTop) {
      this.notify('새 버전이 준비됐어요! 메인 메뉴에서 업데이트할 수 있어요.', 'info', 4200);
    }
    // first complete cache of this build (an app start with an already warm cache has no progress)
    if (s.offlineReady && !prev.offlineReady && prev.progress > 0 && !this.raceActive) {
      this.notify('이제 오프라인에서도 플레이할 수 있어요!', 'good');
    }
  }

  private lastOnline = typeof navigator === 'undefined' || navigator.onLine !== false;

  private onNetChange(): void {
    const online = this.online;
    if (online === this.lastOnline) return;
    this.lastOnline = online;
    this.emit('net');
    if (!this.booted || this.raceActive) return;
    const waiting = this.storage.pendingRuns().length;
    if (online && waiting > 0) this.notify(`다시 온라인이에요! 등록을 기다리는 기록이 ${waiting}개 있어요.`, 'good', 4200);
    else if (!online) this.notify('오프라인이에요. 온라인 랭킹을 뺀 모든 모드는 그대로 즐길 수 있어요.', 'info', 4200);
  }

  /** Runs right before an update reloads the page: keep what the player would otherwise lose. */
  persistForReload(): void {
    try { this.storage.saveSettings(this.settings); } catch { /* storage full / unavailable */ }
    try {
      sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ memory: this.memory, from: APP_VERSION, at: Date.now() }));
    } catch { /* private mode: nothing to carry over */ }
  }

  private restoreAfterReload(): void {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(RELOAD_KEY);
      if (raw !== null) sessionStorage.removeItem(RELOAD_KEY);
    } catch { return; }
    if (!raw) return;
    try {
      const data = JSON.parse(raw) as { memory?: unknown; from?: unknown; at?: unknown };
      // only a reload that just happened (not a tab restored hours later)
      if (typeof data.at !== 'number' || Date.now() - data.at > 5 * 60_000) return;
      restoreMemory(this.memory, data.memory);
      if (typeof data.from === 'string') this.updatedFrom = data.from;
    } catch { /* corrupt: ignore */ }
  }

  /** Settings applied to the 3D view only and never saved (QA hook: ?debug&quality=). */
  setViewOverride(patch: Partial<Settings>): void {
    this.viewOverride = { ...this.viewOverride, ...patch };
    this.applySettings(this.settings);
  }

  // ───────────────────────── screens ─────────────────────────

  get top(): Screen | null {
    return this.stack[this.stack.length - 1] ?? null;
  }

  contains(s: Screen): boolean {
    return this.stack.includes(s);
  }

  push(s: Screen): void {
    const prev = this.top;
    this.stack.push(s);
    this.transition(prev, s, 'forward');
  }

  replace(s: Screen): void {
    const prev = this.stack.pop() ?? null;
    this.stack.push(s);
    this.transition(prev, s, 'forward');
    if (prev) this.disposeLater(prev);
  }

  back(): void {
    if (this.stack.length <= 1) return;
    const prev = this.stack.pop()!;
    this.transition(prev, this.top, 'back');
    this.disposeLater(prev);
  }

  /** Pop screens until `target` is on top (target must be in the stack). */
  popTo(target: Screen): void {
    if (!this.stack.includes(target)) { this.resetTo(target); return; }
    const prev = this.top;
    if (prev === target) return;
    const removed: Screen[] = [];
    while (this.top !== target) removed.push(this.stack.pop()!);
    this.transition(prev, target, 'back');
    for (const s of removed) this.disposeLater(s);
  }

  /** Back to the main menu (keeping the title screen beneath it when it is still there). */
  toMainMenu(): void {
    const menu = this.mainMenu ?? (this.mainMenu = createMainMenu(this));
    if (this.stack.includes(menu)) this.popTo(menu);
    else this.resetTo(menu);
  }

  /** Main menu → title screen (recreated if an earlier reset removed it). */
  toTitle(): void {
    const below = this.stack[this.stack.length - 2];
    if (this.top === this.mainMenu && below) this.back();
    else this.resetTo(createTitleScreen(this));
  }

  resetTo(s: Screen): void {
    const prev = this.top;
    const removed = this.stack.splice(0);
    this.stack.push(s);
    this.transition(prev, s, 'forward');
    // disposeLater keeps the (reusable) main menu alive; everything else is torn down.
    for (const r of removed) if (r !== s) this.disposeLater(r);
  }

  private disposeLater(s: Screen): void {
    if (s === this.mainMenu) return;
    setTimeout(() => {
      if (!this.stack.includes(s)) {
        try { s.dispose(); } catch (err) { console.error('[ui] dispose failed', err); }
        this.shown.delete(s);
      }
    }, 450);
  }

  private transition(from: Screen | null, to: Screen | null, dir: 'forward' | 'back'): void {
    if (from && from !== to) {
      try { from.hide(); } catch (err) { console.error('[ui] hide failed', err); }
      const el = from.el;
      el.classList.remove('is-entering', 'is-entering-back');
      el.classList.add(dir === 'forward' ? 'is-leaving' : 'is-leaving-back');
      el.setAttribute('inert', '');
      const done = () => {
        el.classList.remove('is-leaving', 'is-leaving-back');
        if (!this.top || this.top.el !== el) el.remove();
      };
      if (prefersReducedMotion()) done(); else setTimeout(done, 260);
    }
    if (!to) return;
    const el = to.el;
    el.classList.remove('is-leaving', 'is-leaving-back');
    el.removeAttribute('inert');
    if (el.parentElement !== this.screensLayer) this.screensLayer.append(el);
    else this.screensLayer.append(el); // move to the end (on top)
    el.classList.add(dir === 'forward' ? 'is-entering' : 'is-entering-back');
    setTimeout(() => el.classList.remove('is-entering', 'is-entering-back'), 420);
    this.applyScreenEnv(to);
    const first = !this.shown.has(to);
    this.shown.add(to);
    try { to.show(first); } catch (err) { console.error('[ui] show failed', err); }
  }

  private applyScreenEnv(s: Screen): void {
    if (s.music !== undefined) this.playMusic(s.music);
    if (s.backdrop) this.setBackdrop(s.backdrop.kind, s.backdrop.charId);
    this.input.setMode(s.inputMode ?? 'single');
    this.input.setTouchVisible(!!s.touchControls);
    this.root.classList.toggle('is-immersive', !!s.immersive);
    this.renderHints(s.hints ?? []);
  }

  /** Re-render the hint bar (e.g. after a screen changed its hints). */
  refreshHints(): void {
    const s = this.top;
    this.renderHints(s?.hints ?? []);
  }

  // ───────────────────────── input ─────────────────────────

  private onMenu(action: MenuAction, source: MenuSource, player: number): void {
    this.setInputKind(source);
    if (!this.booted) return;
    const modal = this.modals[this.modals.length - 1];
    if (modal) {
      this.modalMenu(modal, action);
      return;
    }
    const s = this.top;
    if (!s) return;
    if (s.onMenu?.(action, source, player)) return;
    switch (action) {
      case 'up': case 'down': case 'left': case 'right':
        s.nav?.handle(action);
        return;
      case 'confirm':
        s.nav?.activate();
        return;
      case 'back':
        if (s.onBack) s.onBack();
        else if (this.stack.length > 1) { this.sound('back'); this.back(); }
        return;
      case 'tabPrev':
        s.onTab?.(-1);
        return;
      case 'tabNext':
        s.onTab?.(1);
        return;
      case 'pause':
        return;
    }
  }

  private setInputKind(kind: InputKind): void {
    if (kind === this.inputKind) return;
    this.inputKind = kind;
    document.documentElement.dataset.input = kind;
    this.refreshHints();
  }

  get lastInput(): InputKind {
    return this.inputKind;
  }

  private updateViewportClass(): void {
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const cl = document.documentElement.classList;
    cl.toggle('vp-portrait', hgt > w);
    cl.toggle('vp-short', hgt < 500);
    cl.toggle('vp-narrow', w < 640);
  }

  // ───────────────────────── audio / backdrop ─────────────────────────

  sound(s: UiSound): void {
    try { this.audio.ui(s); } catch { /* ignore */ }
  }

  playMusic(cue: MusicCue | null): void {
    if (cue === this.music) return;
    this.music = cue;
    try {
      if (cue === null) this.audio.stopMusic(0.8);
      else this.audio.playMusic(cue);
    } catch (err) {
      console.error('[ui] music failed', err);
    }
  }

  /** Forget the cached cue (e.g. after a race played its own music). */
  resetMusic(): void {
    this.music = null;
  }

  setBackdrop(kind: 'title' | 'garage', charId?: CharacterId): void {
    if (this.view.inRace) return;
    const key = `${kind}:${charId ?? ''}`;
    if (key === this.backdropKey) return;
    this.backdropKey = key;
    try { this.view.showBackdrop(kind, charId); } catch (err) { console.error('[ui] backdrop failed', err); }
  }

  invalidateBackdrop(): void {
    this.backdropKey = '';
  }

  /** Suspend audio while any hold (hidden tab, pause menu) is active. */
  holdAudio(reason: string, on: boolean): void {
    if (on) this.audioHolds.add(reason); else this.audioHolds.delete(reason);
    const want = this.audioHolds.size > 0;
    if (want === this.audioSuspended) return;
    this.audioSuspended = want;
    try {
      if (want) this.audio.suspend(); else this.audio.resume();
    } catch { /* ignore */ }
  }

  // ───────────────────────── settings ─────────────────────────

  updateSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    this.storage.saveSettings(this.settings);
    this.applySettings(this.settings);
  }

  private applySettings(s: Settings): void {
    try { this.audio.setVolumes({ master: s.master, music: s.music, sfx: s.sfx }); } catch { /* ignore */ }
    try { this.view.applySettings({ ...s, ...this.viewOverride }); } catch (err) { console.error('[ui] view settings failed', err); }
    try { this.input.applySettings(s); } catch { /* ignore */ }
  }

  // ───────────────────────── notifications ─────────────────────────

  notify(text: string, tone: 'info' | 'good' | 'bad' | 'unlock' = 'info', ms = 3200): void {
    const iconName = tone === 'unlock' ? 'sparkle' : tone === 'good' ? 'check' : tone === 'bad' ? 'info' : 'info';
    const el = h('div', `toast toast--${tone}`, svg(ICON[iconName], 'ico toast__ico'), h('span', 'toast__text', text));
    el.setAttribute('role', 'status');
    this.notifyLayer.append(el);
    while (this.notifyLayer.children.length > 3) this.notifyLayer.firstElementChild?.remove();
    setTimeout(() => {
      el.classList.add('is-out');
      setTimeout(() => el.remove(), prefersReducedMotion() ? 0 : 320);
    }, ms);
  }

  // ───────────────────────── modals ─────────────────────────

  modal<T>(spec: ModalSpec<T>): Promise<T> {
    return new Promise<T>(resolve => {
      const card = h('div', `modal__card modal__card--${spec.tone ?? 'info'}`);
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-label', spec.title);
      card.append(h('h2', 'modal__title', spec.title));
      if (spec.message) card.append(h('p', 'modal__msg', spec.message));
      if (spec.body) card.append(spec.body);
      const actions = h('div', 'modal__actions');
      card.append(actions);
      const el = h('div', 'modal', h('div', 'modal__scrim'), card);
      const nav = new Nav(el, { onMove: () => this.sound('move') });
      let closed = false;
      const close = (v: T) => {
        if (closed) return;
        closed = true;
        const i = this.modals.indexOf(handle);
        if (i >= 0) this.modals.splice(i, 1);
        nav.dispose();
        el.classList.add('is-out');
        setTimeout(() => el.remove(), prefersReducedMotion() ? 0 : 200);
        const below = this.modals[this.modals.length - 1];
        if (below) below.nav.restore();
        else this.top?.nav?.restore();
        resolve(v);
      };
      spec.buttons.forEach((b, i) => {
        const btn = button(this, {
          label: b.label, variant: b.variant ?? (i === 0 ? 'primary' : 'secondary'), icon: b.icon,
          sound: b.value === spec.dismiss ? 'back' : 'select',
          autofocus: i === 0,
          onClick: () => close(b.value),
        });
        actions.append(btn);
      });
      el.querySelector('.modal__scrim')?.addEventListener('click', () => {
        if (spec.dismiss !== undefined) { this.sound('back'); close(spec.dismiss); }
      });
      const handle: ModalHandle = {
        el, nav,
        dismissable: spec.dismiss !== undefined,
        dismiss: () => { if (spec.dismiss !== undefined) close(spec.dismiss); },
      };
      this.modals.push(handle);
      this.modalLayer.append(el);
      nav.focusFirst();
      animate(card, [{ transform: 'scale(.86) rotate(-2deg)', opacity: 0 }, { transform: 'scale(1) rotate(0)', opacity: 1 }],
        { duration: 260, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    });
  }

  confirm(o: { title: string; message?: string; yes: string; no?: string; danger?: boolean }): Promise<boolean> {
    return this.modal<boolean>({
      title: o.title, message: o.message, tone: o.danger ? 'danger' : 'info', dismiss: false,
      buttons: [
        { label: o.yes, value: true, variant: o.danger ? 'danger' : 'primary' },
        { label: o.no ?? '취소', value: false, variant: 'secondary' },
      ],
    });
  }

  /** Loading overlay. Resolves `cancelled` if the player backs out (when cancellable). */
  busy(text: string, cancellable = false): { close(): void; cancelled: Promise<void>; setText(text: string): void } {
    const textEl = h('p', 'busy__text', text);
    const el = h('div', 'modal modal--busy', h('div', 'modal__scrim'),
      h('div', 'busy', h('div', 'busy__wheel', h('i'), h('i'), h('i')), textEl,
        cancellable ? h('p', 'busy__hint', '뒤로 가기로 취소') : null));
    let resolveCancel: () => void = () => undefined;
    const cancelled = new Promise<void>(r => { resolveCancel = r; });
    const nav = new Nav(el);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      const i = this.modals.indexOf(handle);
      if (i >= 0) this.modals.splice(i, 1);
      nav.dispose();
      el.remove();
      this.top?.nav?.restore();
    };
    const handle: ModalHandle = {
      el, nav, dismissable: cancellable,
      dismiss: () => { if (cancellable) { close(); resolveCancel(); } },
    };
    this.modals.push(handle);
    this.modalLayer.append(el);
    return { close, cancelled, setText: (t: string) => { textEl.textContent = t; } };
  }

  private modalMenu(m: ModalHandle, action: MenuAction): void {
    switch (action) {
      case 'up': case 'down': case 'left': case 'right':
        m.nav.handle(action);
        return;
      case 'confirm':
        m.nav.activate();
        return;
      case 'back': case 'pause':
        if (m.dismissable) { this.sound('back'); m.dismiss(); }
        return;
      default:
        return;
    }
  }

  get modalOpen(): boolean {
    return this.modals.length > 0;
  }

  // ───────────────────────── hint bar ─────────────────────────

  private renderHints(hints: HintSpec[]): void {
    const kind = this.inputKind;
    this.hintBar.replaceChildren();
    this.hintBar.hidden = hints.length === 0 || kind === 'touch' || kind === 'mouse';
    for (const hint of hints) this.hintBar.append(h('span', 'hint', glyph(kind, hint.key), h('span', 'hint__label', hint.label)));
  }
}

/** Button glyph for the current input device. */
export function glyph(kind: InputKind, key: HintKey): HTMLElement {
  const pad = kind === 'gamepad';
  const map: Record<HintKey, [string, string]> = {
    confirm: ['Enter', 'A'],
    back: ['Esc', 'B'],
    tabs: ['Q / E', 'LB / RB'],
    adjust: ['← →', '◀ ▶'],
    move: ['↑ ↓ ← →', '✚'],
    pause: ['Esc', 'START'],
  };
  const [k, p] = map[key];
  const el = h('kbd', `glyph ${pad ? `glyph--pad glyph--pad-${key}` : 'glyph--key'}`, pad ? p : k);
  return el;
}
