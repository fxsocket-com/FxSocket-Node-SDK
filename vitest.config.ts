import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/live/**'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // types.ts is declarations only — no runtime code to cover.
      exclude: ['src/types.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
