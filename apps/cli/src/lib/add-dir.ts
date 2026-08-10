/**
 * Cross-harness application of project / `--add-dir` directory grants.
 *
 * A multi-repo project binds several checkouts; the primary becomes cwd and the
 * rest become grants so the agent can read and write the siblings. How a grant
 * lands depends on the harness:
 *
 * - `native-flag`  — Claude, Kimi, Cursor: repeatable `--add-dir <path>`
 * - `codex-policy` — Codex: folded into the named edit profile's workspace_roots
 *                    (handled in buildExecCommand / codex-policy, not here)
 * - `grok-sandbox` — Grok: OS sandbox is off by default (siblings already
 *                    writable); when a non-off sandbox is active, write a
 *                    project-local profile with `read_write` and select it.
 *                    Always appends a short `--rules` note so the model knows
 *                    the siblings are in scope.
 * - `none`         — harness has no multi-root surface; grants are ignored
 *                    (caller may warn). Not a configuration mistake — the CLI
 *                    has nowhere to put the grant.
 *
 * Capability honesty: only strategies that actually change the launch count as
 * support. Silent no-ops stay `none`.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import { expandLocalHome } from './project-root.js';

export type AddDirStrategy = 'native-flag' | 'codex-policy' | 'grok-sandbox' | 'none';

/** How each harness consumes directory grants. Keep in lockstep with apply* below. */
export const ADD_DIR_STRATEGY: Record<AgentId, AddDirStrategy> = {
  claude: 'native-flag',
  kimi: 'native-flag',
  cursor: 'native-flag',
  codex: 'codex-policy',
  grok: 'grok-sandbox',
  // No multi-root CLI surface today (single --dir / project path).
  opencode: 'none',
  gemini: 'none',
  pi: 'none',
  openclaw: 'none',
  copilot: 'none',
  amp: 'none',
  kiro: 'none',
  goose: 'none',
  antigravity: 'none',
  droid: 'none',
  hermes: 'none',
  muse: 'none',
  warp: 'none',
};

/** Agents whose launch command is widened by applyAddDirs (excludes codex — policy path). */
export function agentsWithNativeOrGrokAddDir(): AgentId[] {
  return (Object.keys(ADD_DIR_STRATEGY) as AgentId[]).filter(
    (id) => ADD_DIR_STRATEGY[id] === 'native-flag' || ADD_DIR_STRATEGY[id] === 'grok-sandbox',
  );
}

/** Expand `~` / `$HOME` and de-dupe, preserving order. */
export function normalizeAddDirs(dirs: string[] | undefined): string[] {
  if (!dirs?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of dirs) {
    const expanded = expandLocalHome(raw);
    if (!expanded || seen.has(expanded)) continue;
    seen.add(expanded);
    out.push(expanded);
  }
  return out;
}

/**
 * Append native `--add-dir` flags for harnesses that take them (Claude, Kimi, Cursor).
 * No-op for other strategies — call sites route by ADD_DIR_STRATEGY.
 */
export function appendNativeAddDirFlags(cmd: string[], dirs: string[]): void {
  for (const dir of dirs) {
    cmd.push('--add-dir', dir);
  }
}

/** Profile name written into `.grok/sandbox.toml` under the run cwd. */
export const GROK_PROJECT_SANDBOX_PROFILE = 'agents-project';

/**
 * Whether Grok's active sandbox would block writes outside cwd without a
 * widened profile. `off` / unset / `devbox` do not need a custom profile
 * (devbox already writes almost everywhere; off is unrestricted).
 */
export function grokNeedsSandboxWiden(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.GROK_SANDBOX ?? '').trim().toLowerCase();
  if (!raw || raw === 'off') return false;
  if (raw === 'devbox') return false;
  // workspace | read-only | strict | any custom base that extends those
  return true;
}

/**
 * Ensure `.grok/sandbox.toml` under `cwd` defines `[profiles.agents-project]`
 * with `read_write` covering every grant. Returns the profile name to pass as
 * `--sandbox`, or null when no file write was needed / possible.
 *
 * Idempotent: rewrites only the managed profile block.
 */
export function ensureGrokProjectSandboxProfile(
  cwd: string,
  dirs: string[],
): string | null {
  if (!dirs.length) return null;
  if (!cwd) return null;

  const grokDir = path.join(cwd, '.grok');
  const sandboxPath = path.join(grokDir, 'sandbox.toml');

  const readWriteLines = dirs
    .map((d) => `  ${JSON.stringify(d)},`)
    .join('\n');

  const managedBlock = [
    '# BEGIN agents-cli managed — project multi-repo grants (do not edit by hand)',
    `[profiles.${GROK_PROJECT_SANDBOX_PROFILE}]`,
    'extends = "workspace"',
    'read_write = [',
    readWriteLines,
    ']',
    '# END agents-cli managed',
    '',
  ].join('\n');

  let existing = '';
  try {
    existing = fs.readFileSync(sandboxPath, 'utf-8');
  } catch {
    // create fresh
  }

  const begin = '# BEGIN agents-cli managed';
  const end = '# END agents-cli managed';
  let next: string;
  const beginIdx = existing.indexOf(begin);
  const endIdx = existing.indexOf(end);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    // Replace through end of the end-marker line
    const afterEnd = existing.indexOf('\n', endIdx);
    const endCut = afterEnd === -1 ? existing.length : afterEnd + 1;
    next = existing.slice(0, beginIdx) + managedBlock + existing.slice(endCut);
  } else if (existing.trim()) {
    next = existing.replace(/\s*$/, '\n\n') + managedBlock;
  } else {
    next = managedBlock;
  }

  fs.mkdirSync(grokDir, { recursive: true });
  fs.writeFileSync(sandboxPath, next, 'utf-8');
  return GROK_PROJECT_SANDBOX_PROFILE;
}

/** Short rules blob so Grok's model treats sibling dirs as in-scope. */
export function grokAddDirRules(dirs: string[]): string {
  const list = dirs.map((d) => `- ${d}`).join('\n');
  return [
    'Project sibling directories (part of this multi-repo project; read + write):',
    list,
    'Treat these as first-class workspace roots alongside the primary cwd.',
  ].join('\n');
}

/**
 * Apply directory grants on the argv for harnesses handled here.
 * Codex is intentionally excluded — its path lives next to codexPolicyArgs.
 *
 * @returns true when any argv / on-disk change was made for the grants
 */
export function applyAddDirs(
  agent: AgentId,
  cmd: string[],
  dirs: string[] | undefined,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const normalized = normalizeAddDirs(dirs);
  if (normalized.length === 0) return false;

  const strategy = ADD_DIR_STRATEGY[agent];
  if (strategy === 'native-flag') {
    appendNativeAddDirFlags(cmd, normalized);
    return true;
  }

  if (strategy === 'grok-sandbox') {
    // Model awareness always — even when the OS sandbox is off.
    cmd.push('--rules', grokAddDirRules(normalized));
    const env = opts.env ?? process.env;
    if (grokNeedsSandboxWiden(env)) {
      const cwd = opts.cwd ?? process.cwd();
      const profile = ensureGrokProjectSandboxProfile(cwd, normalized);
      if (profile) {
        // Drop a prior --sandbox <x> pair so the widened profile wins.
        for (let i = cmd.length - 2; i >= 0; i--) {
          if (cmd[i] === '--sandbox') {
            cmd.splice(i, 2);
          }
        }
        cmd.push('--sandbox', profile);
      }
    }
    return true;
  }

  // codex-policy / none — not applied here
  return false;
}

/** Whether this harness effectively consumes directory grants. */
export function supportsAddDir(agent: AgentId): boolean {
  const s = ADD_DIR_STRATEGY[agent];
  return s === 'native-flag' || s === 'codex-policy' || s === 'grok-sandbox';
}

/** One-line note for harnesses that ignore grants (used by callers that want to warn). */
export function addDirUnsupportedNote(agent: AgentId): string | null {
  if (supportsAddDir(agent)) return null;
  return (
    `${agent} has no multi-root / --add-dir surface; project sibling directory ` +
    `grants are ignored (cwd only). Claude, Codex, Cursor, Kimi, and Grok consume them.`
  );
}

