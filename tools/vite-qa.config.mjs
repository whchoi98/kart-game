// QA dev server: same app as vite.config.ts but without HMR/file watching, so edits made
// by other engineers don't reload a page in the middle of a screenshot run.
// Usage: npx vite --config tools/vite-qa.config.mjs --port <PORT> --strictPort
// Restart the server after changing source files you want to see.
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export default defineConfig({
  root: 'src/client',
  publicDir: '../../public',
  // the QA server always exposes the ?debug hook (window.__turbo) used by tools/qa-screens.ts & co.
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __DEBUG_HOOK__: 'true' },
  server: {
    host: '127.0.0.1',
    hmr: false,
    watch: { ignored: ['**/*'] },
    // keep the browser's Host/Origin so the server's origin allow-list accepts POST /api/runs
    proxy: {
      '^/api(?:/|$)': { target: 'http://127.0.0.1:8201', changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:8201', changeOrigin: false },
    },
  },
  logLevel: 'warn',
});
