/**
 * Progressive Web App manager: service-worker registration, offline readiness,
 * install prompt, and safe updates (never while a race is running).
 * The UI subscribes with `onChange` and calls install()/applyUpdate()/retry().
 */
import { BUILD_META } from './sw-policy.js';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface PwaStatus {
  /** Service workers are available in this browser. */
  supported: boolean;
  /** Running as an installed app (standalone / fullscreen display mode). */
  installed: boolean;
  /** The browser offered an install prompt we can trigger. */
  installable: boolean;
  /** iOS Safari: installable only via Share → Add to Home Screen. */
  iosManualInstall: boolean;
  /** Every client file is cached: the game works offline. */
  offlineReady: boolean;
  /** 0..100 while caching. */
  progress: number;
  updating: boolean;
  /** A newer version is cached and can be applied (outside races). */
  updateReady: boolean;
  inRace: boolean;
  online: boolean;
  /** Korean, user-facing; empty when fine. */
  error: string;
}

function standalone(): boolean {
  try {
    return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch { return false; }
}

/** Background update checks while the app stays open (plus one on every launch). */
const UPDATE_CHECK_MS = 15 * 60 * 1000;

function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

export class PwaManager {
  private registration?: ServiceWorkerRegistration;
  private promptEvent?: InstallPrompt;
  private applyRequested = false;
  private started = false;
  private lastUpdateCheck = 0;
  private watchedRegistration?: ServiceWorkerRegistration;
  private knownController: ServiceWorker | null = 'serviceWorker' in navigator ? navigator.serviceWorker.controller : null;
  private readonly listeners = new Set<(s: Readonly<PwaStatus>) => void>();
  readonly status: PwaStatus;
  /** Called right before the page reloads into a new version. */
  beforeReload: () => void = () => {};
  /** Live race state supplied by the app (never trust a cached flag). */
  getInRace: () => boolean = () => this.status.inRace;

  constructor(private readonly version: string,
    private readonly build = document.querySelector<HTMLMetaElement>(`meta[name="${BUILD_META}"]`)?.content) {
    const installed = standalone();
    this.status = {
      supported: 'serviceWorker' in navigator,
      installed,
      installable: false,
      iosManualInstall: !installed && isIosSafari(),
      offlineReady: false, progress: 0, updating: false, updateReady: false,
      inRace: false, online: navigator.onLine, error: '',
    };
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      this.promptEvent = event as InstallPrompt;
      this.status.installable = true;
      this.emit();
    });
    window.addEventListener('appinstalled', () => {
      this.promptEvent = undefined;
      this.status.installed = true; this.status.installable = false; this.status.iosManualInstall = false;
      this.emit();
    });
    const online = () => { this.status.online = navigator.onLine; this.emit(); this.checkForUpdate(); };
    window.addEventListener('online', online);
    window.addEventListener('offline', online);
    if (!this.status.supported) return;
    // An installed app is resumed, not reloaded: look for a new version when it comes back to the
    // foreground and every so often while it stays open (never during a race).
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.checkForUpdate(); });
    window.setInterval(() => this.checkForUpdate(), UPDATE_CHECK_MS);
    navigator.serviceWorker.addEventListener('message', event => {
      const source = event.source as ServiceWorker | null;
      if (!this.registeredSource(source)) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'QUERY_RACE_STATUS') {
        const port = event.ports[0];
        if (!port) return;
        this.status.inRace = this.currentRace();
        try { port.postMessage({ type: 'RACE_STATUS', inRace: this.status.inRace }); } finally { port.close(); }
        return;
      }
      const control = data.type === 'UPDATE_BLOCKED' || data.type === 'CACHE_ERROR';
      if (!control && (data.version !== this.version
        || (this.build && /^[a-f0-9]{16,64}$/.test(this.build) && data.build !== this.build))) return;
      if (data.type === 'CACHE_PROGRESS') {
        this.status.updating = true;
        this.status.progress = Math.min(100, Math.round(Number(data.completed) / Math.max(1, Number(data.total)) * 100));
      }
      if (data.type === 'CACHE_READY') {
        this.status.offlineReady = true; this.status.updating = false; this.status.progress = 100; this.status.error = '';
      }
      if (data.type === 'CACHE_PENDING') this.status.offlineReady = false;
      if (data.type === 'CACHE_ERROR') {
        this.applyRequested = false; this.status.updating = false;
        this.status.error = '오프라인 파일을 준비하지 못했어요. 연결과 저장 공간을 확인하고 다시 시도해 주세요.';
      }
      if (data.type === 'UPDATE_BLOCKED') {
        this.applyRequested = false;
        this.status.error = '다른 창에서 레이스가 진행 중이에요. 레이스를 마친 뒤 다시 시도해 주세요.';
      }
      this.emit();
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      this.status.inRace = this.currentRace();
      this.sendStatus();
      if (this.applyRequested && !this.status.inRace) {
        this.applyRequested = false;
        this.beforeReload();
        location.reload();
      } else if (this.started) {
        this.status.updateReady = !!this.knownController;
        this.emit();
      }
      if (this.status.inRace) this.applyRequested = false;
      this.knownController = navigator.serviceWorker.controller;
    });
  }

  onChange(fn: (s: Readonly<PwaStatus>) => void): () => void {
    this.listeners.add(fn);
    fn({ ...this.status });
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = { ...this.status };
    for (const fn of this.listeners) { try { fn(snap); } catch { /* listener errors never break the manager */ } }
  }

  private registeredSource(source: ServiceWorker | null): boolean {
    if (!source?.scriptURL) return false;
    try { if (new URL(source.scriptURL).origin !== location.origin) return false; } catch { return false; }
    return [navigator.serviceWorker.controller, this.registration?.active,
      this.registration?.waiting, this.registration?.installing].includes(source);
  }

  private currentRace(): boolean {
    try { return this.getInRace() !== false; } catch { return true; }
  }

  private sendStatus(): void {
    for (const target of [navigator.serviceWorker?.controller, this.registration?.waiting, this.registration?.installing]) {
      target?.postMessage({ type: 'CLIENT_STATUS', inRace: this.status.inRace });
    }
  }

  /** The app reports race start/end so a waiting update never activates mid-race. */
  setInRace(inRace: boolean): void {
    if (this.status.inRace === inRace) return;
    this.status.inRace = inRace;
    if (this.status.supported) this.sendStatus();
    this.emit();
  }

  /** Register the worker (production builds only). Safe to call again (retry). */
  async start(): Promise<void> {
    if (!this.status.supported || !import.meta.env.PROD) { this.emit(); return; }
    this.started = true;
    try {
      const existing = await navigator.serviceWorker.getRegistration();
      const usable = existing && (existing.active || existing.waiting || existing.installing) ? existing : undefined;
      this.registration = usable ?? await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      const registration = this.registration;
      const checkWaiting = () => {
        if (this.registration !== registration) return;
        this.status.updateReady = !!registration.waiting && !!navigator.serviceWorker.controller;
        if (registration.waiting) this.status.updating = false;
        this.sendStatus();
        registration.waiting?.postMessage({ type: 'GET_CACHE_STATUS' });
        this.emit();
      };
      if (this.watchedRegistration !== registration) {
        this.watchedRegistration = registration;
        let observed: ServiceWorker | null = null;
        const watchInstalling = () => {
          if (this.registration !== registration) return;
          const installing = registration.installing;
          if (!installing || installing === observed) return;
          observed = installing;
          this.status.updating = true; this.status.error = ''; this.emit();
          installing.postMessage({ type: 'CLIENT_STATUS', inRace: this.currentRace() });
          let installed = false;
          installing.addEventListener('statechange', () => {
            if (this.registration !== registration) return;
            if (installing.state === 'installed') { installed = true; checkWaiting(); }
            if (installing.state === 'redundant') {
              this.status.updating = false;
              // A waiting version replaced by an even newer one is not a failure; only a failed install is.
              if (!installed) this.status.error = '오프라인 파일을 준비하지 못했어요. 다시 시도할 수 있어요.';
              this.emit();
            }
          });
        };
        registration.addEventListener('updatefound', watchInstalling);
        watchInstalling();
      }
      checkWaiting();
      navigator.serviceWorker.controller?.postMessage({ type: 'GET_CACHE_STATUS' });
      registration.active?.postMessage({ type: 'GET_CACHE_STATUS' });
      if (usable && navigator.onLine) {
        this.lastUpdateCheck = Date.now();
        void usable.update().catch(() => {
          this.status.error = '업데이트를 확인하지 못했어요. 연결 후 다시 시도해 주세요.';
          this.emit();
        });
      }
    } catch {
      this.status.updating = false;
      this.status.error = '이 환경에서는 오프라인 저장을 쓸 수 없어요. 온라인으로는 그대로 플레이할 수 있어요.';
      this.emit();
    }
  }

  /** Show the browser's install prompt. Returns false when only manual install (iOS) is possible. */
  async install(): Promise<boolean> {
    if (this.status.installed) return true;
    const event = this.promptEvent;
    if (!event) return false;
    try {
      await event.prompt();
      const choice = await event.userChoice;
      if (choice.outcome === 'accepted') this.status.installed = true;
      return true;
    } finally {
      this.promptEvent = undefined;
      this.status.installable = false;
      this.emit();
    }
  }

  /** Quiet background check for a newer worker (installs it; the banner offers it between races). */
  private checkForUpdate(): void {
    const registration = this.registration;
    if (!this.started || !registration || !navigator.onLine || this.currentRace()) return;
    if (Date.now() - this.lastUpdateCheck < UPDATE_CHECK_MS / 3) return;
    this.lastUpdateCheck = Date.now();
    void registration.update().catch(() => { /* offline or server busy: the next check retries */ });
  }

  async retry(): Promise<void> {
    this.status.error = '';
    this.emit();
    await this.start();
  }

  /** Apply a waiting update (reloads). Refused while racing. */
  applyUpdate(): boolean {
    this.status.inRace = this.currentRace();
    if (this.status.inRace) return false;
    // a refusal from an earlier attempt (UPDATE_BLOCKED …) must not read as this attempt's answer
    this.status.error = '';
    this.beforeReload();
    if (!this.registration?.waiting) { location.reload(); return true; }
    this.applyRequested = true;
    this.sendStatus();
    this.registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
    return true;
  }
}
