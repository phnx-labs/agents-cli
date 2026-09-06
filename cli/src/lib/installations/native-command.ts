import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { AgentId } from '../types.js';
import { composeWin32CommandLine } from '../platform/index.js';
import { getBinaryPath } from './store.js';
import { withInstallationLease } from './launch-gate.js';

/** Run a finite native login/logout command in an already-selected home. */
export async function runNativeAccountCommand(
  agent: AgentId, label: string, args: string[], env: NodeJS.ProcessEnv,
): Promise<{ code: number | null }> {
  return withInstallationLease(agent, label, () => new Promise((resolve, reject) => {
    let binary = getBinaryPath(agent, label);
    if (process.platform === 'win32' && fs.existsSync(`${binary}.cmd`)) binary += '.cmd';
    const shell = process.platform === 'win32' && binary.endsWith('.cmd');
    const child = spawn(shell ? composeWin32CommandLine(binary, args) : binary, shell ? [] : args, {
      env, stdio: 'inherit', shell,
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code }));
  }));
}
