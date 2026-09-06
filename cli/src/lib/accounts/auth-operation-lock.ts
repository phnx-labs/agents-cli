/** Cross-process exclusion for native connect/logout, including browser waits. */
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { ensureLockTarget } from '../fs-atomic.js';
import { getRuntimeStateDir } from '../state.js';
import { isAgentId, type AgentId } from '../types.js';

export function authLockFilePath(agent: AgentId, stateDir?: string): string {
  if (!isAgentId(agent)) throw new Error('Unknown authentication harness.');
  return path.join(stateDir ?? getRuntimeStateDir(), `auth-op-lock-${agent}.json`);
}

export interface AuthOperationLock { release(): void; }

/** Uses the same lock primitive as configuration writes; no fail-open fallback. */
export function acquireAuthOperationLock(agent: AgentId, stateDir?: string): AuthOperationLock {
  const target = authLockFilePath(agent, stateDir);
  ensureLockTarget(target, '{}', 0o700);
  let compromised: Error | null = null;
  let unlock: () => void;
  try {
    unlock = lockfile.lockSync(target, {
      stale: 10 * 60_000,
      // The primitive refreshes the lock while a browser flow awaits input.
      // Acquisition is immediate: never silently queue native logins.
      onCompromised: (error) => { compromised = error; },
    });
  } catch (error) {
    throw new Error(`Cannot safely start ${agent} authentication: another sign-in or sign-out may be in progress. ${(error as Error).message}`);
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try { unlock(); } finally {
        if (compromised) throw new Error(`Authentication lock was lost: ${(compromised as Error).message}`);
      }
    },
  };
}
