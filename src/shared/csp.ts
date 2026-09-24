/**
 * Browser security policy — the single source of truth used by the Fastify
 * server (src/server) and by the CloudFront response-headers policy (infra/).
 *
 * Everything the game loads is self-hosted and procedurally generated, so the
 * policy is self-only. Deliberate relaxations:
 *  - style-src 'unsafe-inline': src/client/index.html carries the critical
 *    splash / fatal-error CSS in an inline <style> so it paints before the
 *    bundle loads. CSS cannot execute script, so the XSS surface is unchanged
 *    while script-src stays strict. (Move that block into a stylesheet and
 *    this can become 'self'; CSSOM styling via element.style is never blocked.)
 *  - blob:/data: for images, media, fetch and workers (plus blob: scripts for
 *    audio worklets): canvas-generated textures/icons and synthesised audio
 *    may round-trip through object URLs. Creating a blob: URL already requires
 *    running same-origin script.
 * No 'unsafe-eval', no remote hosts, no inline <script>.
 */
export const CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'default-src': ["'self'"],
  'script-src': ["'self'", 'blob:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'", 'data:'],
  'media-src': ["'self'", 'data:', 'blob:'],
  'connect-src': ["'self'", 'data:', 'blob:'],
  'worker-src': ["'self'", 'blob:'],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
});

export interface CspOptions {
  /** Add `upgrade-insecure-requests` (HTTPS deployments only; breaks plain-HTTP local runs). */
  upgradeInsecureRequests?: boolean;
}

export function contentSecurityPolicy(options: CspOptions = {}): string {
  const parts = Object.entries(CSP_DIRECTIVES).map(([name, values]) => `${name} ${values.join(' ')}`);
  if (options.upgradeInsecureRequests) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

/** Policy served to viewers over HTTPS (CloudFront and the production server). */
export const CONTENT_SECURITY_POLICY = contentSecurityPolicy({ upgradeInsecureRequests: true });

/**
 * Powerful features: only gamepad, fullscreen and screen wake-lock (keeps phones
 * awake during a race) are allowed, and only for this origin.
 */
export const PERMISSIONS_POLICY = [
  'accelerometer=()', 'autoplay=(self)', 'camera=()', 'display-capture=()',
  'fullscreen=(self)', 'gamepad=(self)', 'geolocation=()', 'gyroscope=()',
  'magnetometer=()', 'microphone=()', 'midi=()', 'payment=()',
  'screen-wake-lock=(self)', 'usb=()', 'xr-spatial-tracking=()',
].join(', ');

/** Static security headers shared by origin and edge (CSP and HSTS handled separately). */
export const REFERRER_POLICY = 'no-referrer';
export const FRAME_OPTIONS = 'DENY';
export const CROSS_ORIGIN_OPENER_POLICY = 'same-origin';
export const CROSS_ORIGIN_RESOURCE_POLICY = 'same-origin';
export const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * Edge ↔ origin contract: the CloudFront viewer-request function overwrites this
 * header with event.viewer.ip; the server uses it only as a rate-limit key.
 */
export const CLIENT_IP_HEADER = 'x-turbo-client-ip';
