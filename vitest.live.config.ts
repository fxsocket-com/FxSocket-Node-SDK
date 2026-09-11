import { defineConfig } from 'vitest/config';

// Integration tests that talk to the real FxSocket API.
// Opt in with FXSOCKET_API_KEY (plus FXSOCKET_TEST_* account credentials).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live/**/*.live.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
