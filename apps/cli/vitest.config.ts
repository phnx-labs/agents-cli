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
    // RUSH-2215 / Windows CI: full suite can finish 0 failed tests but still
    // exit 1 when 1–2 fork workers die after teardown (vitest "Unhandled Errors").
    // That hides real assertion failures. Ignore unhandled pool errors only on
    // win32 so the Windows gate tracks test outcomes, not orphan-worker noise.
    ...(process.platform === 'win32'
      ? { dangerouslyIgnoreUnhandledErrors: true, hookTimeout: 60_000 }
      : {}),
  },
});
