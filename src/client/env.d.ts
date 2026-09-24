/**
 * Compile-time constants injected by Vite `define` (vite.config.ts, tools/vite-qa.config.mjs).
 *   __APP_VERSION__  package.json version
 *   __DEBUG_HOOK__   true only in QA builds (TURBO_DEBUG_HOOK=1 node tools/build.mjs, or the QA dev
 *                    server): exposes window.__turbo for ?debug. Release builds strip the hook entirely.
 */
declare const __APP_VERSION__: string;
declare const __DEBUG_HOOK__: boolean;
