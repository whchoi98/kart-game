/** Screen contract + base class shared by every menu / flow screen. */
import type { CharacterId } from '../../sim/types.js';
import type { MenuAction, MusicCue } from '../contracts.js';
import { h } from './dom.js';
import { Nav, type NavOptions } from './nav.js';
import type { App } from './app.js';
import { ICON } from './art/icons.js';
import { svg } from './dom.js';

export type MenuSource = 'keyboard' | 'gamepad' | 'touch';
export type InputKind = 'keyboard' | 'gamepad' | 'touch' | 'mouse';
export type HintKey = 'confirm' | 'back' | 'tabs' | 'adjust' | 'move' | 'pause';
export interface HintSpec { key: HintKey; label: string }

export interface Backdrop { kind: 'title' | 'garage'; charId?: CharacterId }

export interface Screen {
  readonly el: HTMLElement;
  readonly nav: Nav | null;
  /** Music cue while this screen is on top (undefined = leave as is, null = silence). */
  readonly music?: MusicCue | null;
  readonly backdrop?: Backdrop | null;
  readonly inputMode?: 'single' | 'duo';
  readonly touchControls?: boolean;
  /** Race HUD / results over the 3D scene: hide the global hint bar. */
  readonly immersive?: boolean;
  readonly hints?: HintSpec[];
  show(first: boolean): void;
  hide(): void;
  dispose(): void;
  /** Return true when the action was consumed. */
  onMenu?(action: MenuAction, source: MenuSource, player: number): boolean;
  onBack?(): void;
  onTab?(dir: -1 | 1): void;
}

export const DEFAULT_HINTS: HintSpec[] = [
  { key: 'move', label: '이동' },
  { key: 'confirm', label: '선택' },
  { key: 'back', label: '뒤로' },
];

export class BaseScreen implements Screen {
  readonly el: HTMLElement;
  readonly nav: Nav;
  music?: MusicCue | null;
  backdrop?: Backdrop | null;
  inputMode?: 'single' | 'duo';
  touchControls?: boolean;
  immersive?: boolean;
  hints?: HintSpec[] = DEFAULT_HINTS;
  onMenu?(action: MenuAction, source: MenuSource, player: number): boolean;
  onBack?(): void;
  onTab?(dir: -1 | 1): void;
  private readonly disposers: Array<() => void> = [];

  constructor(protected readonly app: App, cls: string, navOpts: NavOptions = {}) {
    this.el = h('section', `screen ${cls}`);
    this.el.setAttribute('role', 'region');
    this.nav = new Nav(this.el, { onMove: () => app.sound('move'), ...navOpts });
  }

  show(first: boolean): void {
    if (first) this.nav.focusFirst();
    else this.nav.restore();
  }

  hide(): void { /* override */ }

  dispose(): void {
    this.nav.dispose();
    for (const d of this.disposers.splice(0)) {
      try { d(); } catch { /* ignore */ }
    }
  }

  /** Register cleanup to run on dispose. */
  own(fn: () => void): void {
    this.disposers.push(fn);
  }
}

export interface FrameParts { header: HTMLElement; body: HTMLElement; title: HTMLElement }

/** Standard menu chrome: back button, kicker + title ribbon, optional step trail. */
export function frame(
  screen: BaseScreen,
  app: App,
  opts: { title: string; kicker?: string; steps?: string[]; step?: number; onBack?: () => void; bodyCls?: string },
): FrameParts {
  const back = h('button', 'hdr__back');
  back.type = 'button';
  back.setAttribute('aria-label', '뒤로');
  back.tabIndex = -1;
  back.append(svg(ICON.back));
  back.addEventListener('click', () => {
    app.sound('back');
    if (opts.onBack) opts.onBack();
    else if (screen.onBack) screen.onBack();
    else app.back();
  });
  const title = h('h1', 'hdr__title', opts.title);
  const titleWrap = h('div', 'hdr__ribbon', opts.kicker ? h('span', 'hdr__kicker', opts.kicker) : null, title);
  const header = h('header', 'hdr', back, titleWrap);
  if (opts.steps && opts.steps.length > 1) {
    const trail = h('ol', 'hdr__steps');
    opts.steps.forEach((s, i) => {
      const li = h('li', i === opts.step ? 'is-current' : i < (opts.step ?? 0) ? 'is-done' : '', h('b', null, String(i + 1)), h('span', null, s));
      trail.append(li);
    });
    header.append(trail);
  }
  const body = h('div', `screen__body ${opts.bodyCls ?? ''}`);
  screen.el.append(header, body);
  return { header, body, title };
}
