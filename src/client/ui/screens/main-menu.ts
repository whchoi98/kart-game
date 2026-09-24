import type { App } from '../app.js';
import { logo } from '../art/logo.js';
import { trophySvg } from '../art/icons.js';
import { h, svg } from '../dom.js';
import { startDuo, startGrandPrix, startTimeTrial, startVersus } from '../flows.js';
import { installButton, offlineChip, pendingNotice, updateBanner } from '../pwa-ui.js';
import { BaseScreen } from '../screen.js';
import { button, portrait } from '../widgets.js';
import { createControlsScreen } from './controls.js';
import { createCreditsScreen } from './credits.js';
import { createLeaderboardScreen } from './leaderboard.js';
import { createSettingsScreen } from './settings.js';

class MainMenu extends BaseScreen {
  private readonly profile: HTMLElement;

  constructor(app: App) {
    super(app, 'menu', { wrap: true });
    this.music = 'title';
    this.backdrop = { kind: 'title' };
    this.hints = [{ key: 'move', label: '이동' }, { key: 'confirm', label: '선택' }, { key: 'back', label: '타이틀' }];

    const modes = h('div', 'menu__modes',
      button(app, { label: '그랑프리', sub: '4개 코스 컵 레이스', icon: 'trophy', variant: 'mode', cls: 'mode--gp', autofocus: true, onClick: () => startGrandPrix(app) }),
      button(app, { label: 'VS 레이스', sub: '원하는 코스에서 자유 대결', icon: 'flag', variant: 'mode', cls: 'mode--vs', onClick: () => startVersus(app) }),
      button(app, { label: '타임 어택', sub: '고스트와 기록 경쟁', icon: 'stopwatch', variant: 'mode', cls: 'mode--tt', onClick: () => startTimeTrial(app) }),
      button(app, { label: '2인 대전', sub: '한 화면 위아래 분할', icon: 'duo', variant: 'mode', cls: 'mode--duo', onClick: () => startDuo(app) }),
    );
    const extras = h('div', 'menu__extras',
      button(app, { label: '랭킹', icon: 'podium', variant: 'ghost', onClick: () => app.push(createLeaderboardScreen(app)) }),
      button(app, { label: '설정', icon: 'gear', variant: 'ghost', onClick: () => app.push(createSettingsScreen(app)) }),
      button(app, { label: '조작 안내', icon: 'gamepad', variant: 'ghost', onClick: () => app.push(createControlsScreen(app)) }),
      button(app, { label: '크레딧', icon: 'heart', variant: 'ghost', onClick: () => app.push(createCreditsScreen(app)) }),
    );
    this.profile = h('aside', 'menu__profile');
    // Right column: app status + install, update banner, waiting offline runs, then the profile card.
    const chip = offlineChip(app, { hideUnsupported: true });
    const install = installButton(app);
    const update = updateBanner(app);
    const pending = pendingNotice(app, this.nav);
    for (const w of [chip, install, update, pending]) this.own(w.dispose);
    // a notice appearing / vanishing under the player's focus must not strand it
    this.own(app.on('pending', () => { if (app.top === this && !this.nav.focused) this.nav.focusFirst(); }));
    this.el.append(
      h('div', 'menu__stripes'),
      h('div', 'menu__head', logo('small')),
      h('div', 'menu__main', modes, extras),
      h('div', 'menu__side',
        h('div', 'menu__sys', chip.el, install.el),
        update.el,
        pending.el,
        this.profile),
    );
  }

  override show(first: boolean): void {
    this.renderProfile();
    super.show(first);
  }

  override onBack(): void {
    this.app.sound('back');
    this.app.toTitle();
  }

  private renderProfile(): void {
    const { storage, settings, memory } = this.app;
    const stats = storage.getStats();
    const trophies = Object.values(storage.getTrophies());
    const count = (t: string) => trophies.filter(x => x === t).length;
    const name = settings.playerName || '이름 없는 레이서';
    const unlocks = storage.getUnlocks();
    this.profile.replaceChildren(
      h('div', 'profile__top', portrait(memory.charId, 'portrait profile__portrait'),
        h('div', 'profile__who', h('span', 'profile__kicker', '레이서'), h('strong', 'profile__name', name))),
      h('div', 'profile__trophies',
        ...(['gold', 'silver', 'bronze'] as const).map(t => h('span', `profile__trophy profile__trophy--${t}`, svg(trophySvg(t), 'ico'), h('b', null, String(count(t)))))),
      h('dl', 'profile__stats',
        h('div', null, h('dt', null, '레이스'), h('dd', null, String(stats.races))),
        h('div', null, h('dt', null, '우승'), h('dd', null, String(stats.wins))),
        h('div', null, h('dt', null, '포디움'), h('dd', null, String(stats.podiums)))),
      h('div', 'profile__unlocks',
        h('span', `chip ${unlocks.cc200 ? 'chip--on' : ''}`, unlocks.cc200 ? '200cc 해금' : '200cc 잠김'),
        h('span', `chip ${unlocks.mirror ? 'chip--on' : ''}`, unlocks.mirror ? '미러 해금' : '미러 잠김')),
    );
  }
}

export function createMainMenu(app: App): BaseScreen {
  return new MainMenu(app);
}
