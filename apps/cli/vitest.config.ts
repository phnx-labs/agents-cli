import { defineConfig } from 'vitest/config';
import { shouldEnableCiTestProfile } from './tests/hermetic-guards';

// RUSH-2215: a large vitest forks suite can finish every test green and
// still exit 1 because idle workers die ("Worker exited unexpectedly").
// Measured on Windows CI (~12m) and on Linux selected CI (#2622, 863 files /
// 12206 tests passed, 0 failed, then exit 1 — three times). Cap fork
// concurrency on win32; ignore unhandled pool errors on win32 and in CI
// so the required check tracks test outcomes, not orphan-worker noise.
//
// RUSH-3007: this profile is also what release-attestation-produce.sh needs
// under load (RUSH-2970 trap 5a), which is why it's gated on
// shouldEnableCiTestProfile() rather than a bare `process.env.CI === 'true'`
// — see tests/hermetic-guards.ts for why that flag exists and must stay
// decoupled from tests/setup.ts's real-~/.agents leak tripwires.
const isWin = process.platform === 'win32';
const ignoreUnhandledPoolErrors = isWin || shouldEnableCiTestProfile(process.env);

// RUSH-3081/RUSH-3015: the attestation producer (release-attestation-produce.sh,
// AGENTS_ATTEST_PRODUCER=1) runs the FULL suite on the signing Mac (mac-mini),
// which is a shared box usually under concurrent load. With the default forks
// pool spawning a worker per core, these real-CLI / real-service integration
// tests contend on shared state and flake (1-2 different tests per run out of
// ~13k) and workers OOM/crash — observed failing ~every producer run across ~10
// attempts, blocking releases. Cap producer concurrency so the suite runs stably
// enough to attest. Only the producer is affected (a signing-Mac full-suite run);
// normal CI on dedicated crabboxes (CI=true, not AGENTS_ATTEST_PRODUCER) keeps
// full parallelism and its 90s budget.
const isAttestProducer = process.env.AGENTS_ATTEST_PRODUCER === '1';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    ...(isWin ? { maxWorkers: 2, minWorkers: 1 } : {}),
    ...(isAttestProducer && !isWin ? { maxWorkers: 4, minWorkers: 1 } : {}),
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
