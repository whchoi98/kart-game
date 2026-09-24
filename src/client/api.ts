/**
 * Browser client for the leaderboard / ghost API (contract: src/shared/api.ts).
 * Every request times out after 8 s; failures surface as `ApiRequestError` whose
 * `message` is a friendly Korean sentence ready to show in the UI.
 */
import { isCharacterId } from '../sim/characters.js';
import type { SpeedClass } from '../sim/types.js';
import type {
  ApiError, GhostResponse, LeaderboardEntry, LeaderboardResponse, SubmitRunRequest, SubmitRunResponse,
} from '../shared/api.js';

export const API_TIMEOUT_MS = 8000;

export type ApiErrorKind =
  | 'offline'      // navigator reports no network
  | 'timeout'      // no answer within API_TIMEOUT_MS
  | 'network'      // fetch failed (DNS, CORS, connection reset, server down)
  | 'aborted'      // caller cancelled
  | 'rate-limited' // 429
  | 'not-found'    // 404
  | 'invalid'      // 400 / 413 / 422 — the request itself was rejected
  | 'server'       // 5xx
  | 'bad-response';// unexpected payload

export class ApiRequestError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null,
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const MESSAGES: Record<ApiErrorKind, string> = {
  offline: '인터넷에 연결되어 있지 않아요. 연결을 확인한 뒤 다시 시도해 주세요.',
  timeout: '서버 응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.',
  network: '랭킹 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.',
  aborted: '요청이 취소되었어요.',
  'rate-limited': '요청이 너무 많아요. 잠시 쉬었다가 다시 시도해 주세요.',
  'not-found': '요청한 기록을 찾을 수 없어요.',
  invalid: '요청이 올바르지 않아요.',
  server: '서버에 일시적인 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
  'bad-response': '서버 응답을 이해하지 못했어요. 게임을 새로고침해 주세요.',
};

export function friendlyMessage(kind: ApiErrorKind): string {
  return MESSAGES[kind];
}

/** Stable machine codes sent by the server (src/server/errors.ts, src/server/app.ts). */
const CODE_MESSAGES: Readonly<Record<string, string>> = {
  VERSION_MISMATCH: '게임 버전이 달라요. 새로고침한 뒤 다시 도전해 주세요.',
  REPLAY_INVALID: '기록 검증에 실패했어요. 주행 기록이 완주 기록이 아니거나 손상되었어요.',
  TIME_MISMATCH: '기록 검증에 실패했어요. 서버 재생 결과와 완주 시간이 달라요.',
  LAP_MISMATCH: '기록 검증에 실패했어요. 서버 재생 결과와 랩 기록이 달라요.',
  DUPLICATE_RUN: '이미 다른 플레이어가 등록한 주행 기록이에요. 직접 달린 기록만 등록할 수 있어요.',
  INVALID_NAME: '닉네임을 확인해 주세요. (한글·영문·숫자 1~12자)',
  PAYLOAD_TOO_LARGE: '주행 기록이 너무 커서 등록할 수 없어요.',
  UNSUPPORTED_MEDIA_TYPE: '요청 형식이 올바르지 않아요. 게임을 새로고침해 주세요.',
  FORBIDDEN_ORIGIN: '이 주소에서는 기록을 등록할 수 없어요. 공식 게임 페이지에서 다시 시도해 주세요.',
  VERIFIER_BUSY: '기록 검증 대기열이 가득 찼어요. 잠시 후 다시 등록해 주세요.',
  RATE_LIMITED: '요청이 너무 많아요. 잠시 쉬었다가 다시 시도해 주세요.',
  SERVICE_UNAVAILABLE: '서버에 일시적인 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
  NOT_FOUND: '요청한 기록을 찾을 수 없어요. 더 빠른 기록으로 바뀌었을 수 있어요.',
};

/** Human readable Korean text for a server-side rejection reason / error code. */
export function describeRejection(reason: string | undefined | null): string {
  const exact = reason ? CODE_MESSAGES[reason.trim()] : undefined;
  if (exact) return exact;
  const r = (reason ?? '').toLowerCase();
  if (!r) return '기록 검증에 실패했어요.';
  if (r.includes('duplicate')) return CODE_MESSAGES.DUPLICATE_RUN!;
  if (r.includes('busy')) return CODE_MESSAGES.VERIFIER_BUSY!;
  if (r.includes('version')) return '게임 버전이 달라요. 새로고침한 뒤 다시 도전해 주세요.';
  if (r.includes('name')) return '닉네임을 확인해 주세요. (한글·영문·숫자 1~12자)';
  if (r.includes('mismatch') || r.includes('verify') || r.includes('replay') || r.includes('sim')) {
    return '기록 검증에 실패했어요. 재생 결과가 제출한 기록과 달라요.';
  }
  if (r.includes('log') || r.includes('decode') || r.includes('too large') || r.includes('size')) {
    return '주행 기록 데이터가 올바르지 않아요.';
  }
  if (r.includes('track') || r.includes('cc') || r.includes('char')) return '코스 또는 캐릭터 정보가 올바르지 않아요.';
  if (r.includes('rate') || r.includes('limit')) return MESSAGES['rate-limited'];
  if (r.includes('slower') || r.includes('not faster') || r.includes('personal')) return '이전 등록 기록보다 빠르지 않아 순위가 바뀌지 않았어요.';
  return '기록을 등록하지 못했어요.';
}

interface RequestOpts { signal?: AbortSignal; timeoutMs?: number }

async function request<T>(path: string, init: RequestInit, opts: RequestOpts = {}): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ApiRequestError('offline', MESSAGES.offline);
  }
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, opts.timeoutMs ?? API_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      signal: ctrl.signal,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (err) {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    if (timedOut) throw new ApiRequestError('timeout', MESSAGES.timeout);
    if (opts.signal?.aborted) throw new ApiRequestError('aborted', MESSAGES.aborted);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ApiRequestError('offline', MESSAGES.offline);
    throw new ApiRequestError('network', MESSAGES.network, null, null, err instanceof Error ? err.message : String(err));
  }

  let body: unknown = null;
  let text = '';
  try {
    text = await res.text();
    body = text ? JSON.parse(text) as unknown : null;
  } catch {
    body = null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  if (timedOut) throw new ApiRequestError('timeout', MESSAGES.timeout);

  if (!res.ok) {
    const err = (body && typeof body === 'object') ? body as Partial<ApiError> : {};
    const code = typeof err.error === 'string' ? err.error : null;
    const detail = typeof err.message === 'string' ? err.message : null;
    const status = res.status;
    const known = code ? CODE_MESSAGES[code] : undefined;
    if (status === 429) throw new ApiRequestError('rate-limited', MESSAGES['rate-limited'], status, code, detail);
    if (status === 404) throw new ApiRequestError('not-found', known ?? MESSAGES['not-found'], status, code, detail);
    if (status >= 500) throw new ApiRequestError('server', known ?? MESSAGES.server, status, code, detail);
    if (status >= 400) {
      throw new ApiRequestError('invalid', describeRejection(code ?? detail), status, code, detail);
    }
    throw new ApiRequestError('bad-response', MESSAGES['bad-response'], status, code, detail);
  }
  if (body === null || typeof body !== 'object') {
    throw new ApiRequestError('bad-response', MESSAGES['bad-response'], res.status, null, text.slice(0, 200));
  }
  return body as T;
}

function isEntry(e: unknown): e is LeaderboardEntry {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  return typeof r.rank === 'number' && typeof r.id === 'string' && typeof r.name === 'string'
    && isCharacterId(r.charId) && typeof r.ticks === 'number' && Array.isArray(r.lapTicks);
}

export async function fetchLeaderboard(trackId: string, cc: SpeedClass, opts?: RequestOpts): Promise<LeaderboardResponse> {
  const q = new URLSearchParams({ track: trackId, cc: String(cc) });
  const res = await request<LeaderboardResponse>(`/api/leaderboard?${q.toString()}`, { method: 'GET' }, opts);
  if (!Array.isArray(res.entries)) throw new ApiRequestError('bad-response', MESSAGES['bad-response']);
  const entries = res.entries.filter(isEntry).map(e => ({
    ...e,
    createdAt: typeof e.createdAt === 'string' ? e.createdAt : '',
    lapTicks: e.lapTicks.filter(t => typeof t === 'number'),
  }));
  entries.sort((a, b) => a.rank - b.rank);
  return { trackId: res.trackId ?? trackId, cc: res.cc ?? cc, entries };
}

let leaderboardRevision = 0;

/** Bumped whenever this client gets a run accepted, so cached leaderboards are refetched. */
export function leaderboardVersion(): number {
  return leaderboardRevision;
}

export async function submitRun(req: SubmitRunRequest, opts?: RequestOpts): Promise<SubmitRunResponse> {
  const res = await request<SubmitRunResponse>('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  }, { timeoutMs: API_TIMEOUT_MS, ...opts });
  if (typeof res.accepted !== 'boolean') throw new ApiRequestError('bad-response', MESSAGES['bad-response']);
  if (res.accepted) leaderboardRevision++;
  return {
    accepted: res.accepted,
    id: typeof res.id === 'string' ? res.id : '',
    rank: typeof res.rank === 'number' ? res.rank : null,
    personalBest: !!res.personalBest,
    ...(typeof res.reason === 'string' ? { reason: res.reason } : {}),
  };
}

export async function fetchGhost(id: string, opts?: RequestOpts): Promise<GhostResponse> {
  const res = await request<GhostResponse>(`/api/ghost/${encodeURIComponent(id)}`, { method: 'GET' }, opts);
  if (typeof res.log !== 'string' || !isCharacterId(res.charId) || typeof res.ticks !== 'number') {
    throw new ApiRequestError('bad-response', MESSAGES['bad-response']);
  }
  return res;
}

/**
 * The request never reached a working server (offline, DNS/connection failure, timeout, or the
 * CDN answering 502/503/504 because the origin is unreachable): worth keeping a run to retry later.
 * Verification refusals (4xx) and rate limits are answers, not connectivity problems.
 */
export function isConnectivityError(err: unknown): boolean {
  if (!(err instanceof ApiRequestError)) return false;
  if (err.kind === 'offline' || err.kind === 'network' || err.kind === 'timeout') return true;
  return err.kind === 'server' && (err.status === 502 || err.status === 503 || err.status === 504);
}

/** Offline right now (navigator.onLine is the only signal browsers expose). */
export function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Normalise any thrown value into a user-facing Korean message. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  return MESSAGES.network;
}
