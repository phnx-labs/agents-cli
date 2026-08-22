/**
 * RUSH-3007: `CI` used to control two independent things at once:
 *
 *  1. vitest.config.ts's extended hookTimeout / ignore-pool-error profile —
 *     wanted on any noisy/loaded box, including release-attestation-produce.sh
 *     (RUSH-2970 trap 5a: under load, `tmux/binary.test.ts` and the 10s
 *     beforeEach hookTimeout in git.test.ts / release-lease.test.ts flake at
 *     the default timeout).
 *  2. tests/setup.ts's leak tripwires, which assert the REAL ~/.agents did
 *     not change during the run — valid ONLY on a genuine CI runner with no
 *     concurrent writer to that machine's real home.
 *
 * Cutting 1.22.44, the operator exported CI=true by hand to get (1) on
 * mac-mini, which also armed (2) against a box with a live daemon and active
 * sessions: 129/129 test files false-failed on hermeticity-guard trips while
 * every individual test (12,559/12,559) passed. RUSH-2970 and RUSH-3007 gave
 * conflicting advice from the same root cause — CI meaning two things.
 *
 * AGENTS_ATTEST_PRODUCER=1 is the producer's own explicit opt-in: it wants
 * (1) without (2). A genuine CI runner (GitHub Actions, etc.) never sets it,
 * so its behavior is unchanged — these two functions agree with the old bare
 * `process.env.CI` checks whenever AGENTS_ATTEST_PRODUCER is unset.
 */

/** vitest.config.ts: should this run get the extended-timeout test profile? */
export function shouldEnableCiTestProfile(env: NodeJS.ProcessEnv): boolean {
  return env.CI === 'true' || env.AGENTS_ATTEST_PRODUCER === '1';
}

/** tests/setup.ts: should the real-~/.agents leak tripwires arm this run? */
export function shouldArmHermeticGuards(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CI) && env.AGENTS_ATTEST_PRODUCER !== '1';
}
