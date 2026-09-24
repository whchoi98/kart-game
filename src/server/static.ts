import { realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE = 'no-cache';

/** Resolves the client build root, or undefined when no index.html is present. */
export async function locateClient(root: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(root);
    return (await stat(join(canonical, 'index.html'))).isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Serves the Vite build: content-hashed /assets/* are immutable for a year,
 * everything else (index.html, favicon, manifest…) revalidates on every use.
 * Missing files fall through to the app's not-found handler (SPA fallback).
 */
export async function registerStatic(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, {
    root,
    serve: true,
    index: false,
    redirect: false,
    wildcard: true,
    list: false,
    dotfiles: 'ignore',
    serveDotFiles: false,
    cacheControl: false,
    etag: true,
    lastModified: true,
    setHeaders(reply, path) {
      const local = relative(root, path).split(sep).join('/');
      reply.header('cache-control', local.startsWith('assets/') ? IMMUTABLE_CACHE : REVALIDATE_CACHE);
    },
  });
  app.get('/', (_request, reply) => sendIndex(reply));
}

export function sendIndex(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', REVALIDATE_CACHE).type('text/html; charset=utf-8').sendFile('index.html');
}

export function requestPath(request: FastifyRequest): string {
  return (request.raw.url ?? '/').split('?')[0]!;
}

export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * Client-side routes (e.g. /time-trial/sunny-meadow) are navigations to paths
 * without a file extension; they receive index.html. API paths, /healthz and
 * anything that looks like a file (a missing asset) never do — a missing
 * script must stay a 404 rather than be cached as HTML.
 */
export function isSpaNavigation(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const path = requestPath(request);
  if (isApiPath(path) || path === '/healthz' || path.startsWith('/assets/')) return false;
  const last = path.slice(path.lastIndexOf('/') + 1);
  return !last.includes('.');
}
