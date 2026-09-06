import * as fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import type { AgentId } from '../types.js';
import { composeWin32CommandLine } from '../platform/index.js';
import { getBinaryPath } from './store.js';
import { withInstallationLease } from './launch-gate.js';

/** Run a finite native login/logout command in an already-selected home. */
export async function runNativeAccountCommand(
  agent: AgentId, label: string, args: string[], env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ code: number | null }> {
  return withInstallationLease(agent, label, () => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let binary = getBinaryPath(agent, label);
    if (process.platform === 'win32' && fs.existsSync(`${binary}.cmd`)) binary += '.cmd';
    const shell = process.platform === 'win32' && binary.endsWith('.cmd');
    const child = spawn(shell ? composeWin32CommandLine(binary, args) : binary, shell ? [] : args, {
      env, stdio: 'inherit', shell,
    });
    let failure: Error | undefined;
    const abort = () => {
      failure = signal?.reason instanceof Error ? signal.reason : new Error('Authentication was cancelled.');
      // A Windows .cmd wrapper is a process tree: killing only cmd.exe leaves
      // the native login alive. Scope termination to this child that we own.
      if (process.platform === 'win32' && child.pid) {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      } else {
        child.kill('SIGTERM');
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    // An AbortError is not completion: keep the installation lease until the
    // native process has actually closed.
    child.once('error', (error) => { failure = error; });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ code });
    });
  }));
}
