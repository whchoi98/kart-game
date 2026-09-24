/**
 * Production entry: 3D GameView + procedural audio + input, then the app shell and the
 * Progressive Web App manager (offline cache, install, updates between races).
 * QA builds only (__DEBUG_HOOK__): `?debug` exposes window.__turbo for tools/qa-screens.ts.
 */
import { createAudioSystem } from './audio/index.js';
import type { GhostData, QualityLevel } from './contracts.js';
import { createGameView } from './game/index.js';
import { createInputManager } from './input/index.js';
import { PwaManager } from './pwa.js';
import { currentApp, startApp, type App } from './ui/app.js';
import { runDebugRace } from './ui/flows.js';
import type { RaceConfig } from '../sim/types.js';

function fatal(root: HTMLElement, title: string, message: string): void {
  root.replaceChildren();
  const box = document.createElement('div');
  box.className = 'fatal';
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = message;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '새로고침';
  btn.addEventListener('click', () => location.reload());
  box.append(h, p, btn);
  root.append(box);
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    // Give the probe context back right away: browsers cap live WebGL contexts, and the
    // renderer is about to create the real one.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** QA-only hook (compiled out of release builds). */
function installDebugHook(app: App, view: ReturnType<typeof createGameView>): void {
  const params = new URLSearchParams(location.search);
  if (!params.has('debug')) return;
  const q = params.get('quality') as QualityLevel | null;
  const hook = {
    view,
    /** The app shell (settings, storage, pwa status) for QA scripts. */
    get app(): App | null { return currentApp(); },
    get ready(): boolean { return !!currentApp()?.ready; },
    startRace(config: RaceConfig, opts: { autopilotHuman?: boolean; ghost?: GhostData | null } = {}) {
      const current = currentApp();
      if (!current) return Promise.resolve(false);
      view.debugSetBots(!!opts.autopilotHuman);
      return runDebugRace(current, config, opts.ghost ?? null);
    },
    state: () => view.debugState(),
  };
  // ?quality= applies to this page's renderer only; the player's saved settings stay untouched.
  if (q === 'auto' || q === 'low' || q === 'medium' || q === 'high') app.setViewOverride({ quality: q });
  (window as unknown as { __turbo: typeof hook }).__turbo = hook;
}

function boot(): void {
  const viewEl = document.getElementById('view');
  const uiEl = document.getElementById('ui');
  if (!viewEl || !uiEl) return;

  // Created first so an early `beforeinstallprompt` is never missed.
  const pwa = new PwaManager(__APP_VERSION__);

  if (!webglAvailable()) {
    fatal(uiEl, '3D 그래픽을 사용할 수 없어요',
      '이 브라우저나 기기에서 WebGL이 꺼져 있거나 지원되지 않아요. 최신 Chrome, Edge, Safari, Firefox에서 하드웨어 가속을 켠 뒤 다시 시도해 주세요.');
    return;
  }

  const input = createInputManager();
  // Settings → 진동: gate every vibration request on the player's choice.
  const rawRumble = input.rumble.bind(input);
  input.rumble = (player, strength, ms) => {
    if (currentApp()?.settings.rumble === false) return;
    rawRumble(player, strength, ms);
  };
  const audio = createAudioSystem();
  let view: ReturnType<typeof createGameView>;
  try {
    view = createGameView({ audio, input });
    view.mount(viewEl);
  } catch (err) {
    console.error('[main] failed to start the renderer', err);
    fatal(uiEl, '게임을 시작하지 못했어요', '그래픽 초기화 중 문제가 생겼어요. 페이지를 새로고침하거나 다른 브라우저로 접속해 주세요.');
    return;
  }

  const app = startApp({ root: uiEl, view, audio, input, pwa });
  // A race is in progress from startRace until the player leaves the results screen; the
  // service worker asks (QUERY_RACE_STATUS) before swapping versions and gets a live answer.
  pwa.getInRace = () => view.inRace || app.raceActive;
  pwa.beforeReload = () => app.persistForReload();
  // Register the worker once the title screen is up (it then precaches in the background).
  void app.whenReady.then(() => pwa.start());

  if (__DEBUG_HOOK__) installDebugHook(app, view);
}

boot();
