import { API_LIMITS } from '../../../shared/api.js';
import type { QualityLevel, Settings } from '../../contracts.js';
import type { App } from '../app.js';
import { h } from '../dom.js';
import { normalizePlayerName, validatePlayerName } from '../format.js';
import { installButton, offlineDetail } from '../pwa-ui.js';
import { BaseScreen, frame } from '../screen.js';
import { choice, slider, textRow, toggle } from '../widgets.js';
import { APP_VERSION } from './title.js';

export function createSettingsScreen(app: App, o: { inRace?: boolean } = {}): BaseScreen {
  const s = new BaseScreen(app, `settings ${o.inRace ? 'settings--race' : ''}`, { wrap: true });
  if (!o.inRace) { s.music = 'menu'; s.backdrop = { kind: 'title' }; }
  s.hints = [{ key: 'move', label: '이동' }, { key: 'adjust', label: '변경' }, { key: 'back', label: '뒤로' }];
  const { body } = frame(s, app, { kicker: o.inRace ? '일시 정지' : '옵션', title: '설정', bodyCls: 'settings__body' });
  const set = (patch: Partial<Settings>) => app.updateSettings(patch);
  const st = app.settings;
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  const section = (title: string, ...rows: HTMLElement[]) => h('section', 'settings__section', h('h2', 'settings__title', title), ...rows);

  const volume = section('사운드',
    slider(app, { label: '전체 음량', icon: 'volume', value: st.master, format: pct, onChange: v => set({ master: v }) }).el,
    slider(app, { label: '음악', icon: 'music', value: st.music, format: pct, onChange: v => set({ music: v }) }).el,
    slider(app, { label: '효과음', icon: 'sparkle', value: st.sfx, format: pct, onChange: v => set({ sfx: v }) }).el,
  );
  const first = volume.querySelector<HTMLElement>('[data-nav]');
  if (first) first.dataset.autofocus = '';

  const display = section('화면',
    choice<QualityLevel>(app, {
      label: '그래픽 품질', icon: 'eye', value: st.quality,
      options: [{ value: 'auto', label: '자동' }, { value: 'low', label: '낮음' }, { value: 'medium', label: '중간' }, { value: 'high', label: '높음' }],
      onChange: v => set({ quality: v }),
    }).el,
    choice<Settings['cameraDistance']>(app, {
      label: '카메라 거리', icon: 'flag', value: st.cameraDistance,
      options: [{ value: 'near', label: '가깝게' }, { value: 'normal', label: '보통' }, { value: 'far', label: '멀리' }],
      onChange: v => set({ cameraDistance: v }),
    }).el,
    toggle(app, { label: '화면 흔들림', icon: 'bolt', value: st.shake, onChange: v => set({ shake: v }) }).el,
    toggle(app, { label: '속도계 표시', icon: 'speed', value: st.showSpeed, onChange: v => set({ showSpeed: v }) }).el,
    toggle(app, { label: 'FPS 표시', icon: 'info', value: st.showFps, onChange: v => set({ showFps: v }) }).el,
  );

  const controls = section('조작',
    toggle(app, { label: '자동 가속', icon: 'play', value: st.autoAccelerate, onChange: v => set({ autoAccelerate: v }) }).el,
    toggle(app, { label: '진동', icon: 'gamepad', value: st.rumble, onChange: v => set({ rumble: v }) }).el,
    h('p', 'settings__note', '자동 가속을 켜면 가속 버튼을 누르지 않아도 달려요. 브레이크를 누르면 멈추거나 후진해요. 진동은 게임패드(지원하는 휴대폰은 터치 조작)가 부딪힘·부스트 때 떨리는 효과예요.'),
  );

  const name = textRow(app, {
    label: '닉네임', icon: 'star', value: st.playerName, placeholder: '랭킹에 표시될 이름 (1~12자)', maxLength: API_LIMITS.nameMax,
    onInput: v => {
      const c = validatePlayerName(v);
      name.setError(v.trim() && !c.ok ? c.message : null);
    },
    onCommit: v => {
      const trimmed = normalizePlayerName(v);
      if (trimmed === '') { set({ playerName: '' }); name.setError(null); return; }
      const c = validatePlayerName(trimmed);
      if (c.ok) { set({ playerName: c.name }); name.set(c.name); name.setError(null); }
      else name.setError(c.message);
    },
  });
  const profile = section('프로필', name.el,
    h('p', 'settings__note', app.storage.persistent
      ? '설정과 기록은 이 브라우저에 저장돼요.'
      : '이 브라우저에서는 저장소를 쓸 수 없어 설정과 기록이 이번 방문 동안만 유지돼요.'));

  // App (PWA): offline readiness + retry, install. Updates are applied from the menus, never mid-race.
  const offline = offlineDetail(app);
  const install = installButton(app, { cls: 'settings__install' });
  s.own(offline.dispose);
  s.own(install.dispose);
  const appSection = section('앱',
    offline.el,
    install.el,
    h('p', 'settings__note', `버전 v${APP_VERSION}${o.inRace ? ' · 새 버전은 레이스가 끝난 뒤 메뉴에서 적용할 수 있어요.' : ''}`),
  );
  appSection.classList.add('settings__section--app');
  // hide the whole section when there is nothing to show (dev build without a service worker)
  const refreshApp = () => { appSection.hidden = offline.el.hidden && install.el.hidden && !app.pwa; };
  s.own(app.on('pwa', refreshApp));
  refreshApp();

  body.append(h('div', 'settings__grid', volume, display, controls, profile, appSection));
  return s;
}
