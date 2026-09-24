import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/server/config.js';
import { clientKey, isJsonContentType, isOriginAllowed, normalizeAddress } from '../../src/server/security.js';
import { isRunId, logDigest, newRunId, normalizeName } from '../../src/server/validation.js';
import { InputRecorder } from '../../src/sim/input-log.js';

const request = (headers: Record<string, string>, ip = '10.100.0.5') => ({ headers, ip } as unknown as FastifyRequest);

describe('normalizeName', () => {
  it('normalises to NFC, collapses whitespace and trims', () => {
    expect(normalizeName('  터보   팔즈 ')).toBe('터보 팔즈');
    expect(normalizeName('한'.normalize('NFD'))).toBe('한');
    expect(normalizeName('Kart\tRacer\n')).toBe('Kart Racer');
    expect(normalizeName('ㅋㅋ_pro-7')).toBe('ㅋㅋ_pro-7');
  });

  it('counts characters, not UTF-16 units or bytes', () => {
    expect(normalizeName('가'.repeat(12))).toBe('가'.repeat(12));
    expect(normalizeName('가'.repeat(13))).toBeUndefined();
    expect(normalizeName('a'.repeat(12))).toBe('a'.repeat(12));
  });

  it('rejects symbols, emoji, invisible characters and names without a letter or digit', () => {
    // U+3164 HANGUL FILLER renders blank (alone or as padding it would hide who holds a rank).
    for (const bad of ['', ' ', '<b>', 'a.b', '😀', 'a​b', 'é', '---', '_ _', 'Ｆｕｌｌ', 'Łukasz', '\u3164', '\u3164\u3164', 'Pro\u3164', '\u318d']) {
      expect(normalizeName(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('run ids and digests', () => {
  it('are time-ordered and match the public pattern', () => {
    const a = newRunId(Date.UTC(2026, 0, 1));
    const b = newRunId(Date.UTC(2026, 0, 1, 0, 0, 1));
    expect(isRunId(a) && isRunId(b)).toBe(true);
    expect(a < b).toBe(true);
    expect(newRunId()).not.toBe(newRunId());
    expect(isRunId('../../etc/passwd')).toBe(false);
  });

  it('digests logs deterministically', () => {
    expect(logDigest('AQA=')).toBe(logDigest('AQA='));
    expect(logDigest('AQA=')).not.toBe(logDigest('AQB='));
  });

  it('digests the encoded input sequence, not its spelling', () => {
    const recorder = new InputRecorder();
    for (let i = 0; i < 400; i++) {
      recorder.push({ throttle: i > 150, brake: false, steer: i % 90 < 45 ? 0 : -1, drift: i % 200 > 180, item: i === 300, back: false });
    }
    const log = recorder.encode();
    const bytes = Buffer.from(log, 'base64');
    // Split the first run into two runs of the same word: same ticks, different text.
    const count = bytes.readUInt16LE(4);
    expect(count).toBeGreaterThan(1);
    const split = Buffer.concat([bytes.subarray(0, 4), Buffer.from([0, 0, 0, 0]), bytes.subarray(4)]);
    split.writeUInt16LE(1, 4);
    split.writeUInt16LE(bytes.readUInt16LE(2), 6);
    split.writeUInt16LE(count - 1, 8);
    const respelled = split.toString('base64');
    expect(respelled).not.toBe(log);
    expect(logDigest(respelled)).toBe(logDigest(log));
    // Steer value 127 decodes exactly like full lock (126).
    const fullLock = Buffer.from(bytes);
    const lastWord = fullLock.length - 4;
    fullLock.writeUInt16LE((fullLock.readUInt16LE(lastWord) & ~0x7f) | 126, lastWord);
    const overLock = Buffer.from(fullLock);
    overLock.writeUInt16LE((overLock.readUInt16LE(lastWord) & ~0x7f) | 127, lastWord);
    expect(logDigest(overLock.toString('base64'))).toBe(logDigest(fullLock.toString('base64')));
    // A genuinely different input sequence digests differently.
    const other = new InputRecorder();
    for (let i = 0; i < 400; i++) other.push({ throttle: i > 151, brake: false, steer: 0, drift: false, item: false, back: false });
    expect(logDigest(other.encode())).not.toBe(logDigest(log));
  });
});

describe('client keys', () => {
  it('uses a valid edge-supplied viewer IP, else the socket address', () => {
    expect(clientKey(request({ 'x-turbo-client-ip': '203.0.113.5' }))).toBe('203.0.113.5');
    expect(clientKey(request({ 'x-turbo-client-ip': 'evil' }))).toBe('10.100.0.5');
    expect(clientKey(request({}))).toBe('10.100.0.5');
  });

  it('groups IPv6 viewers by /64 and unwraps IPv4-mapped addresses', () => {
    expect(normalizeAddress('2001:db8:abcd:12::1')).toBe('2001:db8:abcd:12::/64');
    expect(normalizeAddress('2001:DB8:ABCD:0012:ffff:ffff:ffff:ffff')).toBe('2001:db8:abcd:12::/64');
    expect(normalizeAddress('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeAddress('::1')).toBe('0:0:0:0::/64');
  });
});

describe('origin and content-type checks', () => {
  const allowed = ['https://d111111abcdef8.cloudfront.net'];
  it('accepts missing or configured origins only', () => {
    expect(isOriginAllowed(request({}), allowed)).toBe(true);
    expect(isOriginAllowed(request({ origin: allowed[0]! }), allowed)).toBe(true);
    expect(isOriginAllowed(request({ origin: 'https://d111111abcdef8.cloudfront.net.evil.test' }), allowed)).toBe(false);
    expect(isOriginAllowed(request({ origin: 'null' }), allowed)).toBe(false);
  });

  it('falls back to same-host origins when nothing is configured', () => {
    expect(isOriginAllowed(request({ origin: 'http://localhost:8200', host: 'localhost:8200' }), [])).toBe(true);
    expect(isOriginAllowed(request({ origin: 'http://localhost:8200', host: 'localhost:8201' }), [])).toBe(false);
  });

  it('accepts only JSON bodies', () => {
    expect(isJsonContentType(request({ 'content-type': 'application/json' }))).toBe(true);
    expect(isJsonContentType(request({ 'content-type': 'application/json; charset=UTF-8' }))).toBe(true);
    expect(isJsonContentType(request({ 'content-type': 'text/plain' }))).toBe(false);
    expect(isJsonContentType(request({ 'content-type': 'application/json; charset=latin1' }))).toBe(false);
  });
});

describe('readConfig', () => {
  it('applies container defaults in production', () => {
    const config = readConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://d1.cloudfront.net', TABLE_NAME: 'TurboPals-Table' });
    expect(config).toMatchObject({
      production: true, host: '0.0.0.0', port: 8080, tableName: 'TurboPals-Table',
      allowedOrigins: ['https://d1.cloudfront.net'],
    });
    expect(config.staticDir).toMatch(/dist\/client$/);
  });

  it('merges and de-duplicates PUBLIC_ORIGIN and ALLOWED_ORIGINS', () => {
    const config = readConfig({ PUBLIC_ORIGIN: 'https://a.test', ALLOWED_ORIGINS: 'https://a.test, http://localhost:8200' });
    expect(config.allowedOrigins).toEqual(['https://a.test', 'http://localhost:8200']);
    expect(config.tableName).toBeUndefined();
    expect(config.host).toBe('127.0.0.1');
  });

  it('rejects invalid ports, hosts, origins and versions', () => {
    expect(() => readConfig({ PORT: '99999' })).toThrow(/PORT/);
    expect(() => readConfig({ HOST: 'example.com' })).toThrow(/HOST/);
    expect(() => readConfig({ PUBLIC_ORIGIN: 'https://a.test/path' })).toThrow(/origin/i);
    expect(() => readConfig({ APP_VERSION: 'v 1' })).toThrow(/APP_VERSION/);
    expect(() => readConfig({ TABLE_NAME: 'x' })).toThrow(/TABLE_NAME/);
  });
});
