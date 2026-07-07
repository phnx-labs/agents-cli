/**
 * Worktree-per-terminal helper.
 *
 * When the `agents.worktreePerTerminal` workspace setting is enabled, every
 * new agent terminal (Cmd+Shift+A/B/H/V/J/K) is started in its own git
 * worktree at <repo>/.history/worktrees/<terminal-id> on branch
 * agent/<terminal-id>. This isolates parallel agents so their uncommitted
 * work doesn't appear in each other's `git status`.
 *
 * The actual `git worktree add/remove` runs in agents-cli (`agents worktree
 * provision|release|prune`) so the policy lives in one place. This module
 * just shells out and reports a path back to the terminal-creation code.
 *
 * The setting defaults to OFF. When OFF, every helper here returns the
 * workspace root unchanged, so existing terminal-spawn paths behave as before.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';

const AGENTS_CLI_TIMEOUT_MS = 8000;

function isWorktreePerTerminalEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('agents')
    .get<boolean>('worktreePerTerminal', false);
}

function runAgentsCli(args: string[], opts: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'agents',
      args,
      { timeout: opts.timeoutMs ?? AGENTS_CLI_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          // err.message already includes stderr context from execFile; surface
          // both so callers can decide whether to warn or fall through.
          reject(new Error(`agents ${args.join(' ')} failed: ${err.message}${stderr ? `\n${stderr}` : ''}`));
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    );
  });
}

function fetchOrigin(root: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('git', ['fetch', 'origin'], { cwd: root, timeout: AGENTS_CLI_TIMEOUT_MS }, () => {
      // Best-effort: ignore errors so provisioning proceeds with stale refs.
      resolve();
    });
  });
}

/**
 * If the worktree-per-terminal setting is on, provision a worktree for this
 * terminal and return its path. Otherwise (or on any failure) return the
 * workspace folder unchanged so the caller never breaks.
 *
 * Callers should pass the same terminal-id they put in the terminal's env
 * vars (AGENT_TERMINAL_ID), so the worktree can be released cleanly later.
 */
export async function resolveTerminalCwd(
  workspaceFolder: string,
  terminalId: string
): Promise<{ cwd: string; isolated: boolean }> {
  if (!isWorktreePerTerminalEnabled()) {
    return { cwd: workspaceFolder, isolated: false };
  }
  try {
    // Freshness: fetch origin before provisioning so a new cross-host worktree
    // is based on the latest origin state, not a stale local ref. Best-effort —
    // never block provisioning if the fetch fails (offline, no remote, etc.).
    await fetchOrigin(workspaceFolder);
    const { stdout } = await runAgentsCli([
      'worktree',
      'provision',
      terminalId,
      '--root',
      workspaceFolder,
    ]);
    const wtPath = stdout.trim();
    if (!wtPath) {
      throw new Error('agents worktree provision returned empty path');
    }
    return { cwd: wtPath, isolated: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showWarningMessage(
      `Worktree provisioning failed; using workspace root. Disable agents.worktreePerTerminal to silence this. (${msg})`
    );
    return { cwd: workspaceFolder, isolated: false };
  }
}

/**
 * Fire-and-forget lazy release attempt. Only removes if the worktree is
 * clean AND its branch is merged into origin/main AND it has no unpushed
 * commits — i.e. it would have been safe to never create it. If any check
 * fails, the worktree stays on disk and `agents worktree prune` can revisit
 * later.
 *
 * Never throws. Failures are logged to the console; this should never block
 * terminal teardown or surface user-visible errors.
 */
export function tryReleaseWorktreeForTerminal(
  workspaceFolder: string,
  terminalId: string
): void {
  if (!isWorktreePerTerminalEnabled()) return;
  void runAgentsCli([
    'worktree',
    'release',
    terminalId,
    '--root',
    workspaceFolder,
  ]).catch((err) => {
    console.warn(`[worktree] release ${terminalId} skipped: ${err instanceof Error ? err.message : String(err)}`);
  });
}
