/**
 * Pure service-worker policy (unit tested; bundled into sw.js).
 *  - API/health and anything cross-origin or non-GET: straight to the network.
 *  - Navigations: the worker's own cached app shell once its cache is complete (network until then),
 *    so a page always matches the worker that serves it; updates wait in the next worker.
 *  - Hashed assets, icons and the manifest: cache first.
 */
export const CACHE_PREFIX = 'turbo-pals-';
export const BUILD_META = 'turbo-pals-build';

const STATIC_FILES = new Set(['/manifest.webmanifest', '/favicon.svg', '/icon-maskable.svg', '/build.json']);

export function cacheRoute(url: string, origin: string, method: string, mode: string): 'network' | 'navigation' | 'asset' {
  const parsed = new URL(url);
  if (method !== 'GET' || parsed.origin !== origin) return 'network';
  if (parsed.pathname === '/api' || parsed.pathname.startsWith('/api/') || parsed.pathname === '/healthz' || parsed.pathname === '/sw.js') return 'network';
  if (mode === 'navigate') return 'navigation';
  if (parsed.pathname.startsWith('/assets/') || parsed.pathname.startsWith('/icons/') || STATIC_FILES.has(parsed.pathname)) return 'asset';
  return 'network';
}

/** The cached index.html must carry exactly one build meta tag equal to build.json's id. */
export function shellMatchesBuild(html: string, metadata: unknown, build: string): boolean {
  if (!/^[a-f0-9]{16,64}$/.test(build) || !metadata || typeof metadata !== 'object'
    || Array.isArray(metadata) || (metadata as { id?: unknown }).id !== build) return false;
  const ids: Array<string | undefined> = [];
  for (const tag of html.replace(/<!--[\s\S]*?-->/g, '').match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = new Map([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)]
      .map(m => [m[1]!.toLowerCase(), m[3]!]));
    if (attributes.get('name') === BUILD_META) ids.push(attributes.get('content'));
  }
  return ids.length === 1 && ids[0] === build;
}

/**
 * Where to look for the "last good" cache on activation, best first: the cache the previously active
 * worker served (pages still open on that version need its files), then the other versions, newest first.
 * A version that only ever waited and was replaced by a newer one served nobody, so it never outranks it.
 */
export function lastGoodCandidates(names: string[], current: string, served?: string | null): string[] {
  const newestFirst = names.filter(name => name !== current && name.startsWith(CACHE_PREFIX) && /-[a-f0-9]{16,64}$/.test(name)).reverse();
  return served && newestFirst.includes(served) ? [served, ...newestFirst.filter(name => name !== served)] : newestFirst;
}

/** Caches to delete on activation: every old TURBO PALS cache except the current and the last good one. */
export function obsoleteCaches(names: string[], current: string, lastGood?: string | null): string[] {
  const owned = names.filter(name => name.startsWith(CACHE_PREFIX));
  const previous = lastGood === undefined ? owned.filter(name => name !== current).at(-1) : lastGood;
  return owned.filter(name => name !== current && name !== previous);
}
