/**
 * Pure formatting / validation helpers shared by menus, HUD and results.
 * No DOM access — unit tested in test/client/ui-format.test.ts.
 */
import { TICK_HZ } from '../../sim/constants.js';
import { API_LIMITS } from '../../shared/api.js';

/** 60 Hz ticks → whole milliseconds. */
export function ticksToMs(ticks: number): number {
  return Math.round((ticks * 1000) / TICK_HZ);
}

const INVALID_TIME = '--:--.---';

/** `mm:ss.mmm` (minutes are zero-padded to two digits and grow past 99). */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return INVALID_TIME;
  const total = Math.round(ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/** Race ticks → `mm:ss.mmm`. */
export function formatTicks(ticks: number): string {
  if (!Number.isFinite(ticks) || ticks < 0) return INVALID_TIME;
  return formatMs(ticksToMs(ticks));
}

/** A lap time in ticks; 0 / negative (no completed lap) reads as the placeholder, never `00:00.000`. */
export function formatLapTicks(ticks: number): string {
  return ticks > 0 ? formatTicks(ticks) : INVALID_TIME;
}

export interface DeltaText { text: string; sign: -1 | 0 | 1 }

/**
 * Ghost / record delta: `+0.34` (behind), `−0.21` (ahead, U+2212 minus), `±0.00`.
 * Rounded to hundredths; values under 5 ms read as a tie.
 */
export function formatDelta(ms: number, decimals = 2): DeltaText {
  if (!Number.isFinite(ms)) return { text: '', sign: 0 };
  const factor = 10 ** decimals;
  const rounded = Math.round(Math.abs(ms) / 1000 * factor) / factor;
  if (rounded === 0) return { text: `±${(0).toFixed(decimals)}`, sign: 0 };
  const body = rounded.toFixed(decimals);
  return ms > 0 ? { text: `+${body}`, sign: 1 } : { text: `−${body}`, sign: -1 };
}

/** `1위`, `2위` … */
export function positionLabel(position: number): string {
  return `${Math.max(1, Math.round(position))}위`;
}

/** Ordinal tone used for colouring positions (1 gold, 2 silver, 3 bronze, rest plain). */
export function positionTone(position: number): 'gold' | 'silver' | 'bronze' | 'plain' {
  if (position === 1) return 'gold';
  if (position === 2) return 'silver';
  if (position === 3) return 'bronze';
  return 'plain';
}

/** ISO-8601 → `2026.09.23` in the viewer's local time zone. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}.${mm}.${dd}`;
}

// ───────────────────────────── Player names ─────────────────────────────

/**
 * Same rules as the server (src/server/validation.ts normalizeName): NFC, Hangul syllables
 * and jamo (jamo also appear mid-composition while an IME is typing), Latin letters, digits,
 * space, underscore and hyphen, with at least one letter or digit.
 */
const NAME_CHARS = /^[0-9A-Za-z가-힣ㄱ-ㅣ _-]+$/u;
const NAME_HAS_WORD = /[0-9A-Za-z가-힣ㄱ-ㅣ]/u;

function cleanName(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** NFC, trim, collapse inner whitespace, and cut to the maximum length (in code points). */
export function normalizePlayerName(raw: string): string {
  return Array.from(cleanName(raw)).slice(0, API_LIMITS.nameMax).join('').trim();
}

export type NameCheck = { ok: true; name: string } | { ok: false; message: string };

export function validatePlayerName(raw: string): NameCheck {
  const name = cleanName(raw);
  const len = Array.from(name).length;
  if (len < API_LIMITS.nameMin) return { ok: false, message: '닉네임을 입력해 주세요.' };
  if (len > API_LIMITS.nameMax) return { ok: false, message: `닉네임은 ${API_LIMITS.nameMax}자까지 쓸 수 있어요.` };
  if (!NAME_CHARS.test(name)) return { ok: false, message: '한글, 영문, 숫자, 공백, _ - 만 쓸 수 있어요.' };
  if (!NAME_HAS_WORD.test(name)) return { ok: false, message: '글자나 숫자를 한 개 이상 넣어 주세요.' };
  return { ok: true, name };
}

/** Clamp helper used across UI code. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
