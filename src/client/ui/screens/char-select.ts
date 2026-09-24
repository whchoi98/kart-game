import { CHARACTERS, getCharacter } from '../../../sim/characters.js';
import type { CharacterId } from '../../../sim/types.js';
import type { MenuAction } from '../../contracts.js';
import type { App } from '../app.js';
import { animate, h } from '../dom.js';
import { BaseScreen, frame, type MenuSource } from '../screen.js';
import { WEIGHT_LABEL, portrait, shake, statBars } from '../widgets.js';

function card(app: App, charId: CharacterId, onPick: () => void, sound = true): HTMLButtonElement {
  const ch = getCharacter(charId);
  const b = h('button', 'char-card');
  b.type = 'button';
  b.dataset.nav = '';
  b.dataset.char = charId;
  b.style.setProperty('--c-body', ch.colors.body);
  b.style.setProperty('--c-accent', ch.colors.accent);
  b.append(portrait(charId, 'portrait char-card__portrait'), h('span', 'char-card__name', ch.name), h('span', 'char-card__tags'));
  b.addEventListener('click', () => { if (sound) app.sound('select'); onPick(); });
  return b;
}

interface Detail { el: HTMLElement; set(id: CharacterId): void }

function detailPanel(cls = ''): Detail {
  const pic = h('div', 'char-detail__pic');
  const name = h('h2', 'char-detail__name');
  const en = h('span', 'char-detail__en');
  const weight = h('span', 'chip char-detail__weight');
  const tag = h('p', 'char-detail__tag');
  const stats = statBars(CHARACTERS[0]!.stats);
  const el = h('div', `char-detail ${cls}`, pic, h('div', 'char-detail__info', h('div', 'char-detail__title', name, en), weight, stats.el, tag));
  let current: CharacterId | null = null;
  return {
    el,
    set(id) {
      if (id === current) return;
      current = id;
      const ch = getCharacter(id);
      el.style.setProperty('--c-body', ch.colors.body);
      el.style.setProperty('--c-accent', ch.colors.accent);
      pic.replaceChildren(portrait(id, 'portrait char-detail__portrait'));
      animate(pic, [{ transform: 'scale(.85) rotate(-6deg)', opacity: 0.4 }, { transform: 'scale(1) rotate(0)', opacity: 1 }],
        { duration: 240, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      name.textContent = ch.name;
      en.textContent = ch.nameEn;
      weight.textContent = WEIGHT_LABEL[ch.weightClass];
      stats.set(ch.stats);
      tag.textContent = ch.tagline;
    },
  };
}

export function createCharSelect(app: App, o: {
  kicker: string; steps: string[]; step: number; initial?: CharacterId; onNext(id: CharacterId): void;
}): BaseScreen {
  const detail = detailPanel();
  const s = new BaseScreen(app, 'setup setup--char', {
    onFocus: el => {
      const id = el.dataset.char as CharacterId | undefined;
      if (id) { detail.set(id); app.setBackdrop('garage', id); }
    },
  });
  s.music = 'menu';
  const initial = o.initial ?? app.memory.charId;
  s.backdrop = { kind: 'garage', charId: initial };
  const { body } = frame(s, app, { kicker: o.kicker, title: '캐릭터 선택', steps: o.steps, step: o.step });
  const grid = h('div', 'char-grid');
  for (const ch of CHARACTERS) {
    const c = card(app, ch.id, () => {
      app.memory.charId = ch.id;
      o.onNext(ch.id);
    });
    if (ch.id === initial) c.dataset.autofocus = '';
    grid.append(c);
  }
  body.append(h('div', 'char-layout', grid, detail.el));
  detail.set(initial);
  return s;
}

// ───────────────────────── duo ─────────────────────────

class DuoCharSelect extends BaseScreen {
  private readonly idx: [number, number];
  private readonly ready: [boolean, boolean] = [false, false];
  private readonly cards: HTMLButtonElement[] = [];
  private readonly details: [Detail, Detail];
  private readonly status: [HTMLElement, HTMLElement];
  private finishing = false;

  constructor(app: App, private readonly o: { steps: string[]; step: number; onNext(ids: [CharacterId, CharacterId]): void }) {
    super(app, 'setup setup--char setup--duo');
    this.music = 'menu';
    this.inputMode = 'duo';
    this.backdrop = { kind: 'garage', charId: app.memory.charId };
    this.hints = [{ key: 'confirm', label: '선택' }, { key: 'back', label: '취소 / 뒤로' }];
    const ids = CHARACTERS.map(c => c.id);
    const i0 = Math.max(0, ids.indexOf(app.memory.charId));
    let i1 = Math.max(0, ids.indexOf(app.memory.p2CharId));
    if (i1 === i0) i1 = (i0 + 1) % ids.length;
    this.idx = [i0, i1];
    const { body } = frame(this, app, { kicker: '2인 대전', title: '캐릭터 선택', steps: o.steps, step: o.step });
    this.details = [detailPanel('char-detail--p1'), detailPanel('char-detail--p2')];
    this.status = [h('div', 'duo-status duo-status--p1'), h('div', 'duo-status duo-status--p2')];
    const grid = h('div', 'char-grid char-grid--duo');
    CHARACTERS.forEach((ch, i) => {
      const c = card(app, ch.id, () => this.pointerPick(i), false);
      c.removeAttribute('data-nav');
      c.tabIndex = -1;
      c.append(h('span', 'char-card__cursor char-card__cursor--p1', 'P1'), h('span', 'char-card__cursor char-card__cursor--p2', 'P2'));
      this.cards.push(c);
      grid.append(c);
    });
    const side = (p: 0 | 1) => h('div', `duo-side duo-side--p${p + 1}`,
      h('div', 'duo-side__tag', `P${p + 1}`), this.details[p].el, this.status[p],
      h('p', 'duo-side__keys', p === 0 ? 'WASD 이동 · Space 선택 · Esc 취소 · 게임패드 1' : '방향키 이동 · Enter 선택 · Backspace 취소 · 게임패드 2'));
    body.append(h('div', 'duo-layout', side(0), grid, side(1)));
    this.render();
  }

  override show(first: boolean): void {
    super.show(first);
    if (!first) {
      this.ready[0] = this.ready[1] = false;
      this.finishing = false;
      this.render();
    }
  }

  override onMenu(action: MenuAction, _source: MenuSource, player: number): boolean {
    if (this.finishing) return true;
    const p = (player === 1 ? 1 : 0) as 0 | 1;
    switch (action) {
      case 'up': case 'down': case 'left': case 'right':
        this.moveCursor(p, action);
        return true;
      case 'confirm':
        this.confirm(p);
        return true;
      case 'back':
        if (this.ready[p]) {
          this.ready[p] = false;
          this.app.sound('back');
          this.render();
        } else {
          this.app.sound('back');
          this.app.back();
        }
        return true;
      default:
        return true;
    }
  }

  override onBack(): void {
    this.app.sound('back');
    this.app.back();
  }

  private moveCursor(p: 0 | 1, dir: 'up' | 'down' | 'left' | 'right'): void {
    if (this.ready[p]) return;
    const cols = 4;
    const n = this.cards.length;
    let i = this.idx[p];
    if (dir === 'left') i = (i % cols === 0) ? i + cols - 1 : i - 1;
    if (dir === 'right') i = (i % cols === cols - 1) ? i - cols + 1 : i + 1;
    if (dir === 'up' || dir === 'down') i = (i + cols) % n;
    this.idx[p] = Math.max(0, Math.min(n - 1, i));
    this.app.sound('move');
    this.render();
  }

  private charAt(i: number): CharacterId {
    return CHARACTERS[i]!.id;
  }

  private confirm(p: 0 | 1): void {
    if (this.ready[p]) return;
    const other = (1 - p) as 0 | 1;
    if (this.ready[other] && this.idx[other] === this.idx[p]) {
      this.app.sound('error');
      shake(this.cards[this.idx[p]]!);
      this.app.notify(`P${other + 1}이(가) 이미 고른 캐릭터예요.`, 'info', 2000);
      return;
    }
    this.ready[p] = true;
    this.app.sound('select');
    const cardEl = this.cards[this.idx[p]]!;
    animate(cardEl, [{ transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
    this.render();
    if (this.ready[0] && this.ready[1]) {
      this.finishing = true;
      const ids: [CharacterId, CharacterId] = [this.charAt(this.idx[0]), this.charAt(this.idx[1])];
      this.app.memory.charId = ids[0];
      this.app.memory.p2CharId = ids[1];
      setTimeout(() => {
        if (this.app.top === this) this.o.onNext(ids);
      }, 650);
    }
  }

  private pointerPick(i: number): void {
    if (this.finishing) return;
    const p: 0 | 1 = !this.ready[0] ? 0 : 1;
    if (this.ready[p]) return;
    this.idx[p] = i;
    this.confirm(p);
  }

  private render(): void {
    this.cards.forEach((c, i) => {
      c.classList.toggle('is-p1', this.idx[0] === i);
      c.classList.toggle('is-p2', this.idx[1] === i);
      c.classList.toggle('is-ready-p1', this.ready[0] && this.idx[0] === i);
      c.classList.toggle('is-ready-p2', this.ready[1] && this.idx[1] === i);
      const taken = (this.ready[0] && this.idx[0] === i && !this.ready[1]) || (this.ready[1] && this.idx[1] === i && !this.ready[0]);
      c.classList.toggle('is-taken', taken);
    });
    for (const p of [0, 1] as const) {
      this.details[p].set(this.charAt(this.idx[p]));
      this.status[p].textContent = this.ready[p] ? '준비 완료!' : '고르는 중…';
      this.status[p].classList.toggle('is-ready', this.ready[p]);
    }
    this.app.setBackdrop('garage', this.charAt(this.idx[0]));
  }
}

export function createDuoCharSelect(app: App, o: { steps: string[]; step: number; onNext(ids: [CharacterId, CharacterId]): void }): BaseScreen {
  return new DuoCharSelect(app, o);
}

