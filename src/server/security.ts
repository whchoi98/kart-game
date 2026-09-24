import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import {
  CLIENT_IP_HEADER, CROSS_ORIGIN_OPENER_POLICY, CROSS_ORIGIN_RESOURCE_POLICY, FRAME_OPTIONS,
  PERMISSIONS_POLICY, REFERRER_POLICY, contentSecurityPolicy,
} from '../shared/csp.js';

/**
 * CLIENT_IP_HEADER is set by the CloudFront viewer-request function from
 * event.viewer.ip, replacing any client-supplied value. The ALB only forwards
 * CloudFront traffic that carries the origin secret, so the value is
 * trustworthy as a rate-limit key (and is never logged or stored).
 */
export { CLIENT_IP_HEADER };

/**
 * Origin headers are stamped at the edge with an upgrade-insecure-requests
 * CSP and HSTS (infra/lib/edge.ts). The origin itself also serves plain HTTP
 * (local runs, docker run), so its CSP must not force HTTPS.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': contentSecurityPolicy(),
  'x-content-type-options': 'nosniff',
  'x-frame-options': FRAME_OPTIONS,
  'referrer-policy': REFERRER_POLICY,
  'permissions-policy': PERMISSIONS_POLICY,
  'cross-origin-opener-policy': CROSS_ORIGIN_OPENER_POLICY,
  'cross-origin-resource-policy': CROSS_ORIGIN_RESOURCE_POLICY,
});

function expandIPv6(address: string): string[] {
  const [head = '', tail = ''] = address.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0');
  return [...left, ...fill, ...right].map(part => Number.parseInt(part, 16).toString(16));
}

/** Normalised client address: IPv4-mapped → IPv4, IPv6 grouped by /64 (privacy addresses rotate). */
export function normalizeAddress(address: string): string {
  const bare = address.replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped) return mapped[1]!;
  if (isIP(bare) === 6) return `${expandIPv6(bare).slice(0, 4).join(':')}::/64`;
  return bare;
}

/** Rate-limit key: the edge-supplied viewer IP when valid, otherwise the socket peer. */
export function clientKey(request: FastifyRequest): string {
  const header = request.headers[CLIENT_IP_HEADER];
  const viewer = typeof header === 'string' ? header.trim() : '';
  const address = viewer && isIP(viewer.replace(/%.*$/, '')) ? viewer : request.ip;
  return normalizeAddress(address || 'unknown');
}

/**
 * A browser always sends Origin on cross-site and same-site POSTs; when present
 * it must be one of the configured public origins. Without configuration
 * (local development) only same-host origins are accepted. Requests without an
 * Origin header come from non-browser clients and rely on replay verification.
 */
export function isOriginAllowed(request: FastifyRequest, allowedOrigins: readonly string[]): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string' || origin.length > 256) return false;
  if (allowedOrigins.length) return allowedOrigins.includes(origin);
  const host = request.headers.host;
  return typeof host === 'string' && (origin === `http://${host}` || origin === `https://${host}`);
}

export function isJsonContentType(request: FastifyRequest): boolean {
  const type = request.headers['content-type'];
  return typeof type === 'string' && /^application\/json\s*(?:;\s*charset=utf-8\s*)?$/i.test(type);
}
