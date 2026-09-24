#!/usr/bin/env node
/**
 * Production build.
 *   1. vite build            → dist/client (index.html + content-hashed assets/)
 *   2. esbuild server bundle → dist/server/index.js + dist/server/verify-worker.js
 *      (node22 ESM, every dependency inlined so the runtime image needs no node_modules)
 *   3. dist/build.json       → { version, id, builtAt } (id = hash of every built file)
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);

const started = Date.now();
const pkg = JSON.parse(await readFile('package.json', 'utf8'));

await viteBuild({ configFile: path.join(root, 'vite.config.ts'), logLevel: 'info', mode: 'production' });

await rm('dist/server', { recursive: true, force: true });
await esbuild({
  entryPoints: {
    index: 'src/server/index.ts',
    'verify-worker': 'src/server/verify-worker.ts',
  },
  outdir: 'dist/server',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  minify: false,
  keepNames: true,
  legalComments: 'none',
  // Bundled CommonJS dependencies (fastify, AWS SDK) call require(); give ESM one.
  banner: {
    js: "import { createRequire as __turboCreateRequire } from 'node:module'; const require = __turboCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// ── PWA: stamp the shell with the client build id, then bundle the service worker ──
{
  const shellFiles = (await listFiles('dist/client')).filter(f => !/(^|[\\/])(sw\.js|build\.json)$/.test(f)).sort();
  const cdigest = createHash('sha256');
  for (const file of shellFiles) {
    cdigest.update(file.split(path.sep).join('/'));
    cdigest.update('\0');
    cdigest.update(await readFile(file));
  }
  // a worker-only change must still produce a new build id (new cache name, new update)
  for (const src of ['src/client/sw.ts', 'src/client/sw-policy.ts']) cdigest.update(await readFile(src));
  const clientId = cdigest.digest('hex').slice(0, 16);
  const htmlPath = 'dist/client/index.html';
  let html = await readFile(htmlPath, 'utf8');
  const meta = `<meta name="turbo-pals-build" content="${clientId}" />`;
  html = /<meta name="turbo-pals-build"[^>]*>/.test(html)
    ? html.replace(/<meta name="turbo-pals-build"[^>]*>/, meta)
    : html.replace(/<head>/i, `<head>\n    ${meta}`);
  await writeFile(htmlPath, html);
  await writeFile('dist/client/build.json', `${JSON.stringify({ id: clientId, version: pkg.version })}\n`);
  const precache = [
    ...shellFiles.map(f => '/' + path.relative('dist/client', f).split(path.sep).join('/')),
    '/build.json',
  ]
    .filter(p => !p.startsWith('/dev/'))
    // every browser that runs a service worker takes the woff2 source of each @font-face
    .filter(p => !p.endsWith('.woff'));
  await esbuild({
    entryPoints: ['src/client/sw.ts'],
    outfile: 'dist/client/sw.js',
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
    define: {
      __PRECACHE__: JSON.stringify(precache),
      __BUILD__: JSON.stringify(clientId),
      __VERSION__: JSON.stringify(pkg.version),
    },
    logLevel: 'warning',
  });
  console.log(`PWA: service worker precaches ${precache.length} files for client build ${clientId}`);
}

const clientFiles = await listFiles('dist/client');
const serverFiles = await listFiles('dist/server');
const digest = createHash('sha256');
for (const file of [...clientFiles, ...serverFiles].sort()) {
  digest.update(file.split(path.sep).join('/'));
  digest.update('\0');
  digest.update(await readFile(file));
}
const id = digest.digest('hex').slice(0, 16);

await mkdir('dist', { recursive: true });
await writeFile('dist/build.json', `${JSON.stringify({
  version: pkg.version,
  id,
  builtAt: new Date().toISOString(),
}, null, 2)}\n`);

const kib = async files => {
  let bytes = 0;
  for (const file of files) bytes += (await readFile(file)).byteLength;
  return `${(bytes / 1024).toFixed(0)} KiB`;
};
console.log(`TURBO PALS GRAND PRIX ${pkg.version} · build ${id} · client ${clientFiles.length} files (${await kib(clientFiles)}) · server ${await kib(serverFiles)} · ${((Date.now() - started) / 1000).toFixed(1)} s`);
