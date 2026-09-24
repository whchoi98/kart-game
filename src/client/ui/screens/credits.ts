import { CHARACTERS } from '../../../sim/characters.js';
import type { App } from '../app.js';
import { logo } from '../art/logo.js';
import { h } from '../dom.js';
import { BaseScreen, frame } from '../screen.js';
import { portrait } from '../widgets.js';
import { APP_VERSION } from './title.js';

export function createCreditsScreen(app: App): BaseScreen {
  const s = new BaseScreen(app, 'credits');
  s.music = 'menu';
  s.backdrop = { kind: 'title' };
  s.hints = [{ key: 'back', label: '뒤로' }];
  const { body } = frame(s, app, { kicker: 'TURBO PALS GRAND PRIX', title: '크레딧', bodyCls: 'credits__body' });
  const block = (title: string, ...lines: Array<string | HTMLElement>) =>
    h('section', 'credits__block', h('h2', null, title), ...lines.map(l => (typeof l === 'string' ? h('p', null, l) : l)));
  const cast = h('div', 'credits__cast', ...CHARACTERS.map(c => h('span', 'credits__member', portrait(c.id, 'portrait portrait--sm'), h('b', null, c.name), h('small', null, c.nameEn))));
  const scroller = h('div', 'credits__scroll',
    logo('small'),
    block('오리지널 게임',
      '모든 캐릭터, 코스, 아이템, 그래픽과 음악은 TURBO PALS GRAND PRIX를 위해 새로 만든 창작물이에요.'),
    block('출연', cast),
    block('게임 디자인 · 개발', 'TURBO PALS TEAM'),
    block('그래픽', '실시간 절차적 3D 모델과 텍스처 (three.js · Canvas 2D)', '캐릭터 초상화와 아이템 아이콘: 직접 그린 SVG 일러스트'),
    block('음악 · 효과음', 'Web Audio API로 실시간 합성하는 절차적 음악과 효과음'),
    block('오픈 소스',
      h('p', null, h('b', null, 'three.js'), ' — MIT License'),
      h('p', null, h('b', null, 'Fastify'), ' — MIT License'),
      h('p', null, h('b', null, 'Black Han Sans · Jua 글꼴'), ' — SIL Open Font License 1.1')),
    block('감사합니다!', '끝까지 달려 주셔서 고마워요. 다음 레이스에서 만나요!', `버전 ${APP_VERSION}`),
  );
  const focusTarget = h('div', 'credits__focus');
  focusTarget.dataset.nav = '';
  focusTarget.tabIndex = 0;
  focusTarget.append(scroller);
  body.append(focusTarget);
  s.onMenu = action => {
    if (action === 'up' || action === 'down') {
      focusTarget.scrollBy({ top: action === 'down' ? 120 : -120, behavior: 'smooth' });
      return true;
    }
    return false;
  };
  return s;
}
