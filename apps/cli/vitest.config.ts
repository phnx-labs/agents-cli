import { defineConfig } from 'vitest/config';

// RUSH-2215: Windows CI full suite (~12m) has been observed to finish with
// every test green and still exit 1 because idle vitest forks die
// ("Worker exited unexpectedly"). Cap fork concurrency on win32 so the
// restored full gate stays a real regression signal, not worker-churn noise.
const isWin = process.platform === 'win32';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    ...(isWin ? { maxWorkers: 2, minWorkers: 1 } : {}),
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
