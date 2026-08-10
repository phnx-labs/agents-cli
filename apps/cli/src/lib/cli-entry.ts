/**
 * Resolve how to re-invoke THIS `agents` CLI as a child process, correctly across
 * both install shapes:
 *
 *   1. **JS install** — `agents` is a `dist/index.js` (or a symlink / `#!node`
 *      shim to it). `process.execPath` is `node`, `process.argv[1]` is the script.
 *      Relaunch as `node <entry> <sub…>`.
 *   2. **Bun standalone binary** (#315) — `agents` is a compiled Mach-O/ELF/PE.
 *      `process.execPath` is the physical signed binary, and `process.argv[1]` is
 *      the *virtual* embedded entry `/$bunfs/root/agents`, which Bun reports as an
 *      existing path. Passing that virtual path as an argv element makes the CLI
 *      receive it as a subcommand and die with `unknown command '/$bunfs/root/agents'`.
 *      Relaunch by executing the physical binary directly: `<binary> <sub…>`.
 *
 * Both `getDaemonLaunch` (daemon.ts) and the secrets-broker `cliSpawn`
 * (secrets/agent.ts) route through here so the two never drift. This module is a
 * leaf — it imports nothing from `lib/` — so it can be pulled into either without
 * an import cycle (daemon.ts ↔ secrets/agent.ts already form one).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const BUN_VIRTUAL_ROOT = /[/\\]\$bunfs[/\\]root[/\\]/;

function resolveBunStandaloneEntry(entry: string, execPath: string): string {
  if (!BUN_VIRTUAL_ROOT.test(entry)) return entry;
  if (!execPath || BUN_VIRTUAL_ROOT.test(execPath) || !fs.existsSync(execPath)) {
    throw new Error(
      `Cannot resolve agents CLI: Bun standalone executable not found at ${execPath || '(empty path)'}`,
    );
  }
  return execPath;
}

export function getAgentsBinPath(
  argv1: string | undefined = process.argv[1],
  execPath: string = process.execPath,
): string {
  // Prefer the binary actively executing this code. `which agents` returns
  // whatever happens to be first on PATH, which means a side-by-side dev
  // build at ~/.local/bin would silently spawn the registry-installed
  // daemon and run stale code. For a JS install, process.argv[1] is the
  // absolute entrypoint the user actually invoked. A Bun standalone instead
  // exposes its embedded /$bunfs/root entry at argv[1] and its physical signed
  // executable at process.execPath; Bun reports both as existing paths.
  const runningEntry = argv1 ? resolveBunStandaloneEntry(argv1, execPath) : undefined;
  if (runningEntry && fs.existsSync(runningEntry)) {
    // The package's browser/computer entrypoints are sibling shims without a
    // `daemon` command. A daemon started as their IPC side effect must launch
    // through the main agents entrypoint instead of replaying the shim path.
    const entryName = path.basename(runningEntry);
    const compiledShim = /^(browser|computer)\.(c|m)?js$/.test(entryName);
    const installedShim = /^(browser|computer)$/.test(entryName);
    if (compiledShim || installedShim) {
      const agentsEntry = path.join(path.dirname(runningEntry), compiledShim ? 'index.js' : 'agents');
      if (!fs.existsSync(agentsEntry)) {
        throw new Error(`Cannot start agents daemon: main CLI entry not found at ${agentsEntry}`);
      }
      return agentsEntry;
    }
    return runningEntry;
  }
  try {
    return execFileSync('which', ['agents'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'agents';
  }
}

/**
 * Directory that contains the `agents` launcher usable for PATH resolution.
 *
 * When the running entry IS the launcher (a compiled binary or an extension-less
 * shim named `agents`), this is just `dirname(getAgentsBinPath())`. When the
 * running entry is a script inside `dist/` reached via a symlink/shim elsewhere
 * (the npm global-install shape), we look for a launcher whose realpath points at
 * the same entry and return that launcher's directory. Falls back to the entry's
 * own directory when no launcher is found.
 */
export function getAgentsBinDir(): string {
  const bin = getAgentsBinPath();
  const base = path.basename(bin);
  if (base === 'agents' || base === 'agents.exe' || base === 'agents.cmd') {
    return path.dirname(bin);
  }
  const realBin = (() => {
    try { return fs.realpathSync(bin); }
    catch { return bin; }
  })();
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.dirname(process.execPath),
  ];
  for (const dir of candidates) {
    for (const name of ['agents', 'agents.exe', 'agents.cmd']) {
      const launcher = path.join(dir, name);
      try {
        if (fs.realpathSync(launcher) === realBin) return dir;
      } catch { /* ignore */ }
    }
  }
  return path.dirname(bin);
}

/**
 * A CLI entry must be launched through the Node runtime when it is a Node
 * script — a `.js`/`.cjs`/`.mjs` file, OR a symlink/extension-less shim whose
 * shebang names `node`. Package installs link `bin/agents` to a `dist/index.js`
 * (a symlink) or drop an extension-less `#!/usr/bin/env node` shim, so an
 * extension check alone misses them and they get run directly. A real compiled
 * binary (Mach-O/ELF/PE) has no `#!node` shebang, so it takes the direct branch
 * and owns its own runtime resolution.
 */
export function isNodeScriptEntry(agentsBin: string): boolean {
  let resolved = agentsBin;
  try {
    resolved = fs.realpathSync(agentsBin);
  } catch {
    // Unresolvable (e.g. a template path that does not exist on this box): fall
    // back to the extension check on the path as given.
  }
  if (/\.(c|m)?js$/.test(resolved)) return true;
  try {
    const fd = fs.openSync(resolved, 'r');
    try {
      const buf = Buffer.alloc(128);
      const n = fs.readSync(fd, buf, 0, 128, 0);
      const firstLine = buf.toString('utf-8', 0, n).split('\n', 1)[0];
      return firstLine.startsWith('#!') && /\bnode\b/.test(firstLine);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Build the `{ command, args }` to re-invoke this CLI with `sub` as its argv,
 * resolving the JS-vs-standalone shape above. This is the single primitive behind
 * both the daemon launch and the secrets-broker spawn — never hand-roll
 * `[process.execPath, process.argv[1], …]`, which appends the bun virtual entry
 * as a bogus subcommand on standalone builds.
 */
export function getCliLaunch(
  sub: string[],
  agentsBin: string = getAgentsBinPath(),
): { command: string; args: string[] } {
  // Resolve a bun virtual entry to the physical executable even when a caller
  // passes agentsBin explicitly (getAgentsBinPath already does this for the
  // default), so a `/$bunfs/root/agents` never becomes the command or an argv.
  const bin = resolveBunStandaloneEntry(agentsBin, process.execPath);
  if (isNodeScriptEntry(bin)) {
    return { command: process.execPath, args: [bin, ...sub] };
  }
  return { command: bin, args: [...sub] };
}
