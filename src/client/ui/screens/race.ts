import { CUPS, getTrackMeta } from '../../../sim/tracks/catalog.js';
import type { RaceConfig, RaceMode } from '../../../sim/types.js';
import type { GhostData, MenuAction, RaceSummary } from '../../contracts.js';
import type { TurboInputManager } from '../../input/index.js';
import type { App } from '../app.js';
import { THEME_COLORS } from '../art/track-draw.js';
import { h, wait } from '../dom.js';
import { Hud } from '../hud.js';
import { Nav } from '../nav.js';
import type { MenuSource, Screen } from '../screen.js';
import { button } from '../widgets.js';
import { createSettingsScreen } from './settings.js';
import { cupEmblem } from './course-select.js';

export interface RaceRun {
  config: RaceConfig;
  ghost?: GhostData | null;
  /** Small line above the track name, e.g. '새싹 컵 · 레이스 2/4'. */
  subtitle: string;
  onFinish(summary: RaceSummary): void;
}

export interface RaceScreenOptions {
  mode: RaceMode;
  duo: boolean;
  quitTitle: string;
  quitMessage: string;
  onQuit(): void;
}

const nextFrame = (): Promise<void> => new Promise(resolve => requestAnimationFrame(() => resolve()));

const TIPS = [
  '드리프트를 길게 유지하면 파랑 → 주황 → 보라 불꽃 순서로 부스트가 강해져요.',
  '출발 카운트의 "1"이 사라질 즈음 가속하면 로켓 스타트!',
  '바나나를 뒤에 들고 있으면 뒤에서 날아오는 구슬을 막을 수 있어요.',
  '코인을 모을수록 최고 속도가 조금씩 올라가요. 최대 10개까지!',
  '점프대 끝에서 드리프트 버튼을 누르면 트릭 부스트를 받아요.',
  '뒤보기 버튼을 누른 채 아이템을 쓰면 뒤로 던질 수 있어요.',
  '니트로를 쓰면 오프로드에서도 속도가 줄지 않아요.',
  '벽에 부딪히면 속도를 크게 잃어요. 코너 안쪽을 노려 보세요.',
  '1위에 가까울수록 방어용 아이템이, 뒤처질수록 강력한 아이템이 나와요.',
];

export class RaceScreen implements Screen {
  readonly el: HTMLElement;
  readonly nav: Nav;
  readonly immersive = true;
  readonly inputMode: 'single' | 'duo';
  readonly hints = [];
  private readonly hudLayer: HTMLElement;
  private readonly loadingEl: HTMLElement;
  private readonly pauseEl: HTMLElement;
  private readonly pauseSub: HTMLElement;
  private huds: Hud[] = [];
  private current: RaceRun | null = null;
  private raf = 0;
  private active = false;     // screen on top
  private running = false;    // race started (HUD live)
  private loading = false;
  private paused = false;
  private finished = false;
  private disposed = false;
  private autoHold = false;
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly app: App, private readonly o: RaceScreenOptions) {
    this.inputMode = o.duo ? 'duo' : 'single';
    this.el = h('section', `screen race ${o.duo ? 'race--duo' : 'race--single'}`);
    this.hudLayer = h('div', 'race__huds');
    this.loadingEl = h('div', 'race-loading');
    this.loadingEl.hidden = true;
    this.pauseSub = h('p', 'pause__sub');
    const btns = h('div', 'pause__btns',
      button(app, { label: '계속하기', icon: 'play', variant: 'primary', autofocus: true, onClick: () => this.resume() }),
      button(app, { label: '다시 시작', icon: 'restart', onClick: () => this.restart() }),
      button(app, { label: '설정', icon: 'gear', onClick: () => app.push(createSettingsScreen(app, { inRace: true })) }),
      button(app, { label: '메뉴로 나가기', icon: 'home', variant: 'danger', onClick: () => void this.quit() }),
    );
    this.pauseEl = h('div', 'pause', h('div', 'pause__card', h('h2', 'pause__title', '일시 정지'), this.pauseSub, btns));
    this.pauseEl.hidden = true;
    this.el.append(this.hudLayer, this.loadingEl, this.pauseEl);
    this.nav = new Nav(this.pauseEl, { onMove: () => app.sound('move'), wrap: true });

    const onKey = (e: KeyboardEvent) => {
      if (!this.active || this.paused || !this.running) return;
      if (this.app.view.hud(0)?.phase === 'intro' && !e.repeat) this.app.view.skipIntro();
    };
    // Window-level: on touch screens the on-screen stick / buttons (input/touch.ts, outside this
    // screen) cover most of the display, and "화면을 터치해 건너뛰기" must work wherever the thumb lands.
    const onPointer = (e: PointerEvent) => {
      if (!this.active || this.paused || !this.running) return;
      // The HUD / touch pause buttons pause the intro; they must not also skip it.
      if ((e.target as Element | null)?.closest?.('.hud-pause, .tc-pause')) return;
      if (this.app.view.hud(0)?.phase === 'intro') this.app.view.skipIntro();
    };
    // Right Ctrl is bound (single: item, duo P2: look back) and W is throttle, so a player can
    // hit Ctrl+W — the browser's close-tab shortcut, which a page cannot cancel. While a race is
    // live, ask the browser to confirm leaving instead of silently closing the game.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (this.disposed || !this.running || this.finished) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pointerdown', onPointer);
    this.cleanup.push(
      () => window.removeEventListener('keydown', onKey),
      () => window.removeEventListener('beforeunload', onBeforeUnload),
      () => window.removeEventListener('pointerdown', onPointer),
    );
  }

  get touchControls(): boolean {
    return this.running && !this.paused && !this.finished;
  }

  // ───────────────────────── lifecycle ─────────────────────────

  async run(r: RaceRun): Promise<boolean> {
    // A race is in progress from here until the player leaves the results (leaveRace / dispose):
    // the service worker must not swap versions (reload) in between.
    if (!this.disposed) this.app.setRaceActive(this, true);
    this.stopLoop();
    // The new session opens with the intro; hold auto-accelerate until the HUD reports GO.
    this.setAutoHold(true);
    this.current = r;
    this.running = false;
    this.finished = false;
    this.setPaused(false);
    this.clearHuds();
    this.showLoading(r);
    this.app.invalidateBackdrop();
    const started = performance.now();
    try {
      await this.app.view.startRace({
        config: r.config,
        ghost: r.ghost ?? null,
        onFinish: summary => this.handleFinish(summary),
      });
    } catch (err) {
      console.error('[ui] startRace failed', err);
      this.hideLoading();
      await this.app.modal({
        title: '레이스를 시작하지 못했어요',
        message: '코스를 불러오는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
        tone: 'danger',
        buttons: [{ label: '메뉴로', value: true, icon: 'home' }],
      });
      try { this.app.view.endRace(); } catch { /* ignore */ }
      this.app.setRaceActive(this, false);
      this.o.onQuit();
      return false;
    }
    if (this.disposed) return false;
    // Keep the card up briefly so it never flashes.
    const shownFor = performance.now() - started;
    if (shownFor < 450) await wait(450 - shownFor);
    // …and until the view has drawn the race at least once: the first race frame compiles every
    // shader and can take far longer than the build on slow GPUs. Revealing earlier shows the HUD
    // over the stale menu backdrop for that long.
    await nextFrame();
    await nextFrame();
    if (this.disposed || this.current !== r) return false;
    this.hideLoading();
    // The race session starts the track music itself; forget the cached menu cue so
    // results / menus re-apply theirs afterwards.
    this.app.resetMusic();
    this.buildHuds(r);
    this.running = true;
    this.pauseSub.textContent = `${getTrackMeta(r.config.trackId).name} · ${r.subtitle}`;
    if (this.active) {
      this.app.input.setTouchVisible(this.touchControls);
      this.startLoop();
    }
    return true;
  }

  restart(): void {
    if (!this.current) return;
    this.setAutoHold(true);
    this.finished = false;
    for (const hud of this.huds) hud.reset();
    this.app.resetMusic();
    try { this.app.view.restartRace(); } catch (err) { console.error('[ui] restart failed', err); }
    this.setPaused(false);
    if (this.active) {
      this.app.input.setTouchVisible(this.touchControls);
      this.startLoop();
    }
  }

  show(_first: boolean): void {
    this.active = true;
    // Returning from the settings screen: refresh HUD toggles.
    for (const hud of this.huds) hud.setOptions({ showSpeed: this.app.settings.showSpeed, showFps: this.app.settings.showFps });
    if (this.paused) this.nav.restore();
    if (this.running) this.startLoop();
    this.app.input.setTouchVisible(this.touchControls);
  }

  hide(): void {
    this.active = false;
    this.stopLoop();
    this.app.input.setTouchVisible(false);
  }

  dispose(): void {
    // a screen torn down without leaveRace() (e.g. a direct jump to the menu) must not leave the race running
    if (this.running) this.leaveRace();
    this.disposed = true;
    this.stopLoop();
    this.setAutoHold(false);
    this.clearHuds();
    this.nav.dispose();
    this.app.holdAudio('pause', false);
    for (const c of this.cleanup.splice(0)) c();
    this.app.setRaceActive(this, false);
  }

  /** Called by the app when the tab is hidden. */
  onHidden(): void {
    if (this.active && this.running && !this.paused && !this.finished && this.app.top === this) this.pause();
  }

  // ───────────────────────── input ─────────────────────────

  onMenu(action: MenuAction, source: MenuSource): boolean {
    if (this.loading || !this.current) return true;
    if (this.paused) {
      if (action === 'pause') { this.resume(); return true; }
      return false; // pause menu navigation (back → onBack → resume)
    }
    if (!this.running) return true;
    // The on-screen touch pause button is an explicit pause (like the HUD button for the mouse):
    // it pauses the intro too instead of skipping it. Keys / START keep "any key skips the intro".
    if (action === 'pause' && source === 'touch' && !this.finished) {
      this.pause();
      return true;
    }
    const phase = this.app.view.hud(0)?.phase;
    if (phase === 'intro') {
      this.app.view.skipIntro();
      return true;
    }
    if (this.finished) return true;
    if (action === 'pause' || (action === 'back' && source === 'keyboard')) {
      this.pause();
      return true;
    }
    return true;
  }

  onBack(): void {
    if (this.paused) this.resume();
  }

  // ───────────────────────── pause ─────────────────────────

  pause(): void {
    if (this.paused || !this.running || this.finished) return;
    try { this.app.view.pause(); } catch { /* ignore */ }
    this.setPaused(true);
    this.app.sound('back');
  }

  resume(): void {
    if (!this.paused) return;
    this.setPaused(false);
    try { this.app.view.resume(); } catch { /* ignore */ }
    this.app.sound('select');
  }

  private setPaused(p: boolean): void {
    this.paused = p;
    this.pauseEl.hidden = !p;
    this.el.classList.toggle('is-paused', p);
    this.app.holdAudio('pause', p);
    if (p) this.nav.focusFirst();
    if (this.active) this.app.input.setTouchVisible(this.touchControls);
  }

  private async quit(): Promise<void> {
    const ok = await this.app.confirm({ title: this.o.quitTitle, message: this.o.quitMessage, yes: '나가기', no: '계속 달리기', danger: true });
    if (!ok) return;
    this.leaveRace();
    this.o.onQuit();
  }

  /** Stop the race and return the view to backdrop mode. */
  leaveRace(): void {
    this.stopLoop();
    this.setAutoHold(false);
    this.running = false;
    this.setPaused(false);
    try { this.app.view.endRace(); } catch { /* ignore */ }
    try { this.app.audio.stopRace(); } catch { /* ignore */ }
    this.app.invalidateBackdrop();
    this.app.resetMusic();
    this.clearHuds();
    this.app.setRaceActive(this, false);
  }

  private handleFinish(summary: RaceSummary): void {
    if (!this.current || this.disposed) return;
    this.finished = true;
    this.app.input.setTouchVisible(false);
    this.current.onFinish(summary);
  }

  // ───────────────────────── HUD ─────────────────────────

  private buildHuds(r: RaceRun): void {
    this.clearHuds();
    const humans = r.config.racers.filter(x => x.human >= 0).length;
    const duo = this.o.duo && humans > 1;
    const meta = getTrackMeta(r.config.trackId);
    const cup = CUPS.find(c => c.id === meta.cup);
    for (let p = 0; p < (duo ? 2 : 1); p++) {
      const hud = new Hud({
        player: p, duo, mode: this.o.mode,
        showSpeed: this.app.settings.showSpeed, showFps: this.app.settings.showFps,
        // Time trials run with items off but still hand out the triple nitro.
        items: r.config.items || r.config.mode === 'tt',
        onPause: p === 0 ? () => this.pause() : undefined,
      });
      hud.setTrack(this.app.view.track);
      hud.setIntro(meta.name, `${cup ? cup.name : ''} · ${r.subtitle}`, this.app.input.touchDetected ? '화면을 터치해 건너뛰기' : '아무 키나 눌러 건너뛰기');
      this.huds.push(hud);
      this.hudLayer.append(hud.el);
    }
  }

  private clearHuds(): void {
    for (const hud of this.huds) hud.dispose();
    this.huds = [];
  }

  private startLoop(): void {
    if (this.raf || !this.running) return;
    let track = this.app.view.track;
    const refresh = () => {
      const view = this.app.view;
      if (view.track !== track && view.track) {
        track = view.track;
        for (const hud of this.huds) hud.setTrack(track);
      }
      const fps = view.fps;
      for (let p = 0; p < this.huds.length; p++) {
        const snap = this.app.view.hud(p);
        if (!snap) continue;
        if (p === 0) this.setAutoHold(snap.phase === 'intro' || snap.phase === 'countdown');
        this.huds[p]!.update(snap, fps);
      }
    };
    const frame = () => {
      this.raf = requestAnimationFrame(frame);
      refresh();
    };
    // Sync once now: a freshly built HUD must not paint a frame in its default racing look
    // (LAP 1/3, position, speedometer) over the intro fly-over before its first update.
    refresh();
    this.raf = requestAnimationFrame(frame);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Auto-accelerate must not hold the throttle before GO (that stalls the engine). */
  private setAutoHold(on: boolean): void {
    if (on === this.autoHold) return;
    this.autoHold = on;
    (this.app.input as Partial<TurboInputManager>).holdAutoAccelerate?.(on);
  }

  // ───────────────────────── loading card ─────────────────────────

  private showLoading(r: RaceRun): void {
    this.loading = true;
    const meta = getTrackMeta(r.config.trackId);
    const cup = CUPS.find(c => c.id === meta.cup);
    const theme = THEME_COLORS[meta.theme];
    this.loadingEl.style.setProperty('--t-a', theme.a);
    this.loadingEl.style.setProperty('--t-b', theme.b);
    this.loadingEl.replaceChildren(
      h('div', 'race-loading__card',
        cup ? cupEmblem(cup) : null,
        h('span', 'race-loading__sub', r.subtitle),
        h('strong', 'race-loading__title', meta.name),
        h('span', 'race-loading__en', meta.nameEn),
        h('div', 'busy__wheel', h('i'), h('i'), h('i')),
        h('p', 'race-loading__tip', h('b', null, 'TIP'), TIPS[Math.floor(Math.random() * TIPS.length)]!)),
    );
    this.loadingEl.hidden = false;
  }

  private hideLoading(): void {
    this.loading = false;
    this.loadingEl.hidden = true;
  }
}
