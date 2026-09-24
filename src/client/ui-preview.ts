/**
 * UI preview entry: the full app shell running on a mock GameView + mock audio.
 * Query params: ?speed=N (fake race time scale), ?mockapi (offline /api shim).
 */
import { createInputManager } from './input/index.js';
import { startApp } from './ui/app.js';
import { installMockApi } from './ui/mock-api.js';
import { createMockAudio } from './ui/mock-audio.js';
import { createMockGameView } from './ui/mock-view.js';

const params = new URLSearchParams(location.search);
if (params.has('mockapi')) installMockApi();

const viewEl = document.getElementById('view');
const uiEl = document.getElementById('ui');
if (!viewEl || !uiEl) throw new Error('preview markup missing #view / #ui');

const input = createInputManager();
const audio = createMockAudio();
const view = createMockGameView({ input, speed: Number(params.get('speed') ?? '1') || 1 });
view.mount(viewEl);
startApp({ root: uiEl, view, audio, input });

(window as unknown as { __preview: unknown }).__preview = { view, audio, input };
