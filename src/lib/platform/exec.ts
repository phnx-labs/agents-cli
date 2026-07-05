/**
 * Executable resolution, platform-aware.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

/** PATH-search command for the platform: `where` on Windows, else `which`. */
export function whichCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'where' : 'which';
}

/**
 * Does spawning `binary` require `shell: true` on this platform?
 *
 * On Windows a `.cmd`/`.bat` wrapper (npm.cmd, bun.cmd, the agent shims) cannot
 * be exec'd directly — `spawn`/`execFile` look for a literal executable and miss
 * the PATHEXT/cmd-interpreter step, surfacing as `ENOENT`/`EINVAL`. A bare
 * command name (not an absolute path) needs the same PATHEXT resolution. Both
 * cases require the shell. Always false off Windows, where direct exec is right.
 */
export function needsWindowsShell(binary: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  // path.win32.isAbsolute, not path.isAbsolute: the latter uses the HOST's rules,
  // so a Windows path would read as relative when this runs on a Linux CI host.
  return !path.win32.isAbsolute(binary) || /\.(cmd|bat)$/i.test(binary);
}

/**
 * Resolve an executable name to its absolute path via the OS PATH search, or
 * `null` if not found. On Windows `where` can return several lines (one per
 * PATHEXT match, e.g. `agents.cmd` and `agents.ps1`) — the first is the one the
 * shell would actually run, matching `which` semantics on POSIX.
 */
export function findExecutable(name: string, platform: NodeJS.Platform = process.platform): string | null {
  try {
    const out = execFileSync(whichCommand(platform), [name], { encoding: 'utf-8' });
    const first = out.trim().split(/\r?\n/)[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

/**
 * Quote one argument for a Windows `cmd.exe` command line, as built by Node's
 * `spawn(..., { shell: true })` on win32 (the `.cmd` agent shims, `agents secrets
 * exec`, ...). cmd.exe does NO quoting of its own, so an unquoted arg with a space
 * is split into several args, and a cmd metacharacter (`&|<>()^`) would be
 * interpreted by the shell. We wrap any arg with whitespace, a quote, or a
 * metacharacter in double quotes and escape embedded quotes / trailing
 * backslashes per the CommandLineToArgvW rules, so the *child's* argv parse
 * reconstructs the original argument.
 *
 * CAVEAT: cmd.exe expands `%VAR%` (always) and `!VAR!` (under delayed expansion)
 * BEFORE argv parsing, and double-quoting does NOT suppress `%`/`!` (the
 * "BatBadBut" / CVE-2024-1874 class). We deliberately do not escape `%`/`!`:
 * the callers here run a command whose `%`/`!`-bearing tokens are the caller's
 * own (an agent prompt against the caller's shell, a bundle the caller owns), so
 * caller-controlled `%`/`!` is not a privilege boundary. If that ever changes
 * (composing an untrusted command line), route through a shell that disables
 * expansion rather than relying on this quoter. An empty arg becomes `""`.
 */
export function quoteWin32ExecArg(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>()^]/.test(arg)) return arg;
  let result = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      // Double the run of backslashes, then escape this quote.
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  // Trailing backslashes precede the closing quote → must be doubled.
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

/**
 * Compose a DEP0190-safe Windows shell command line from a command and its args.
 *
 * Node's `spawn(cmd, args, { shell: true })` on win32 concatenates `cmd` and
 * every element of `args` into a single cmd.exe line WITHOUT escaping — that is
 * both Node's DEP0190 deprecation (a future hard error) and a real injection
 * surface, since user-controlled text (an agent prompt, a secrets-exec command)
 * flows through `args`. Passing the fully-composed line as the SOLE `command`
 * with an EMPTY args array sidesteps both: we quote every token with
 * `quoteWin32ExecArg` so the child's CommandLineToArgvW parse reconstructs the
 * exact original argv, and Node has no args array left to concatenate.
 *
 * Callers spawn the result as `spawn(line, [], { shell: true })`. A simple arg
 * (no whitespace/quote/metachar) is passed through untouched, so the composed
 * line is byte-identical to the old unquoted join for the common case.
 */
export function composeWin32CommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteWin32ExecArg).join(' ');
}
