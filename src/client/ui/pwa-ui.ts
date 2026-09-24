/**
 * Progressive Web App surfaces in the menus: offline-readiness chip, '앱 설치' action (browser
 * prompt or the iOS Share → 홈 화면에 추가 guide), the update banner (never during races) and the
 * notice for time-trial runs recorded offline that wait to be submitted.
 * State mapping lives in pwa-state.ts (pure, unit tested).
 */
import { getTrackMeta } from '../../sim/tracks/catalog.js';
import { describeRejection, errorMessage, isConnectivityError, submitRun, ApiRequestError } from '../api.js';
import type { PendingRun } from '../storage.js';
import { BUILD_META } from '../sw-policy.js';
import type { App, AppEvent } from './app.js';
import { ICON } from './art/icons.js';
import { h, svg } from './dom.js';
import { formatTicks, validatePlayerName } from './format.js';
import type { Nav } from './nav.js';
import { installMode, offlineView, pendingSummary, type OfflineView } from './pwa-state.js';
import { button, icon } from './widgets.js';

const PROD = import.meta.env.PROD;

/** Client build id stamped into index.html by tools/build.mjs (null on the dev server). */
export function clientBuild(): string | null {
  try {
    const id = document.querySelector<HTMLMetaElement>(`meta[name="${BUILD_META}"]`)?.content ?? '';
    return /^[a-f0-9]{16,64}$/.test(id) ? id : null;
  } catch { return null; }
}

/** Subscribe `render` to app events; returns the combined unsubscribe. */
function watch(app: App, types: AppEvent[], render: () => void): () => void {
  const offs = types.map(t => app.on(t, render));
  render();
  return () => { for (const off of offs) off(); };
}

export interface Widget<E extends HTMLElement = HTMLElement> { el: E; dispose(): void }

// ───────────────────────── offline readiness ─────────────────────────

function currentOffline(app: App): OfflineView | null {
  const s = app.pwaStatus;
  // app.online is polled as well: online/offline events are not always delivered
  return s ? offlineView({ ...s, online: app.online }, PROD) : null;
}

/**
 * Discreet status pill: '오프라인 준비 중 42%' → '오프라인 플레이 가능', or the error with 다시 시도.
 * `stopClicks` keeps taps on it from reaching a parent that reacts to any click (title screen).
 */
export function offlineChip(app: App, o: { stopClicks?: boolean; hideUnsupported?: boolean } = {}): Widget {
  const text = h('span', 'pwa-chip__text');
  const ico = h('span', 'pwa-chip__ico');
  const retry = h('button', 'pwa-chip__retry', '다시 시도');
  retry.type = 'button';
  const el = h('div', 'pwa-chip', ico, text, retry);
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  if (o.stopClicks) el.addEventListener('click', e => e.stopPropagation());
  retry.addEventListener('click', e => {
    e.stopPropagation();
    app.sound('select');
    void app.pwa?.retry();
  });
  let tone = '';
  const render = () => {
    const v = currentOffline(app);
    el.hidden = !v || (!!o.hideUnsupported && !app.pwaStatus?.supported);
    if (!v) return;
    if (tone !== v.tone) {
      tone = v.tone;
      el.dataset.tone = v.tone;
      ico.replaceChildren(v.tone === 'busy' ? h('i', 'pwa-chip__spin')
        : svg(v.tone === 'good' ? ICON.cloud : v.tone === 'bad' ? ICON.info : ICON.offline, 'ico'));
    }
    text.textContent = v.label;
    el.title = v.detail;
    retry.hidden = !v.retry;
  };
  return { el, dispose: watch(app, ['pwa', 'net'], render) };
}

/** Settings row: the long explanation + 다시 시도 (a nav stop). */
export function offlineDetail(app: App): Widget {
  const text = h('p', 'pwa-detail__text');
  const retry = button(app, { label: '다시 시도', icon: 'refresh', variant: 'secondary', cls: 'btn--sm', onClick: () => void app.pwa?.retry() });
  const chip = offlineChip(app);
  const el = h('div', 'pwa-detail', chip.el, text, retry);
  const render = () => {
    const v = currentOffline(app);
    el.hidden = !v;
    if (!v) return;
    text.textContent = v.detail;
    retry.hidden = !v.retry;
  };
  const off = watch(app, ['pwa', 'net'], render);
  return { el, dispose: () => { off(); chip.dispose(); } };
}

// ───────────────────────── install ─────────────────────────

/** '앱 설치' button, only while the app can be installed (browser prompt or iOS manual install). */
export function installButton(app: App, o: { cls?: string; stopClicks?: boolean } = {}): Widget<HTMLButtonElement> {
  const el = button(app, {
    label: '앱 설치', icon: 'install', variant: 'ghost', cls: `btn--sm pwa-install ${o.cls ?? ''}`,
    onClick: () => void runInstall(app),
  });
  if (o.stopClicks) el.addEventListener('click', e => e.stopPropagation());
  const render = () => {
    const s = app.pwaStatus;
    el.hidden = !s || installMode(s) === null;
  };
  return { el, dispose: watch(app, ['pwa'], render) };
}

export async function runInstall(app: App): Promise<void> {
  const pwa = app.pwa;
  const s = app.pwaStatus;
  if (!pwa || !s) return;
  const mode = installMode(s);
  if (mode === 'prompt') {
    let shown = false;
    try { shown = await pwa.install(); } catch { shown = false; }
    if (pwa.status.installed) {
      app.sound('unlock');
      app.notify('앱을 설치했어요! 홈 화면이나 앱 목록에서 바로 실행할 수 있어요.', 'good', 4200);
      return;
    }
    if (shown) return; // the player dismissed the browser prompt
    if (!pwa.status.iosManualInstall) {
      app.notify('이 브라우저에서는 지금 설치할 수 없어요. 브라우저 메뉴의 "앱 설치" 또는 "홈 화면에 추가"를 이용해 주세요.', 'info', 5200);
      return;
    }
  }
  if (mode === 'ios' || pwa.status.iosManualInstall) await showIosGuide(app);
}

/** iPhone / iPad Safari: installing is manual (Share → 홈 화면에 추가). */
export function showIosGuide(app: App): Promise<boolean> {
  const step = (n: number, ...content: Array<Node | string>) => h('li', 'ios-guide__step', h('b', 'ios-guide__num', String(n)), h('span', 'ios-guide__txt', ...content));
  const body = h('div', 'ios-guide',
    h('ol', 'ios-guide__steps',
      step(1, 'Safari 화면 아래(iPad는 위)의 ', svg(ICON.share, 'ico ios-guide__glyph'), h('strong', null, ' 공유 버튼'), '을 눌러요.'),
      step(2, '목록을 내려 ', svg(ICON.addSquare, 'ico ios-guide__glyph'), h('strong', null, " '홈 화면에 추가'"), '를 골라요.'),
      step(3, "오른쪽 위의 ", h('strong', null, "'추가'"), '를 누르면 끝!')),
    h('p', 'ios-guide__note', '홈 화면 아이콘으로 실행하면 전체 화면으로 즐길 수 있고, 한 번 연 뒤에는 오프라인에서도 플레이할 수 있어요.'));
  return app.modal<boolean>({
    title: '홈 화면에 추가하기', body, dismiss: false,
    buttons: [{ label: '알겠어요', value: true, icon: 'check' }],
  });
}

// ───────────────────────── update ─────────────────────────

/** '새 버전이 준비됐어요' + [업데이트]; hidden during races (and whenever no update waits). */
export function updateBanner(app: App): Widget {
  const sub = h('span', 'pwa-update__sub');
  const btn = button(app, { label: '업데이트', icon: 'refresh', variant: 'primary', cls: 'btn--sm', sound: null, onClick: () => void applyUpdate(app) });
  const el = h('div', 'pwa-update', svg(ICON.sparkle, 'ico pwa-update__ico'),
    h('div', 'pwa-update__text', h('strong', null, '새 버전이 준비됐어요'), sub), btn);
  el.setAttribute('role', 'status');
  el.addEventListener('click', e => e.stopPropagation());
  sub.textContent = '업데이트하면 잠깐 새로고침돼요.';
  // a refusal (another window racing, cache problem) is reported by applyUpdate() as a toast
  const render = () => { el.hidden = !app.updateAvailable; };
  return { el, dispose: watch(app, ['pwa', 'race'], render) };
}

let applying = false;

export async function applyUpdate(app: App): Promise<void> {
  const pwa = app.pwa;
  if (!pwa || applying) return;
  if (app.raceActive) {
    app.sound('error');
    app.notify('레이스를 마친 뒤 업데이트할 수 있어요.', 'info');
    return;
  }
  app.sound('select');
  if (!pwa.applyUpdate()) {
    app.sound('error');
    app.notify('레이스가 진행 중이에요. 레이스를 끝까지 마친 뒤 업데이트해 주세요.', 'info', 4200);
    return;
  }
  // The page reloads once the new worker takes over; stay responsive if it refuses or stalls.
  applying = true;
  const busy = app.busy('새 버전으로 바꾸는 중…');
  let timer = 0;
  const done = () => { applying = false; clearTimeout(timer); off(); busy.close(); };
  // The worker answers ACTIVATE_UPDATE with a refusal (UPDATE_BLOCKED / CACHE_ERROR → status.error)
  // or by taking over (controllerchange → reload); the first status change carrying an error is the refusal.
  const off = app.on('pwa', () => {
    const err = app.pwaStatus?.error;
    if (err) { done(); app.sound('error'); app.notify(err, 'bad', 5200); }
  });
  timer = window.setTimeout(() => {
    done();
    app.notify('업데이트가 늦어지고 있어요. 잠시 후 다시 시도해 주세요.', 'info', 4200);
  }, 20_000);
}

// ───────────────────────── waiting (offline) time-trial runs ─────────────────────────

export function pendingLabel(run: PendingRun): string {
  let track = run.request.trackId;
  try { track = getTrackMeta(run.request.trackId).name; } catch { /* unknown track id */ }
  return `${track} · ${run.request.cc}cc · ${formatTicks(run.request.ticks)}`;
}

/**
 * Notice card for runs recorded offline: 등록 / 삭제 when online, a reassurance while offline,
 * plus a one-time explanation when an update made older runs unsubmittable.
 */
export function pendingNotice(app: App, nav?: Nav | null, o: { dropped?: boolean } = {}): Widget {
  const el = h('div', 'pwa-notices');
  const render = () => {
    // Re-rendering replaces the buttons: keep keyboard / gamepad focus on the same action.
    const focused = nav?.focused && el.contains(nav.focused) ? nav.focused : null;
    const focusedLabel = focused?.querySelector('.btn__label')?.textContent ?? null;
    const runs = app.storage.pendingRuns();
    const summary = pendingSummary(runs.length, app.online);
    const cards: HTMLElement[] = [];
    if (app.droppedPending.length && o.dropped !== false) {
      const n = app.droppedPending.length;
      const from = [...new Set(app.droppedPending.map(r => `v${r.appVersion}`))].join(', ');
      const ok = button(app, {
        label: '확인', icon: 'check', variant: 'secondary', cls: 'btn--sm',
        onClick: () => { app.droppedPending = []; app.pendingChanged(); },
      });
      cards.push(h('div', 'pwa-notice pwa-notice--info',
        h('div', 'pwa-notice__head', icon('info', 'ico pwa-notice__ico'), h('strong', null, `이전 버전 기록 ${n}개를 정리했어요`)),
        h('p', 'pwa-notice__text', `${from}에서 보관한 타임 어택 기록은 게임이 업데이트되어 서버가 검증할 수 없어요. 새 버전에서 다시 달려 주세요!`),
        h('div', 'pwa-notice__actions', ok)));
    }
    if (summary) {
      const submit = button(app, {
        label: '등록', icon: 'upload', variant: 'primary', cls: 'btn--sm', sound: null,
        locked: () => (app.online ? null : '아직 오프라인이에요. 온라인이 되면 등록할 수 있어요.'),
        onClick: () => void submitPendingRuns(app),
      });
      const remove = button(app, { label: '삭제', icon: 'trash', variant: 'ghost', cls: 'btn--sm', onClick: () => void deletePendingRuns(app) });
      cards.push(h('div', `pwa-notice ${summary.canSubmit ? 'pwa-notice--ready' : 'pwa-notice--offline'}`,
        h('div', 'pwa-notice__head', icon(summary.canSubmit ? 'upload' : 'offline', 'ico pwa-notice__ico'), h('strong', null, '등록 대기 기록')),
        h('p', 'pwa-notice__text', summary.text),
        h('ul', 'pwa-notice__list', ...runs.slice(0, 3).map(r => h('li', null, pendingLabel(r))),
          runs.length > 3 ? h('li', 'pwa-notice__more', `외 ${runs.length - 3}개`) : null),
        h('div', 'pwa-notice__actions', summary.canSubmit ? submit : null, remove)));
    }
    el.replaceChildren(...cards);
    el.hidden = cards.length === 0;
    if (focused && nav) {
      const again = Array.from(el.querySelectorAll<HTMLElement>('.btn')).find(b => b.querySelector('.btn__label')?.textContent === focusedLabel);
      if (again) nav.focus(again, { sound: false, scroll: false });
      else nav.focusFirst();
    }
  };
  return { el, dispose: watch(app, ['pending', 'net'], render) };
}

async function deletePendingRuns(app: App): Promise<void> {
  const n = app.storage.pendingRuns().length;
  if (!n) return;
  const ok = await app.confirm({
    title: '대기 기록을 삭제할까요?', message: `등록하지 않은 타임 어택 기록 ${n}개가 사라져요. 내 최고 기록(고스트)은 그대로 남아요.`,
    yes: '삭제', no: '취소', danger: true,
  });
  if (!ok) return;
  app.storage.clearPendingRuns();
  app.pendingChanged();
  app.notify('대기 기록을 삭제했어요.', 'info');
}

let submitting = false;

/** Submit every waiting run (oldest first); stops at the first connectivity failure. */
export async function submitPendingRuns(app: App): Promise<void> {
  if (submitting) return;
  const runs = app.storage.pendingRuns();
  if (!runs.length) return;
  if (!app.online) {
    app.sound('error');
    app.notify('아직 오프라인이에요. 온라인이 되면 등록할 수 있어요.', 'info');
    return;
  }
  const fallback = validatePlayerName(app.settings.playerName);
  const nameFor = (r: PendingRun): string | null => {
    const own = validatePlayerName(r.request.name);
    if (own.ok) return own.name;
    return fallback.ok ? fallback.name : null;
  };
  if (runs.some(r => nameFor(r) === null)) {
    app.sound('error');
    await app.modal({
      title: '닉네임이 필요해요', message: '설정 → 프로필에서 랭킹에 표시될 닉네임(1~12자)을 정한 뒤 다시 등록해 주세요.',
      tone: 'info', dismiss: true, buttons: [{ label: '확인', value: true, icon: 'check' }],
    });
    return;
  }
  submitting = true;
  app.sound('select');
  const busy = app.busy(`기록을 검증하고 등록하는 중… (0/${runs.length})`);
  const lines: Array<{ run: PendingRun; ok: boolean; text: string }> = [];
  let stopped: string | null = null;
  try {
    for (const [i, run] of runs.entries()) {
      busy.setText(`기록을 검증하고 등록하는 중… (${i + 1}/${runs.length})`);
      try {
        const res = await submitRun({ ...run.request, lapTicks: [...run.request.lapTicks], name: nameFor(run)! });
        app.storage.removePendingRun(run.id);
        if (!res.accepted) lines.push({ run, ok: false, text: describeRejection(res.reason) });
        else if (!res.personalBest) lines.push({ run, ok: true, text: '이전 등록 기록이 더 빨라요' });
        else lines.push({ run, ok: true, text: res.rank !== null ? `세계 ${res.rank}위!` : '등록 완료' });
      } catch (err) {
        if (isConnectivityError(err) || (err instanceof ApiRequestError && (err.kind === 'rate-limited' || err.kind === 'server'))) {
          stopped = errorMessage(err);
          break; // keep this and the remaining runs for later
        }
        // the server looked at the run and refused it (4xx): it will never be accepted
        app.storage.removePendingRun(run.id);
        lines.push({ run, ok: false, text: errorMessage(err) });
      }
    }
  } finally {
    submitting = false;
    busy.close();
    app.pendingChanged();
  }
  const accepted = lines.filter(l => l.ok).length;
  app.sound(accepted > 0 ? 'unlock' : 'error');
  const list = h('ul', 'pending-result',
    ...lines.map(l => h('li', `pending-result__row ${l.ok ? 'is-ok' : 'is-bad'}`,
      svg(l.ok ? ICON.check : ICON.info, 'ico'), h('span', 'pending-result__run', pendingLabel(l.run)), h('b', 'pending-result__msg', l.text))));
  const left = app.storage.pendingRuns().length;
  const body = h('div', 'pending-result__wrap', lines.length ? list : null,
    stopped ? h('p', 'pending-result__note', `${stopped} 남은 기록 ${left}개는 보관해 둘게요.`) : null);
  await app.modal({
    title: accepted > 0 ? `기록 ${accepted}개를 등록했어요!` : lines.length ? '등록하지 못했어요' : '아직 등록하지 못했어요',
    body, tone: accepted > 0 ? 'good' : 'info', dismiss: true,
    buttons: [{ label: '확인', value: true, icon: 'check' }],
  });
}
