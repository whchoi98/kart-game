import type { MenuAction } from '../../contracts.js';
import type { App } from '../app.js';
import { logo } from '../art/logo.js';
import { h } from '../dom.js';
import { installButton, offlineChip, updateBanner } from '../pwa-ui.js';
import { BaseScreen } from '../screen.js';

declare const __APP_VERSION__: string;
export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

class TitleScreen extends BaseScreen {
  private leaving = false;
  private readyAt = 0;

  constructor(app: App) {
    super(app, 'title');
    this.backdrop = { kind: 'title' };
    this.hints = [];
    const press = h('p', 'title__press');
    press.textContent = app.input.touchDetected ? '화면을 터치하세요' : '아무 키나 누르세요';
    const sparkles = h('div', 'sparkles', ...Array.from({ length: 14 }, (_, i) => h('i', `sparkle sparkle--${i % 7}`)));
    // PWA: discreet offline status (bottom left), 앱 설치 (bottom right), update banner (top).
    // Taps on them must not also "press any key" through to the main menu.
    const chip = offlineChip(app, { stopClicks: true, hideUnsupported: true });
    const install = installButton(app, { stopClicks: true, cls: 'title__install' });
    const update = updateBanner(app);
    this.own(chip.dispose);
    this.own(install.dispose);
    this.own(update.dispose);
    this.el.append(
      h('div', 'title__stripes'),
      sparkles,
      h('div', 'title__center', logo('hero'), press),
      h('div', 'title__top', update.el),
      h('div', 'title__sys', chip.el, install.el),
      h('p', 'title__foot', `© 2026 TURBO PALS TEAM · v${APP_VERSION}`),
    );
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.altKey || e.ctrlKey || e.key === 'Tab' || e.key === 'F5' || e.key === 'F12') return;
      this.go();
    };
    // 'click' (not pointerdown) so the whole tap is consumed here and cannot land on the next screen.
    this.el.addEventListener('click', () => this.go());
    window.addEventListener('keydown', onKey);
    this.own(() => window.removeEventListener('keydown', onKey));
  }

  override show(first: boolean): void {
    super.show(first);
    this.leaving = false;
    this.readyAt = performance.now() + 250;
  }

  override onMenu(_action: MenuAction): boolean {
    this.go();
    return true;
  }

  override onBack(): void {
    this.go();
  }

  private go(): void {
    if (this.leaving || performance.now() < this.readyAt || this.app.top !== this) return;
    this.leaving = true;
    // Must run inside the gesture handler so the AudioContext may start.
    this.app.audio.unlock().catch(() => undefined).finally(() => {
      this.app.playMusic('title');
    });
    this.app.sound('start');
    const menu = this.app.mainMenu;
    if (menu) this.app.push(menu);
  }
}

export function createTitleScreen(app: App): BaseScreen {
  return new TitleScreen(app);
}
