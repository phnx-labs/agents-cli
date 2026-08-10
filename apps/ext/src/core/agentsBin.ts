// Resolve the absolute path to the `agents` CLI binary and run commands
// against it.
//
// VS Code Electron processes (Cursor, Code, Codium) launched from Dock or
// Finder inherit a minimal PATH that doesn't include the user's nvm bin or
// `~/.agents/shims`. Calling `execAsync('agents ...')` directly fails with
// "command not found" even though the user's terminal has it. This module
// resolves the binary once via the shell + filesystem probes, then runs all
// subsequent commands with an absolute path and a bootstrapped PATH that
// includes node so the `#!/usr/bin/env node` shebang resolves.

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execAsync = promisify(exec);
const CACHE_TTL_MS = 60_000;

let cachedBin: string | undefined;
let cachedAt = 0;

export class AgentsBinNotFoundError extends Error {
  constructor() {
    super('agents CLI not found on PATH or in common install locations (~/.agents/shims, nvm bins, /opt/homebrew/bin, /usr/local/bin)');
    this.name = 'AgentsBinNotFoundError';
  }
}

/**
 * Resolve the absolute path to the `agents` CLI binary. Cached for 60s.
 *
 * Order of attempts:
 *   1. `$SHELL -c 'command -v agents'` (non-login so .zshenv loads nvm
 *      without /etc/zprofile prepending stale brew paths).
 *   2. Filesystem probes: ~/.agents/shims/agents, nvm bins (newest first),
 *      /opt/homebrew/bin/agents, /usr/local/bin/agents.
 *
 * Throws AgentsBinNotFoundError if no candidate exists as a file.
 */
export async function resolveAgentsBin(): Promise<string> {
  // Test/escape hatch: explicitly mark agents-cli as unavailable. Lets tests
  // simulate the missing-CLI fallback without playing PATH games (the regular
  // resolver intentionally ignores PATH so it works from the VS Code host).
  if (process.env.AGENTS_CLI_DISABLED === '1') {
    throw new AgentsBinNotFoundError();
  }
  if (cachedBin && Date.now() - cachedAt < CACHE_TTL_MS) return cachedBin;

  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const { stdout } = await execAsync(`${shell} -c 'command -v agents'`, { timeout: 5_000 });
    const p = stdout.trim();
    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
      cachedBin = p;
      cachedAt = Date.now();
      return p;
    }
  } catch {
    /* fall through to filesystem probes */
  }

  const candidates: string[] = [path.join(os.homedir(), '.agents', 'shims', 'agents')];
  try {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
    const versions = fs.readdirSync(nvmDir).sort().reverse();
    for (const v of versions) candidates.push(path.join(nvmDir, v, 'bin', 'agents'));
  } catch {
    /* no nvm */
  }
  candidates.push('/opt/homebrew/bin/agents', '/usr/local/bin/agents');

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
      cachedBin = p;
      cachedAt = Date.now();
      return p;
    } catch {
      /* next */
    }
  }

  throw new AgentsBinNotFoundError();
}

/** Build a PATH that lets the agents shebang find node. */
export function bootstrapPath(binPath: string): string {
  const dirs = [path.dirname(binPath)];
  try {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
    const versions = fs.readdirSync(nvmDir).sort().reverse();
    if (versions[0]) dirs.push(path.join(nvmDir, versions[0], 'bin'));
  } catch {
    /* no nvm */
  }
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  return [...new Set(dirs)].join(':');
}

export interface RunAgentsOptions {
  timeout?: number;
  maxBuffer?: number;
  cwd?: string;
}

/**
 * Run `agents <args>` using the resolved absolute binary path and a PATH
 * that includes node so the shebang resolves. Throws if the binary can't
 * be found.
 *
 * Pass arguments as a single string (the same way you'd type them after
 * `agents` on the command line). Quote your own args if they contain
 * shell metacharacters.
 */
export async function runAgents(
  args: string,
  options: RunAgentsOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const bin = await resolveAgentsBin();
  const augmented = bootstrapPath(bin);
  const escaped = `'${bin.replace(/'/g, `'\\''`)}'`;
  return execAsync(`${escaped} ${args}`, {
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    cwd: options.cwd,
    env: { ...process.env, PATH: `${augmented}:${process.env.PATH ?? ''}` },
  });
}

/** Test-only: drop the cached path so the next call re-resolves. */
export function clearAgentsBinCache(): void {
  cachedBin = undefined;
  cachedAt = 0;
}
