import { defineConfig } from 'vite';
import packageInfo from './package.json' with { type: 'json' };

export default defineConfig(({ command }) => ({
  root: 'src/client',
  publicDir: '../../public',
  define: {
    __APP_VERSION__: JSON.stringify(packageInfo.version),
    // ?debug → window.__turbo exists only in QA builds (TURBO_DEBUG_HOOK=1 node tools/build.mjs) and on
    // the local dev server (`npm run dev`, which QA tools default to); release builds compile it out.
    __DEBUG_HOOK__: JSON.stringify(process.env.TURBO_DEBUG_HOOK === '1' || command === 'serve'),
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: '0.0.0.0',
    port: 8200,
    strictPort: true,
    proxy: {
      '^/api(?:/|$)': 'http://127.0.0.1:8201',
      '/healthz': 'http://127.0.0.1:8201',
    },
  },
}));
