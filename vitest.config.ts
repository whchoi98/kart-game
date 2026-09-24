import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // CDK synth in beforeAll can exceed vitest's 10 s default on a busy build host
    hookTimeout: 120_000,
    maxWorkers: 4,
  },
});
