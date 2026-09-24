import { describe, expect, it } from 'vitest';
import { cacheRoute, lastGoodCandidates, obsoleteCaches, shellMatchesBuild } from '../../src/client/sw-policy.js';

const O = 'https://d374w2735k9eto.cloudfront.net';

describe('service worker routing', () => {
  it('never caches the API, health checks, the worker script or other origins', () => {
    expect(cacheRoute(`${O}/api/leaderboard?track=x&cc=150`, O, 'GET', 'cors')).toBe('network');
    expect(cacheRoute(`${O}/api/runs`, O, 'POST', 'cors')).toBe('network');
    expect(cacheRoute(`${O}/api`, O, 'GET', 'cors')).toBe('network');
    expect(cacheRoute(`${O}/healthz`, O, 'GET', 'cors')).toBe('network');
    expect(cacheRoute(`${O}/sw.js`, O, 'GET', 'same-origin')).toBe('network');
    expect(cacheRoute('https://example.com/assets/x.js', O, 'GET', 'cors')).toBe('network');
  });
  it('routes navigations to the app-shell handler and static files cache-first', () => {
    expect(cacheRoute(`${O}/`, O, 'GET', 'navigate')).toBe('navigation');
    expect(cacheRoute(`${O}/time-trial`, O, 'GET', 'navigate')).toBe('navigation');
    expect(cacheRoute(`${O}/assets/index-abc.js`, O, 'GET', 'no-cors')).toBe('asset');
    expect(cacheRoute(`${O}/icons/icon-192.png`, O, 'GET', 'no-cors')).toBe('asset');
    expect(cacheRoute(`${O}/manifest.webmanifest`, O, 'GET', 'cors')).toBe('asset');
    expect(cacheRoute(`${O}/build.json`, O, 'GET', 'cors')).toBe('asset');
    expect(cacheRoute(`${O}/unknown.txt`, O, 'GET', 'no-cors')).toBe('network');
  });
});

describe('shell/build consistency', () => {
  const build = '4bc74e2772d73763';
  const html = `<html><head><meta charset="utf-8" /><meta name="turbo-pals-build" content="${build}" /></head></html>`;
  it('accepts a shell whose single build tag matches build.json', () => {
    expect(shellMatchesBuild(html, { id: build, version: '1.0.0' }, build)).toBe(true);
  });
  it('rejects mismatches, duplicates, commented tags and bad ids', () => {
    expect(shellMatchesBuild(html, { id: 'ffffffffffffffff' }, build)).toBe(false);
    expect(shellMatchesBuild(html.replace('</head>', `<meta name="turbo-pals-build" content="${build}" /></head>`), { id: build }, build)).toBe(false);
    expect(shellMatchesBuild(`<!-- <meta name="turbo-pals-build" content="${build}" /> -->`, { id: build }, build)).toBe(false);
    expect(shellMatchesBuild(html, null, build)).toBe(false);
    expect(shellMatchesBuild(html, { id: 'nope' }, 'nope')).toBe(false);
  });
});

describe('last good cache', () => {
  const a = 'turbo-pals-1.0.0-aaaaaaaaaaaaaaaa', b = 'turbo-pals-1.0.0-bbbbbbbbbbbbbbbb', c = 'turbo-pals-1.0.1-cccccccccccccccc';
  it('prefers the cache the previous worker served over a newer one that only ever waited', () => {
    // A served pages, B installed and waited, C replaced B and now activates: keep A, drop B
    expect(lastGoodCandidates(['other-app', a, b, c, 'turbo-pals.sw-state'], c, a)).toEqual([a, b]);
    expect(obsoleteCaches([a, b, c], c, lastGoodCandidates([a, b, c], c, a)[0])).toEqual([b]);
  });
  it('falls back to newest first without (or with a stale) record, never offers the current or foreign caches', () => {
    expect(lastGoodCandidates([a, b, c], c)).toEqual([b, a]);
    expect(lastGoodCandidates([a, b, c], c, 'turbo-pals-1.0.0-dddddddddddddddd')).toEqual([b, a]);
    expect(lastGoodCandidates([a, c], c, c)).toEqual([a]);
    expect(lastGoodCandidates(['turbo-pals.sw-state', 'turbo-pals-junk', c], c, null)).toEqual([]);
  });
});

describe('cache cleanup', () => {
  it('keeps the current and the last good cache, never touches foreign caches', () => {
    const names = ['other-app', 'turbo-pals-1.0.0-aaaaaaaaaaaaaaaa', 'turbo-pals-1.0.0-bbbbbbbbbbbbbbbb', 'turbo-pals-1.0.1-cccccccccccccccc'];
    expect(obsoleteCaches(names, 'turbo-pals-1.0.1-cccccccccccccccc')).toEqual(['turbo-pals-1.0.0-aaaaaaaaaaaaaaaa']);
    expect(obsoleteCaches(names, 'turbo-pals-1.0.1-cccccccccccccccc', 'turbo-pals-1.0.0-aaaaaaaaaaaaaaaa')).toEqual(['turbo-pals-1.0.0-bbbbbbbbbbbbbbbb']);
    expect(obsoleteCaches(names, 'turbo-pals-1.0.1-cccccccccccccccc', null)).toEqual(['turbo-pals-1.0.0-aaaaaaaaaaaaaaaa', 'turbo-pals-1.0.0-bbbbbbbbbbbbbbbb']);
  });
});
