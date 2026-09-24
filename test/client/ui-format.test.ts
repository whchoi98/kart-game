import { describe, expect, it } from 'vitest';
import {
  formatDate, formatDelta, formatMs, formatTicks, normalizePlayerName, positionLabel, positionTone,
  ticksToMs, validatePlayerName,
} from '../../src/client/ui/format.js';

describe('time formatting', () => {
  it('converts 60 Hz ticks to milliseconds', () => {
    expect(ticksToMs(60)).toBe(1000);
    expect(ticksToMs(1)).toBe(17);
    expect(ticksToMs(100)).toBe(1667);
    expect(ticksToMs(0)).toBe(0);
  });

  it('formats mm:ss.mmm', () => {
    expect(formatMs(0)).toBe('00:00.000');
    expect(formatMs(83456)).toBe('01:23.456');
    expect(formatMs(59999.6)).toBe('01:00.000');
    expect(formatMs(600000 * 2 + 5)).toBe('20:00.005');
    expect(formatTicks(60 * 83 + 30)).toBe('01:23.500');
    expect(formatTicks(6000)).toBe('01:40.000');
  });

  it('guards invalid times', () => {
    expect(formatMs(-1)).toBe('--:--.---');
    expect(formatMs(Number.NaN)).toBe('--:--.---');
    expect(formatTicks(Number.POSITIVE_INFINITY)).toBe('--:--.---');
  });

  it('formats ghost deltas with sign and hundredths', () => {
    expect(formatDelta(340)).toEqual({ text: '+0.34', sign: 1 });
    expect(formatDelta(-210)).toEqual({ text: '−0.21', sign: -1 });
    expect(formatDelta(4)).toEqual({ text: '±0.00', sign: 0 });
    expect(formatDelta(-1234.5)).toEqual({ text: '−1.23', sign: -1 });
    expect(formatDelta(61000).text).toBe('+61.00');
  });

  it('labels positions', () => {
    expect(positionLabel(1)).toBe('1위');
    expect(positionLabel(8)).toBe('8위');
    expect(positionTone(1)).toBe('gold');
    expect(positionTone(2)).toBe('silver');
    expect(positionTone(3)).toBe('bronze');
    expect(positionTone(4)).toBe('plain');
  });

  it('formats ISO dates', () => {
    expect(formatDate('2026-09-23T12:00:00')).toBe('2026.09.23');
    expect(formatDate('garbage')).toBe('');
  });
});

describe('player names', () => {
  it('accepts Hangul, Latin, digits, space, underscore and hyphen', () => {
    expect(validatePlayerName('터보왕')).toEqual({ ok: true, name: '터보왕' });
    expect(validatePlayerName('Kart_Pro-99')).toEqual({ ok: true, name: 'Kart_Pro-99' });
    expect(validatePlayerName('  핍 짱  ')).toEqual({ ok: true, name: '핍 짱' });
  });

  it('rejects empty, too long and symbol names', () => {
    expect(validatePlayerName('   ').ok).toBe(false);
    expect(validatePlayerName('가나다라마바사아자차카타파').ok).toBe(false); // 13
    expect(validatePlayerName('가나다라마바사아자차카타').ok).toBe(true);   // 12
    expect(validatePlayerName('<b>hi</b>').ok).toBe(false);
    expect(validatePlayerName('😀').ok).toBe(false);
    expect(validatePlayerName('___').ok).toBe(false);   // needs a letter or digit (server rule)
    expect(validatePlayerName('- -').ok).toBe(false);
  });

  it('matches the server: NFC and Hangul jamo (IME mid-composition) are accepted', () => {
    expect(validatePlayerName('ㅋㅋㅋ')).toEqual({ ok: true, name: 'ㅋㅋㅋ' });
    expect(validatePlayerName('터보ㅇ').ok).toBe(true);
    const nfd = '터보왕'.normalize('NFD');
    expect(nfd).not.toBe('터보왕');
    expect(validatePlayerName(nfd)).toEqual({ ok: true, name: '터보왕' });
    expect(normalizePlayerName(nfd)).toBe('터보왕');
  });

  it('normalises whitespace and length', () => {
    expect(normalizePlayerName('  a   b  ')).toBe('a b');
    expect(normalizePlayerName('abcdefghijklmnop')).toBe('abcdefghijkl');
  });
});
