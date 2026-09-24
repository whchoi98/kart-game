import type { App } from '../app.js';
import { h } from '../dom.js';
import { BaseScreen, frame } from '../screen.js';
import { tabs } from '../widgets.js';

type Bind = [action: string, keys: string[][]];

const key = (k: string) => h('kbd', `keycap ${k.length > 2 ? 'keycap--wide' : ''}`, k);

function bindList(rows: Bind[], cls = ''): HTMLElement {
  return h('dl', `binds ${cls}`, ...rows.map(([action, groups]) => h('div', 'binds__row',
    h('dt', null, action),
    h('dd', null, ...groups.flatMap((g, gi) => [gi > 0 ? h('span', 'binds__or', '또는') : null, h('span', 'binds__combo', ...g.map(key))])))));
}

/** Mini keyboard diagram with highlighted clusters. */
function keyboardDiagram(hi: Record<string, 'p1' | 'p2' | 'all'>): HTMLElement {
  const rows = [
    ['Esc', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
    ['Shift', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/', 'Shift→'],
    ['Space', 'Ctrl→'],
  ];
  const kb = h('div', 'kbd-diagram');
  rows.forEach((r, ri) => {
    const row = h('div', `kbd-diagram__row kbd-diagram__row--${ri}`);
    for (const k of r) {
      const cls = hi[k] ? `is-${hi[k]}` : '';
      const label = k === 'Shift→' ? 'Shift' : k === 'Ctrl→' ? 'Ctrl' : k;
      row.append(h('span', `kbd-diagram__key ${cls} ${k === 'Space' ? 'is-space' : ''} ${label.length > 2 ? 'is-wide' : ''}`, label));
    }
    kb.append(row);
  });
  const arrows = h('div', 'kbd-diagram__arrows',
    h('span', `kbd-diagram__key ${hi['↑'] ? `is-${hi['↑']}` : ''}`, '↑'),
    h('span', 'kbd-diagram__break'),
    h('span', `kbd-diagram__key ${hi['←'] ? `is-${hi['←']}` : ''}`, '←'),
    h('span', `kbd-diagram__key ${hi['↓'] ? `is-${hi['↓']}` : ''}`, '↓'),
    h('span', `kbd-diagram__key ${hi['→'] ? `is-${hi['→']}` : ''}`, '→'));
  return h('div', 'kbd-wrap', kb, arrows);
}

function gamepadDiagram(): HTMLElement {
  const el = h('div', 'pad-diagram');
  el.innerHTML = `<svg viewBox="0 0 420 250" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M110 70h200c50 0 84 36 92 86l8 46c6 36-36 56-60 30l-38-40H108l-38 40c-24 26-66 6-60-30l8-46c8-50 42-86 92-86Z" fill="#2d1b5e" stroke="#1b1036" stroke-width="6" stroke-linejoin="round"/>
    <rect x="92" y="44" width="66" height="22" rx="10" fill="#8b5cff" stroke="#1b1036" stroke-width="4"/>
    <rect x="262" y="44" width="66" height="22" rx="10" fill="#8b5cff" stroke="#1b1036" stroke-width="4"/>
    <path d="M86 118h18v-18h18v18h18v18h-18v18h-18v-18H86Z" fill="#fff" stroke="#1b1036" stroke-width="3" stroke-linejoin="round"/>
    <circle cx="160" cy="176" r="22" fill="#4a3a80" stroke="#1b1036" stroke-width="4"/><circle cx="160" cy="176" r="12" fill="#6c5aa8"/>
    <circle cx="260" cy="176" r="22" fill="#4a3a80" stroke="#1b1036" stroke-width="4"/><circle cx="260" cy="176" r="12" fill="#6c5aa8"/>
    <circle cx="322" cy="96" r="13" fill="#ffd23f" stroke="#1b1036" stroke-width="3"/><text x="322" y="101" text-anchor="middle" font-size="14" font-weight="700" fill="#1b1036">Y</text>
    <circle cx="298" cy="120" r="13" fill="#2f8cff" stroke="#1b1036" stroke-width="3"/><text x="298" y="125" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">X</text>
    <circle cx="346" cy="120" r="13" fill="#ff4d5e" stroke="#1b1036" stroke-width="3"/><text x="346" y="125" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">B</text>
    <circle cx="322" cy="144" r="13" fill="#3ddc84" stroke="#1b1036" stroke-width="3"/><text x="322" y="149" text-anchor="middle" font-size="14" font-weight="700" fill="#1b1036">A</text>
    <rect x="232" y="104" width="26" height="12" rx="6" fill="#fff" stroke="#1b1036" stroke-width="3"/>
  </svg>`;
  const tag = (cls: string, text: string) => h('span', `pad-diagram__tag ${cls}`, text);
  el.append(
    tag('t-lb', 'LB / LT · 아이템'), tag('t-rb', 'RB / RT · 드리프트'),
    tag('t-dpad', '왼쪽 스틱 / 방향 패드 · 조향'), tag('t-a', 'A · 가속'), tag('t-b', 'B · 브레이크'),
    tag('t-xy', 'X / Y · 뒤보기'), tag('t-start', 'START · 일시 정지'),
  );
  return el;
}

function touchDiagram(): HTMLElement {
  return h('div', 'touch-diagram',
    h('div', 'touch-diagram__screen',
      h('div', 'touch-diagram__steer', h('span', 'touch-diagram__stick'), h('b', null, '왼쪽 화면을 좌우로 드래그해 조향')),
      h('div', 'touch-diagram__btns',
        h('span', 'tdb tdb--accel', '가속'), h('span', 'tdb tdb--brake', '브레이크'), h('span', 'tdb tdb--drift', '드리프트'),
        h('span', 'tdb tdb--item', '아이템'), h('span', 'tdb tdb--back', '뒤보기')),
      h('span', 'touch-diagram__pause', 'II')),
    h('p', 'touch-diagram__note', '손가락을 버튼 사이로 미끄러뜨려도 돼요. 설정에서 "자동 가속"을 켜면 조향과 드리프트에만 집중할 수 있어요.'));
}

const TIPS: Array<[string, string]> = [
  ['미니 터보', '드리프트 버튼을 누른 채 코너를 돌면 불꽃 색이 파랑 → 주황 → 보라로 바뀌어요. 버튼을 떼면 그만큼 부스트!'],
  ['로켓 스타트', '카운트다운 "1"이 사라지기 직전에 가속하면 힘차게 출발해요. 너무 일찍 누르면 엔진이 멈춰요.'],
  ['아이템 방어', '바나나나 구슬을 뒤에 들고 있으면 뒤에서 오는 공격을 막아 줘요.'],
  ['뒤로 던지기', '뒤보기 버튼을 누른 채 아이템을 쓰면 뒤쪽으로 던져요.'],
];

export function createControlsScreen(app: App): BaseScreen {
  const s = new BaseScreen(app, 'guide');
  s.music = 'menu';
  s.backdrop = { kind: 'title' };
  s.hints = [{ key: 'tabs', label: '탭 전환' }, { key: 'back', label: '뒤로' }];
  const { body } = frame(s, app, { kicker: '도움말', title: '조작 안내', bodyCls: 'guide__body' });
  const panes: Record<string, HTMLElement> = {
    kb1: h('div', 'guide__pane',
      keyboardDiagram({ W: 'all', A: 'all', S: 'all', D: 'all', '↑': 'all', '←': 'all', '↓': 'all', '→': 'all', Space: 'all', Shift: 'all', 'Shift→': 'all', E: 'all', Z: 'all', Q: 'all', C: 'all', Esc: 'all', P: 'all', 'Ctrl→': 'all' }),
      bindList([
        ['조향', [['←', '→'], ['A', 'D']]],
        ['가속', [['↑'], ['W']]],
        ['브레이크 · 후진', [['↓'], ['S']]],
        ['드리프트 · 점프', [['Space'], ['Shift']]],
        ['아이템 사용', [['E'], ['Z'], ['오른쪽 Ctrl']]],
        ['뒤보기 · 뒤로 던지기', [['Q'], ['C']]],
        ['일시 정지', [['Esc'], ['P']]],
      ])),
    kb2: h('div', 'guide__pane guide__pane--duo',
      keyboardDiagram({ W: 'p1', A: 'p1', S: 'p1', D: 'p1', Shift: 'p1', E: 'p1', Q: 'p1', '↑': 'p2', '←': 'p2', '↓': 'p2', '→': 'p2', 'Shift→': 'p2', '/': 'p2', '.': 'p2', ',': 'p2', 'Ctrl→': 'p2', Esc: 'all', P: 'all' }),
      h('div', 'guide__duo',
        h('div', 'guide__player guide__player--p1', h('h3', null, 'P1 · 위쪽 화면'), bindList([
          ['조향', [['A', 'D']]], ['가속', [['W']]], ['브레이크', [['S']]], ['드리프트', [['왼쪽 Shift']]], ['아이템', [['E']]], ['뒤보기', [['Q']]],
        ])),
        h('div', 'guide__player guide__player--p2', h('h3', null, 'P2 · 아래쪽 화면'), bindList([
          ['조향', [['←', '→']]], ['가속', [['↑']]], ['브레이크', [['↓']]], ['드리프트', [['오른쪽 Shift'], ['/'], ['Num 0']]],
          ['아이템', [['Enter'], ['.'], ['Num 1']]], ['뒤보기', [['오른쪽 Ctrl'], [',']]],
        ]))),
      h('p', 'guide__note', '게임패드를 연결하면 첫 번째 패드가 P1, 두 번째 패드가 P2를 조작해요. 일시 정지: Esc · P · START')),
    pad: h('div', 'guide__pane guide__pane--single', gamepadDiagram(),
      h('p', 'guide__note', '메뉴: 방향 패드/스틱 이동 · A 선택 · B 뒤로 · LB/RB 탭 전환. 1인 플레이에서는 어떤 게임패드로도 조작할 수 있어요.')),
    touch: h('div', 'guide__pane guide__pane--single', touchDiagram()),
  };
  const tipList = h('ul', 'guide__tips', ...TIPS.map(([t, d]) => h('li', null, h('b', null, t), h('span', null, d))));
  const holder = h('div', 'guide__holder');
  const show = (id: string) => holder.replaceChildren(panes[id]!);
  const t = tabs(app, {
    items: [{ id: 'kb1', label: '키보드 1인' }, { id: 'kb2', label: '키보드 2인' }, { id: 'pad', label: '게임패드' }, { id: 'touch', label: '터치' }],
    active: app.input.touchDetected ? 'touch' : 'kb1',
    onChange: show,
  });
  show(t.get());
  body.append(t.el, holder, h('section', 'guide__tipbox', h('h2', null, '레이싱 팁'), tipList));
  s.onTab = dir => t.step(dir);
  return s;
}
