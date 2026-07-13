import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    // Hermeticity (#910): every fork gets a temp-pinned broker socket, events
    // sink, and broker-off defaults BEFORE the test file's imports run.
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 30000,
  },
});
