import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import packageInfo from '../../package.json' with { type: 'json' };

export interface ServerConfig {
  production: boolean;
  host: string;
  port: number;
  /** Reported by /healthz, e.g. "1.0.0+3f2a9c1b7d4e". */
  version: string;
  /** Absolute directory holding the built client (index.html + assets/). */
  staticDir: string;
  /** DynamoDB table; undefined → in-memory repository. */
  tableName?: string;
  region?: string;
  /** Exact origins allowed to POST (e.g. https://d123.cloudfront.net). Empty → same-host only. */
  allowedOrigins: readonly string[];
}

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

function exactOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid origin in PUBLIC_ORIGIN/ALLOWED_ORIGINS: ${JSON.stringify(value)}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value.replace(/\/$/, '')) {
    throw new Error(`Origins must be exact scheme://host[:port] values: ${JSON.stringify(value)}`);
  }
  return url.origin;
}

/**
 * Build id written by tools/build.mjs. From the bundle (dist/server/index.js)
 * this resolves to dist/build.json; from source (tsx) the file does not exist.
 */
function builtVersion(): string | undefined {
  try {
    const info = JSON.parse(readFileSync(new URL('../build.json', import.meta.url), 'utf8')) as { version?: unknown; id?: unknown };
    if (typeof info.version === 'string' && typeof info.id === 'string') {
      const version = `${info.version}+${info.id.slice(0, 12)}`;
      if (VERSION_PATTERN.test(version)) return version;
    }
  } catch {
    // Not built (development/tests).
  }
  return undefined;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';

  const rawPort = env.PORT?.trim() || '8080';
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65_535) {
    throw new Error(`Invalid PORT: ${JSON.stringify(rawPort)}`);
  }

  const host = env.HOST?.trim() || (production ? '0.0.0.0' : '127.0.0.1');
  if (host !== 'localhost' && !isIP(host)) throw new Error('HOST must be an IP address or "localhost".');

  const version = env.APP_VERSION?.trim() || builtVersion() || packageInfo.version;
  if (!VERSION_PATTERN.test(version)) throw new Error('Invalid APP_VERSION.');

  const tableName = env.TABLE_NAME?.trim() || undefined;
  if (tableName && !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName)) throw new Error('Invalid TABLE_NAME.');

  const staticDir = resolve(env.STATIC_DIR?.trim() || 'dist/client');

  const origins = [
    ...(env.PUBLIC_ORIGIN?.trim() ? [env.PUBLIC_ORIGIN.trim()] : []),
    ...(env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map(v => v.trim()).filter(Boolean) : []),
  ];
  const allowedOrigins = [...new Set(origins.map(exactOrigin))];
  if (allowedOrigins.length > 16) throw new Error('Too many allowed origins (max 16).');

  const region = env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || undefined;

  return { production, host, port: Number(rawPort), version, staticDir, tableName, region, allowedOrigins };
}
