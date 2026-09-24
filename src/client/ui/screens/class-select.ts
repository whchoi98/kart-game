import type { CpuLevel, RaceMode, SpeedClass } from '../../../sim/types.js';
import type { App } from '../app.js';
import { h } from '../dom.js';
import { BaseScreen, frame } from '../screen.js';
import { button, choice, icon, toggle } from '../widgets.js';

export interface ClassSelection { cc: SpeedClass; cpuLevel: CpuLevel; mirror: boolean }

export const MODE_LABEL: Record<RaceMode, string> = { gp: '그랑프리', vs: 'VS 레이스', tt: '타임 어택', duo: '2인 대전' };

const CC_INFO: Record<SpeedClass, { name: string; desc: string }> = {
  50: { name: '입문', desc: '느긋하게 코스를 익혀요' },
  100: { name: '표준', desc: '드리프트에 익숙해질 시간' },
  150: { name: '고속', desc: '진짜 레이서의 무대' },
  200: { name: '극한', desc: '브레이크를 잊지 마세요' },
};

export const CPU_LABEL: Record<CpuLevel, string> = { easy: '쉬움', normal: '보통', hard: '어려움' };

export const LOCK_200 = '150cc 그랑프리에서 금 트로피를 따면 열려요.';
export const LOCK_MIRROR = '150cc 두 컵에서 모두 금 트로피를 따면 열려요.';

export function createClassScreen(app: App, o: {
  mode: RaceMode; steps: string[]; onNext(sel: ClassSelection): void;
}): BaseScreen {
  const s = new BaseScreen(app, 'setup setup--class');
  s.backdrop = { kind: 'title' };
  s.music = 'menu';
  const { body } = frame(s, app, { kicker: MODE_LABEL[o.mode], title: '클래스 선택', steps: o.steps, step: 0 });
  const unlocks = app.storage.getUnlocks();
  const isTT = o.mode === 'tt';
  const hasCpu = o.mode !== 'tt';
  const hasMirror = o.mode === 'gp' || o.mode === 'vs';
  let cc: SpeedClass = isTT ? app.memory.ttCc : app.memory.cc;
  if (cc === 200 && !unlocks.cc200) cc = 150;
  let cpuLevel = app.memory.cpuLevel;
  let mirror = hasMirror && unlocks.mirror && app.memory.mirror;

  const cards = h('div', 'cc-cards');
  const cardEls = new Map<SpeedClass, HTMLButtonElement>();
  const next = () => {
    if (isTT) app.memory.ttCc = cc; else { app.memory.cc = cc; app.memory.cpuLevel = cpuLevel; app.memory.mirror = mirror; }
    o.onNext({ cc, cpuLevel, mirror });
  };
  const render = () => {
    for (const [k, el] of cardEls) {
      el.classList.toggle('is-on', k === cc);
      el.setAttribute('aria-pressed', k === cc ? 'true' : 'false');
    }
  };
  let extra: HTMLElement | null = null;
  ([50, 100, 150, 200] as SpeedClass[]).forEach((k, i) => {
    const locked = k === 200 && !unlocks.cc200;
    const gauge = h('span', 'cc-card__gauge', ...Array.from({ length: 4 }, (_, j) => h('i', j <= i ? 'is-on' : '')));
    const b = button(app, {
      label: `${k}cc`, sub: locked ? '잠김' : CC_INFO[k].name, variant: 'secondary', cls: `cc-card cc-card--${k}`,
      locked: () => (locked ? LOCK_200 : null),
      autofocus: k === cc,
      onClick: () => {
        cc = k;
        render();
        if (isTT) next();
        else if (extra) s.nav.focus(extra.querySelector<HTMLElement>('[data-nav]'), { sound: false });
      },
    });
    b.prepend(gauge);
    b.append(h('span', 'cc-card__desc', locked ? LOCK_200 : CC_INFO[k].desc));
    cardEls.set(k, b);
    cards.append(b);
  });
  body.append(cards);

  if (!isTT) {
    extra = h('div', 'setup__rows');
    if (hasCpu) {
      extra.append(choice<CpuLevel>(app, {
        label: 'CPU 난이도', icon: 'cpu', value: cpuLevel,
        options: (['easy', 'normal', 'hard'] as CpuLevel[]).map(v => ({ value: v, label: CPU_LABEL[v] })),
        onChange: v => { cpuLevel = v; },
      }).el);
    }
    if (hasMirror) {
      extra.append(toggle(app, {
        label: '미러 모드', icon: 'mirror', value: mirror,
        locked: () => (unlocks.mirror ? null : LOCK_MIRROR),
        onChange: v => { mirror = v; },
      }).el);
    }
    const go = button(app, { label: '다음', icon: 'next', variant: 'go', cls: 'setup__next', onClick: next });
    body.append(h('div', 'setup__bottom', extra, go));
  } else {
    body.append(h('p', 'setup__note', icon('info', 'ico'), '랭킹은 클래스별로 따로 집계돼요.'));
  }
  render();
  return s;
}
