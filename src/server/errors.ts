/**
 * Public API errors. Only these stable codes and Korean messages cross the
 * HTTP boundary; internal exceptions are mapped to SERVICE_UNAVAILABLE.
 */
export class ApiFailure extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    /** Seconds for the Retry-After header. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

export const invalidRequest = (detail?: string) => new ApiFailure(
  400, 'INVALID_REQUEST',
  detail ? `요청 형식이 올바르지 않습니다: ${detail}` : '요청 형식이 올바르지 않습니다.',
);
export const invalidName = () => new ApiFailure(
  400, 'INVALID_NAME',
  '이름은 1~12자의 한글, 영문, 숫자, 공백, _ 또는 - 만 사용할 수 있습니다.',
);
export const forbiddenOrigin = () => new ApiFailure(403, 'FORBIDDEN_ORIGIN', '허용되지 않은 출처의 요청입니다.');
export const notFound = (message = '요청한 리소스를 찾을 수 없습니다.') => new ApiFailure(404, 'NOT_FOUND', message);
export const payloadTooLarge = () => new ApiFailure(413, 'PAYLOAD_TOO_LARGE', '요청 본문이 너무 큽니다.');
export const rangeNotSatisfiable = () => new ApiFailure(416, 'RANGE_NOT_SATISFIABLE', '요청한 범위를 제공할 수 없습니다.');
export const unsupportedMediaType = () => new ApiFailure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type 은 application/json 이어야 합니다.');
export const rateLimited = (retryAfter: number) => new ApiFailure(
  429, 'RATE_LIMITED', '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', Math.max(1, Math.ceil(retryAfter)),
);
export const verifierBusy = () => new ApiFailure(503, 'VERIFIER_BUSY', '기록 검증 대기열이 가득 찼습니다. 잠시 후 다시 제출해 주세요.', 3);
export const unavailable = () => new ApiFailure(503, 'SERVICE_UNAVAILABLE', '서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.', 2);
