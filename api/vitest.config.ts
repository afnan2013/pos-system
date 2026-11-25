import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/support/setup.ts'],
    // Postgres containers start in beforeAll and can take a while on a cold image cache.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
