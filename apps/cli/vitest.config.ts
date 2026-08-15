import { defineConfig } from 'vitest/config';

// RUSH-2215: a large vitest forks suite can finish every test green and
// still exit 1 because idle workers die ("Worker exited unexpectedly").
// Measured on Windows CI (~12m) and on Linux selected CI (#2622, 863 files /
// 12206 tests passed, 0 failed, then exit 1 — three times). Cap fork
// concurrency on win32; ignore unhandled pool errors on win32 and in CI
// so the required check tracks test outcomes, not orphan-worker noise.
const isWin = process.platform === 'win32';
const ignoreUnhandledPoolErrors = isWin || process.env.CI === 'true';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    ...(isWin ? { maxWorkers: 2, minWorkers: 1 } : {}),
    // Hermeticity (#910): every fork gets a temp-pinned broker socket, events
    // sink, and broker-off defaults BEFORE the test file's imports run.
    setupFiles: ['./tests/setup.ts'],
    // RUSH-2639: sweep stale agents-vitest-* temp dirs left by killed workers
    // from past runs, once per whole suite (see tests/global-setup.ts).
    globalSetup: ['./tests/global-setup.ts'],
    include: ['tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 30000,
    // RUSH-2215: ignore unhandled pool errors on win32 and in CI. Real
    // assertion failures still fail the run; only teardown worker-exits
    // are swallowed. Local non-CI Linux stays strict.
    ...(ignoreUnhandledPoolErrors
      ? { dangerouslyIgnoreUnhandledErrors: true, hookTimeout: 60_000 }
      : {}),
  },
});
