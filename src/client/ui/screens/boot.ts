import type { App } from '../app.js';
import { logo } from '../art/logo.js';
import { h } from '../dom.js';
import { BaseScreen } from '../screen.js';

/** Loading splash shown while fonts and the 3D backdrop warm up. */
export function createBootScreen(app: App): BaseScreen {
  const s = new BaseScreen(app, 'boot');
  s.hints = [];
  s.el.append(
    h('div', 'boot__center',
      logo('small'),
      h('div', 'boot__bar', h('i')),
      h('p', 'boot__text', '엔진 예열 중…')),
  );
  return s;
}
