import { performance } from 'node:perf_hooks';
import compress from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  LogController,
  type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions,
} from 'fastify';
import packageInfo from '../../package.json' with { type: 'json' };
import { API_LIMITS, type GhostResponse, type LeaderboardResponse, type SubmitRunResponse } from '../shared/api.js';
import { isCharacterId } from '../sim/characters.js';
import type { SpeedClass } from '../sim/types.js';
import type { ServerConfig } from './config.js';
import { createDocumentClient, DynamoRepository, StorageError } from './dynamo-repository.js';
import {
  ApiFailure, forbiddenOrigin, invalidName, invalidRequest, notFound, payloadTooLarge,
  rangeNotSatisfiable, rateLimited, unavailable, unsupportedMediaType, verifierBusy,
} from './errors.js';
import { MemoryRepository } from './memory-repository.js';
import { DuplicateRunError, type Repository, type VerifiedRun } from './repository.js';
import { SECURITY_HEADERS, clientKey, isJsonContentType, isOriginAllowed } from './security.js';
import { isApiPath, isSpaNavigation, locateClient, registerStatic, requestPath, sendIndex } from './static.js';
import {
  BODY_LIMIT, ghostParamsSchema, ghostResponseSchema, leaderboardQuerySchema, leaderboardResponseSchema,
  logDigest, newRunId, noQuerySchema, normalizeName, submitResponseSchema, submitRunSchema,
  type LeaderboardQuery, type SubmitRunBody,
} from './validation.js';
import {
  VerifierBusyError, VerifierUnavailableError, WorkerVerifier,
  type VerifyFn, type VerifyInput, type VerifyResult,
} from './verifier.js';

export interface RateLimits {
  /** POST /api/runs per client per window. */
  submit: number;
  /** GET /api/* per client per window (leaderboard + ghost share one budget). */
  read: number;
  /** Pages and static files per client per window. */
  page: number;
  windowMs: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { submit: 12, read: 120, page: 600, windowMs: 60_000 };

export interface BuildAppOptions {
  /** Overrides on top of development defaults (tests) — index.ts passes readConfig(). */
  config?: Partial<ServerConfig>;
  /** Default: DynamoDB when config.tableName is set, else in-memory. */
  repository?: Repository;
  /** Default: the real `verifyTimeTrial` on a worker-thread pool. */
  verify?: VerifyFn;
  /** Client build directory; false disables static serving. Default: config.staticDir. */
  staticDir?: string | false;
  rateLimits?: Partial<RateLimits>;
  logger?: FastifyServerOptions['logger'];
  /** Start the verifier worker threads immediately (production entry point). */
  warmVerifier?: boolean;
  now?: () => Date;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Storage backend in use. */
    readonly repositoryKind: 'memory' | 'dynamodb';
    /** Resolved client build directory, or undefined when static serving is off. */
    readonly staticRoot: string | undefined;
  }
}

export type TurboPalsApp = FastifyInstance;

const OWN_ERROR_NAMES = new Set(['StorageError', 'VerifierUnavailableError']);
/** Routes that carry their own limiter (API) or none at all (health checks). */
const SELF_LIMITED_ROUTES = new Set(['/healthz', '/api/leaderboard', '/api/ghost/:id', '/api/runs']);
const semverCore = (version: string) => version.split('+')[0]!;

/** API traffic by raw path or by matched route (a percent-encoded path can still match an API route). */
function isApiRequest(request: FastifyRequest): boolean {
  return isApiPath(requestPath(request)) || isApiPath(request.routeOptions.url ?? '');
}

function defaultConfig(overrides: Partial<ServerConfig>): ServerConfig {
  return {
    production: false,
    host: '127.0.0.1',
    port: 8080,
    version: packageInfo.version,
    staticDir: 'dist/client',
    allowedOrigins: [],
    ...overrides,
  };
}

function describeValidation(error: FastifyError): string {
  const first = error.validation?.[0];
  const context = error.validationContext ?? 'request';
  const path = first?.instancePath ? first.instancePath.replace(/^\//, '').replace(/\//g, '.') : '';
  const missing = first?.keyword === 'required' && typeof first.params?.missingProperty === 'string'
    ? first.params.missingProperty : '';
  const extra = first?.keyword === 'additionalProperties' && typeof first.params?.additionalProperty === 'string'
    ? first.params.additionalProperty : '';
  const field = [path, missing, extra].filter(Boolean).join('.');
  return field ? `${context}.${field}` : context;
}

/** Compares the claimed result with the server re-simulation; returns a rejection or undefined. */
function compareResult(result: VerifyResult, body: SubmitRunBody, serverVersion: string):
  { code: string; reason: string } | undefined {
  if (!result.ok) {
    // A different client build simulates differently: tell the player to reload rather than blame the run.
    if (semverCore(body.version) !== semverCore(serverVersion)) {
      return {
        code: 'VERSION_MISMATCH',
        reason: '서버 재시뮬레이션으로 기록을 확인하지 못했습니다. 게임이 최신 버전이 아닙니다 — 새로고침 후 다시 달려 주세요.',
      };
    }
    return {
      code: 'REPLAY_INVALID',
      reason: '서버 재시뮬레이션으로 기록을 확인하지 못했습니다. 입력 기록이 완주 기록이 아니거나 손상되었습니다.',
    };
  }
  if (result.ticks !== body.ticks) {
    return { code: 'TIME_MISMATCH', reason: '제출한 완주 시간이 서버 재시뮬레이션 결과와 다릅니다.' };
  }
  if (result.lapTicks.length !== body.lapTicks.length || result.lapTicks.some((lap, i) => lap !== body.lapTicks[i])) {
    return { code: 'LAP_MISMATCH', reason: '제출한 랩 기록이 서버 재시뮬레이션 결과와 다릅니다.' };
  }
  return undefined;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<TurboPalsApp> {
  const config = defaultConfig(options.config ?? {});
  const now = options.now ?? (() => new Date());
  const rates: RateLimits = { ...DEFAULT_RATE_LIMITS, ...options.rateLimits };
  const repository = options.repository ?? (config.tableName
    ? new DynamoRepository(config.tableName, createDocumentClient(config.region))
    : new MemoryRepository());
  const pool = options.verify ? undefined : new WorkerVerifier();
  const verify: VerifyFn = options.verify ?? pool!.verify;
  const clientRoot = options.staticDir === false ? undefined : await locateClient(options.staticDir ?? config.staticDir);
  if (!clientRoot && config.production && options.staticDir !== false) {
    await repository.close();
    await pool?.close();
    throw new Error('The built client (index.html) is required in production. Run `npm run build`.');
  }

  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: BODY_LIMIT,
    trustProxy: false,
    requestIdHeader: false,
    // ALB idle timeout is 60 s: keep sockets open longer so the ALB never reuses a closed one.
    keepAliveTimeout: 65_000,
    requestTimeout: 30_000,
    return503OnClosing: true,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false, allErrors: false } },
    // Malformed percent-encoding and over-long route parameters are rejected by the router
    // before any hook runs; answer them in the API's own shape, with the security headers.
    frameworkErrors: (error, _request, genericReply) => {
      const reply = genericReply as unknown as FastifyReply;
      const failure = error.code === 'FST_ERR_MAX_PARAM_LENGTH'
        ? new ApiFailure(414, 'INVALID_REQUEST', '요청 주소가 너무 깁니다.')
        : error.code === 'FST_ERR_BAD_URL' ? invalidRequest() : unavailable();
      reply.headers(SECURITY_HEADERS).header('cache-control', 'no-store');
      if (failure.retryAfter) reply.header('retry-after', String(failure.retryAfter));
      return reply.code(failure.statusCode).send({ error: failure.code, message: failure.message });
    },
  });

  app.decorate('repositoryKind', repository.kind);
  app.decorate('staticRoot', clientRoot);

  app.addHook('onClose', async () => {
    await pool?.close();
    await repository.close();
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.headers(SECURITY_HEADERS);
    if (isApiRequest(request)) reply.header('cache-control', 'no-store');
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    if (reply.statusCode >= 400) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    // ALB/container probes every few seconds would drown the access log.
    if (request.routeOptions.url === '/healthz' && reply.statusCode === 200) return;
    // Route template only: no query strings, bodies, names, logs, IPs or player ids.
    request.log.info({
      event: 'request',
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    }, 'request completed');
  });

  app.setErrorHandler((error: FastifyError | ApiFailure | Error, request, reply) => {
    let failure: ApiFailure;
    const detail = error as FastifyError;
    const status = typeof detail.statusCode === 'number' ? detail.statusCode : 500;
    if (error instanceof ApiFailure) failure = error;
    else if (detail.validation) failure = invalidRequest(describeValidation(detail));
    else if (status === 413 || detail.code === 'FST_ERR_CTP_BODY_TOO_LARGE') failure = payloadTooLarge();
    else if (status === 415 || detail.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') failure = unsupportedMediaType();
    // @fastify/static answers dotfiles, directories, NUL bytes and over-long names with 403:
    // to a client that is indistinguishable from a missing file.
    else if (status === 403 || status === 404) failure = notFound();
    else if (status === 416) failure = rangeNotSatisfiable();
    else if (status >= 400 && status < 500) failure = new ApiFailure(status, 'INVALID_REQUEST', invalidRequest().message);
    else {
      failure = unavailable();
      request.log.error({
        event: 'request_failed',
        route: request.routeOptions.url ?? 'unmatched',
        error: OWN_ERROR_NAMES.has(error.name) ? error.name : 'InternalError',
        // Stable machine codes only (ENOENT, FST_ERR_…); messages may carry paths or input.
        code: typeof detail.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(detail.code) ? detail.code : undefined,
        reason: error instanceof StorageError || error instanceof VerifierUnavailableError ? error.reason : undefined,
      }, 'request failed');
    }
    if (failure.retryAfter) reply.header('retry-after', String(failure.retryAfter));
    return reply.code(failure.statusCode).send({ error: failure.code, message: failure.message });
  });

  try {
    await app.register(compress, {
      global: true,
      threshold: 1024,
      encodings: ['br', 'gzip'],
      globalDecompression: false,
    });
    await app.register(rateLimit, {
      global: false,
      cache: 20_000,
      keyGenerator: clientKey,
      skipOnError: true,
      errorResponseBuilder: (_request, context) => rateLimited(context.ttl / 1000),
    });
    const limiter = (max: number) => app.rateLimit({ max, timeWindow: rates.windowMs });
    const submitLimit = limiter(rates.submit);
    const readLimit = limiter(rates.read);
    const pageLimit = limiter(rates.page);

    // API routes carry their own limiter and /healthz is exempt. Everything else is charged here:
    // pages/static files share the page budget, unknown /api/* paths (404s) the read budget,
    // so no path — matched or not — can be requested without limit.
    app.addHook('onRequest', async (request, reply) => {
      const route = request.routeOptions.url;
      if (route !== undefined && SELF_LIMITED_ROUTES.has(route)) return;
      await (isApiRequest(request) ? readLimit : pageLimit).call(app, request, reply);
    });

    const originGuard = async (request: FastifyRequest) => {
      if (!isOriginAllowed(request, config.allowedOrigins)) throw forbiddenOrigin();
    };
    const jsonOnly = async (request: FastifyRequest) => {
      if (!isJsonContentType(request)) throw unsupportedMediaType();
    };

    app.get('/healthz', { config: { rateLimit: false } }, async (_request, reply) => {
      reply.header('cache-control', 'no-store');
      return { ok: true, version: config.version };
    });

    app.get<{ Querystring: LeaderboardQuery }>('/api/leaderboard', {
      onRequest: [readLimit],
      schema: { querystring: leaderboardQuerySchema, response: { 200: leaderboardResponseSchema } },
    }, async (request): Promise<LeaderboardResponse> => {
      const cc = Number(request.query.cc) as SpeedClass;
      const entries = await repository.leaderboard(request.query.track, cc, API_LIMITS.leaderboardSize);
      return { trackId: request.query.track, cc, entries };
    });

    app.get<{ Params: { id: string } }>('/api/ghost/:id', {
      onRequest: [readLimit],
      schema: { params: ghostParamsSchema, querystring: noQuerySchema, response: { 200: ghostResponseSchema } },
    }, async (request, reply): Promise<GhostResponse> => {
      const ghost = await repository.ghost(request.params.id);
      if (!ghost) throw notFound('고스트 기록을 찾을 수 없습니다. 더 빠른 기록으로 교체되었을 수 있습니다.');
      // A run id always names the same immutable log.
      reply.header('cache-control', 'private, max-age=3600, immutable');
      return ghost;
    });

    app.post<{ Body: SubmitRunBody }>('/api/runs', {
      onRequest: [submitLimit, originGuard, jsonOnly],
      bodyLimit: BODY_LIMIT,
      schema: { body: submitRunSchema, querystring: noQuerySchema, response: { 200: submitResponseSchema } },
    }, async (request, reply): Promise<SubmitRunResponse | FastifyReply> => {
      const body = request.body;
      const name = normalizeName(body.name);
      if (!name) throw invalidName();
      if (!isCharacterId(body.charId)) throw invalidRequest('body.charId');

      const input: VerifyInput = { trackId: body.trackId, cc: body.cc, charId: body.charId, log: body.log };
      const started = performance.now();
      let result: VerifyResult;
      try {
        result = await verify(input);
      } catch (error) {
        if (error instanceof VerifierBusyError) throw verifierBusy();
        throw error instanceof VerifierUnavailableError ? error : new VerifierUnavailableError('verify threw');
      }
      const verifyMs = Math.round(performance.now() - started);
      const summary = { trackId: body.trackId, cc: body.cc, charId: body.charId, verifyMs };

      const rejection = compareResult(result, body, config.version);
      if (rejection) {
        request.log.info({
          event: 'run_rejected', ...summary, code: rejection.code,
          detail: result.ok ? undefined : result.reason.slice(0, 200),
        }, 'run rejected');
        const response: SubmitRunResponse & { error: string; message: string } = {
          accepted: false, id: '', rank: null, personalBest: false, reason: rejection.reason,
          error: rejection.code, message: rejection.reason,
        };
        return reply.code(422).send(response);
      }

      const at = now();
      const run: VerifiedRun = {
        id: newRunId(at.getTime()),
        playerId: body.playerId.toLowerCase(),
        name,
        charId: body.charId,
        trackId: body.trackId,
        cc: body.cc,
        ticks: body.ticks,
        lapTicks: [...body.lapTicks],
        log: body.log,
        logHash: logDigest(body.log),
        version: body.version,
        createdAt: at.toISOString(),
      };
      let outcome;
      try {
        outcome = await repository.submit(run, API_LIMITS.leaderboardSize);
      } catch (error) {
        if (!(error instanceof DuplicateRunError)) throw error;
        request.log.info({ event: 'run_rejected', ...summary, code: 'DUPLICATE_RUN' }, 'run rejected');
        const reason = '이미 다른 플레이어가 등록한 주행 기록입니다. 직접 달린 기록만 제출할 수 있습니다.';
        const response: SubmitRunResponse & { error: string; message: string } = {
          accepted: false, id: '', rank: null, personalBest: false, reason, error: 'DUPLICATE_RUN', message: reason,
        };
        return reply.code(409).send(response);
      }
      request.log.info({
        event: 'run_accepted', ...summary, ticks: run.ticks, personalBest: outcome.personalBest, rank: outcome.rank,
      }, 'run accepted');
      return { accepted: true, id: outcome.id, rank: outcome.rank, personalBest: outcome.personalBest };
    });

    if (clientRoot) await registerStatic(app, clientRoot);

    app.setNotFoundHandler(async (request, reply) => {
      if (clientRoot && isSpaNavigation(request)) return sendIndex(reply);
      throw notFound();
    });

    await app.ready();
  } catch (error) {
    await app.close();
    throw error;
  }
  if (options.warmVerifier) pool?.warm();
  return app;
}
