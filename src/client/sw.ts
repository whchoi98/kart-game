/// <reference lib="webworker" />
/**
 * TURBO PALS service worker (bundled by tools/build.mjs into dist/client/sw.js).
 * Precaches the whole client (the game has no external assets), serves it as an
 * offline-first app shell, and never swaps versions under a player who is mid-race.
 */
import { CACHE_PREFIX, cacheRoute, lastGoodCandidates, obsoleteCaches, shellMatchesBuild } from './sw-policy.js';

declare const __PRECACHE__: string[];
declare const __BUILD__: string;
declare const __VERSION__: string;

const worker = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `${CACHE_PREFIX}${__VERSION__}-${__BUILD__}`;
const COMPLETE = '/__turbo_pals_offline_complete__';
/** Worker bookkeeping (outside CACHE_PREFIX, so cleanup never touches it): which cache is being served. */
const STATE = 'turbo-pals.sw-state';
const ACTIVE = '/active-cache';
const QUERY_TIMEOUT_MS = 2000;
/** In-flight idle checks; an unsolicited "in race" status vetoes them. */
const activationChecks = new Set<{ busy: boolean }>();

async function notify(message: Record<string, unknown>): Promise<void> {
  for (const client of await worker.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
    try { client.postMessage({ ...message, build: __BUILD__, version: __VERSION__ }); } catch { /* client closed */ }
  }
}

async function matchingShell(cache: Cache, build: string): Promise<boolean> {
  const [index, metadata] = await Promise.all([cache.match('/index.html'), cache.match('/build.json')]);
  if (!index?.ok || !metadata?.ok) return false;
  let data: unknown;
  try { data = await metadata.json(); } catch { return false; }
  return shellMatchesBuild(await index.text(), data, build);
}

async function completeCache(cache: Cache, build: string, paths: readonly string[]): Promise<boolean> {
  const marker = await cache.match(COMPLETE);
  if (!marker?.ok || await marker.text() !== build || !await matchingShell(cache, build)) return false;
  for (const path of paths) {
    const response = await cache.match(path);
    if (!response?.ok || response.type === 'opaque') return false;
  }
  return true;
}

async function completeByName(name: string): Promise<boolean> {
  const build = name.match(/-([a-f0-9]{16,64})$/)?.[1];
  return !!build && await completeCache(await caches.open(name), build, []);
}

async function lastGoodCache(names: string[]): Promise<string | null> {
  const served = await (await (await caches.open(STATE)).match(ACTIVE))?.text();
  for (const name of lastGoodCandidates(names, CACHE, served)) if (await completeByName(name)) return name;
  return null;
}

function queryIdle(client: Client): Promise<boolean> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    let finished = false;
    const finish = (idle: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      channel.port1.close(); channel.port2.close();
      resolve(idle);
    };
    const timer = setTimeout(() => finish(false), QUERY_TIMEOUT_MS);
    channel.port1.onmessage = event => finish(event.data?.type === 'RACE_STATUS' && event.data.inRace === false);
    channel.port1.onmessageerror = () => finish(false);
    try {
      client.postMessage({ type: 'QUERY_RACE_STATUS', build: __BUILD__, version: __VERSION__ }, [channel.port2]);
    } catch { finish(false); }
  });
}

async function clientsIdle(): Promise<boolean> {
  const check = { busy: false };
  activationChecks.add(check);
  try {
    const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const idle = await Promise.all(clients.map(queryIdle));
    if (check.busy || !idle.every(Boolean)) return false;
    const queried = new Set(clients.map(c => c.id));
    const current = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
    return !check.busy && current.every(c => queried.has(c.id));
  } finally { activationChecks.delete(check); }
}

worker.addEventListener('install', event => {
  event.waitUntil((async () => {
    let incomplete = false;
    let completed = 0;
    try {
      const cache = await caches.open(CACHE);
      if (await completeCache(cache, __BUILD__, __PRECACHE__)) {
        await notify({ type: 'CACHE_READY', completed: __PRECACHE__.length, total: __PRECACHE__.length });
        return;
      }
      incomplete = true;
      await cache.delete(COMPLETE);
      // a few downloads in flight at once: much faster first-visit readiness, still gentle on the origin
      let next = 0;
      const fetchOne = async (): Promise<void> => {
        while (next < __PRECACHE__.length) {
          const url = __PRECACHE__[next++]!;
          const response = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
          if (!response.ok || response.type === 'opaque') throw new Error('OFFLINE_ASSET_UNAVAILABLE');
          await cache.put(url, response);
          completed++;
          if (completed % 8 === 0 || completed === __PRECACHE__.length) {
            await notify({ type: 'CACHE_PROGRESS', completed, total: __PRECACHE__.length });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, __PRECACHE__.length) }, fetchOne));
      if (!await matchingShell(cache, __BUILD__)) throw new Error('OFFLINE_BUILD_MISMATCH');
      await cache.put(COMPLETE, new Response(__BUILD__));
      incomplete = false;
      await notify({ type: 'CACHE_READY', completed, total: __PRECACHE__.length });
    } catch {
      if (incomplete) await caches.delete(CACHE);
      await notify({ type: 'CACHE_ERROR' });
      throw new Error('OFFLINE_INSTALL_FAILED');
    }
  })());
});

worker.addEventListener('activate', event => {
  event.waitUntil((async () => {
    if (!await completeCache(await caches.open(CACHE), __BUILD__, __PRECACHE__)) throw new Error('INCOMPLETE_OFFLINE_CACHE');
    const names = await caches.keys();
    const previous = await lastGoodCache(names);
    for (const name of obsoleteCaches(names, CACHE, previous)) await caches.delete(name);
    await (await caches.open(STATE)).put(ACTIVE, new Response(CACHE));
    await worker.clients.claim();
    await notify({ type: 'CACHE_READY' });
  })());
});

worker.addEventListener('message', event => {
  const source = event.source as Client | null;
  const data = event.data;
  // Unsolicited status may veto, but never authorise, an activation.
  if (data?.type === 'CLIENT_STATUS' && source?.id && data.inRace !== false) {
    for (const check of activationChecks) check.busy = true;
  }
  if (data?.type === 'GET_CACHE_STATUS') {
    event.waitUntil((async () => {
      const ready = await completeCache(await caches.open(CACHE), __BUILD__, __PRECACHE__);
      source?.postMessage({ type: ready ? 'CACHE_READY' : 'CACHE_PENDING', build: __BUILD__, version: __VERSION__ });
    })());
  }
  if (data?.type === 'ACTIVATE_UPDATE') {
    event.waitUntil((async () => {
      if (!await completeCache(await caches.open(CACHE), __BUILD__, __PRECACHE__)) {
        source?.postMessage({ type: 'CACHE_ERROR', build: __BUILD__, version: __VERSION__ });
        return;
      }
      if (!await clientsIdle()) {
        source?.postMessage({ type: 'UPDATE_BLOCKED', build: __BUILD__, version: __VERSION__ });
        return;
      }
      await worker.skipWaiting();
    })());
  }
});

worker.addEventListener('fetch', event => {
  const route = cacheRoute(event.request.url, worker.location.origin, event.request.method, event.request.mode);
  if (route === 'network') return;
  if (route === 'navigation') {
    event.respondWith((async () => {
      // App shell: once this version is completely cached, every navigation is served from it, so the
      // page always matches its worker (never a new page under an old worker, no wait on a flaky link).
      // A newer version installs as the waiting worker and is applied from the in-app banner between races.
      const cache = await caches.open(CACHE);
      const shell = await cache.match('/index.html');
      const marker = await cache.match(COMPLETE);
      if (shell?.ok && marker?.ok && await marker.text() === __BUILD__) return shell;
      try {
        const response = await fetch(event.request);
        if (response.ok) return response;
        return shell ?? (await caches.match('/index.html')) ?? response;
      } catch {
        return shell ?? (await caches.match('/index.html'))
          ?? new Response('오프라인 파일이 아직 준비되지 않았어요. 인터넷에 연결한 뒤 다시 실행해 주세요.', {
            status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const current = await (await caches.open(CACHE)).match(event.request, { ignoreSearch: true });
    if (current) return current;
    // an already-running older page can keep using its own hashed assets
    return (await caches.match(event.request)) ?? fetch(event.request);
  })());
});
