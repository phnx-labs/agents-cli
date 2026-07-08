/**
 * Pure argv helpers for `--host` passthrough — build the remote `agents …`
 * invocation and strip the local-only routing flags before forwarding.
 *
 * Kept free of any SSH/process side effects so the two-layer quoting and the
 * flag-stripping edge cases (glued short forms, `=value`, variadic) are unit
 * testable without a live host. The transport itself lives in `ssh-exec.ts`
 * (`sshExec`/`sshStream`); orchestration lives in `passthrough.ts`.
 */

import { shellQuote } from '../ssh-exec.js';

/** A flag to strip from a forwarded argv, with whether it consumes a value. */
export interface StripSpec {
  /** Long form without leading dashes, e.g. `host`, `remote-cwd`. */
  long: string;
  /** Optional single-letter short form without the dash, e.g. `H`. */
  short?: string;
  /** True when the flag takes a following value token (`--host <name>`). */
  takesValue: boolean;
}

/**
 * Remove routing flags (and their values) from a command's args, leaving the
 * rest untouched and in order so they forward verbatim to the remote binary.
 * Handles every form commander accepts: `--host h`, `--host=h`, `-H h`, `-H=h`,
 * and the glued short form `-Hh`.
 *
 * @param args the command's args (already past the command name).
 */
export function stripRoutingFlags(args: string[], specs: StripSpec[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const spec = specs.find((s) => {
      if (a === `--${s.long}` || a.startsWith(`--${s.long}=`)) return true;
      if (s.short && (a === `-${s.short}` || a.startsWith(`-${s.short}=`) || new RegExp(`^-${s.short}.+`).test(a)))
        return true;
      return false;
    });
    if (!spec) {
      out.push(a);
      continue;
    }
    // Consume a separate value token only for the exact-match (space-separated) forms.
    const isExact = a === `--${spec.long}` || (spec.short && a === `-${spec.short}`);
    if (spec.takesValue && isExact && i + 1 < args.length) i++;
  }
  return out;
}

/**
 * The routing flags every `--host`-capable command shares. `--device` is a
 * first-class alias of `--host` (the device registry is the source of truth for
 * machine identity — see `agents devices`), mirroring `agents run --device`.
 * Both are stripped before forwarding so the alias never leaks to the remote
 * binary (which would re-trigger routing).
 */
export const HOST_ROUTING_SPECS: StripSpec[] = [
  { long: 'host', short: 'H', takesValue: true },
  { long: 'device', takesValue: true },
  { long: 'remote-cwd', takesValue: true },
];

/**
 * Build the single command string for `ssh <target> <cmd>`. The forwarded args
 * are quoted for the inner login shell, then the whole `agents …` invocation is
 * quoted again so it survives `bash -lc <...>` — `bash -lc` so the remote login
 * PATH resolves `agents`. An optional `cd` runs first for `--remote-cwd`.
 *
 * `os` selects the remote shell dialect: a Windows target gets a PowerShell
 * invocation instead (ssh lands in cmd.exe/PowerShell there, where `bash -lc`
 * does not exist). Anything else — including an unknown/absent OS — keeps the
 * POSIX form, so linux/macos are byte-for-byte unchanged.
 */
export function buildRemoteAgentsInvocation(
  forwardedArgs: string[],
  remoteCwd?: string,
  os?: string,
  env?: Record<string, string>,
): string {
  if (remoteShellFor(os) === 'powershell') {
    return buildWindowsAgentsCommand({ args: forwardedArgs, cwd: remoteCwd, env });
  }
  const inner = ['agents', ...forwardedArgs].map(shellQuote).join(' ');
  const withCwd = remoteCwd ? `cd ${shellQuote(remoteCwd)} && ${inner}` : inner;
  if (!env || Object.keys(env).length === 0) {
    return `bash -lc ${shellQuote(withCwd)}`;
  }
  // Prepend env exports so the remote command sees the shims dir even when the
  // login shell hasn't sourced the interactive rc files that usually add it.
  // Values are double-quoted (not single-quoted) so remote variables like
  // $HOME and $PATH are expanded by the login shell.
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${shellQuote(k)}="${v.replace(/[\\"]/g, '\\$&')}"`)
    .join('; ');
  return `bash -lc ${shellQuote(`${exports}; ${withCwd}`)}`;
}

/** The two remote shell dialects we build commands for. */
export type RemoteShell = 'posix' | 'powershell';

/**
 * Pick the remote shell dialect from a recorded OS/platform string. A Windows
 * host (device-registry `platform: 'windows'`, or an enrolled `HostEntry.os`
 * that reads `windows`/`Windows`/`win32`/…) speaks PowerShell; everything else,
 * including `undefined`/unknown, defaults to POSIX so linux/macos never regress.
 */
export function remoteShellFor(os: string | undefined): RemoteShell {
  return /^win/i.test((os ?? '').trim()) ? 'powershell' : 'posix';
}

/**
 * PowerShell single-quoted literal: wrap in `'…'` and double any embedded `'`.
 * Single-quoted PS strings are fully literal (no `$var`, no backtick escapes),
 * so this neutralises every metacharacter the same way POSIX `shellQuote` does.
 */
export function powershellQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Encode a PowerShell script for `powershell -EncodedCommand`: base64 of its
 * UTF-16LE bytes. The payload is a bare base64 word (no spaces or shell
 * metacharacters), so it survives being handed to ssh as a single argument and
 * re-parsed by the remote's cmd.exe/PowerShell with zero quoting hazards —
 * the robust way to ship a complex command to a Windows box over SSH.
 */
export function encodePowershell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Inverse of {@link encodePowershell} — decode an `-EncodedCommand` payload
 * back to its script. Used by tests to assert on the built command. */
export function decodePowershell(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

/** A single `agents …` invocation to run on a Windows remote. */
export interface WindowsAgentsCommand {
  /** `agents` argv (command name NOT included; `agents` is prepended). */
  args: string[];
  /** Env vars scoped to this invocation (POSIX `VAR=val` ↔ PS `$env:VAR=…`). */
  env?: Record<string, string>;
  /** Directory to enter before running (`--remote-cwd`). */
  cwd?: string;
  /**
   * Append `exit $LASTEXITCODE` so a native `agents` exit code propagates out
   * through `powershell.exe` (which otherwise exits 0 regardless). Default true;
   * pass false for probes whose reachability keys off a sentinel, not the code.
   */
  propagateExit?: boolean;
}

/**
 * The PowerShell script (pre-encoding) that {@link buildWindowsAgentsCommand}
 * runs. Exposed so tests can decode the `-EncodedCommand` payload and compare
 * against the exact script, without needing PowerShell on the test host.
 *
 * `& agents …` invokes the CLI from the machine PATH (Windows has no login
 * shell, so there is no `bash -lc` equivalent — the shim is simply on PATH).
 */
export function windowsAgentsScript(cmd: WindowsAgentsCommand): string {
  const { args, env, cwd, propagateExit = true } = cmd;
  const parts: string[] = [];
  if (env) for (const [k, v] of Object.entries(env)) parts.push(`$env:${k} = ${powershellQuote(v)}`);
  if (cwd) parts.push(`Set-Location -LiteralPath ${powershellQuote(cwd)}`);
  parts.push(`& ${['agents', ...args].map(powershellQuote).join(' ')}`);
  if (propagateExit) parts.push('exit $LASTEXITCODE');
  return parts.join('; ');
}

/**
 * Build the `ssh <target> <cmd>` string for one `agents …` invocation on a
 * Windows remote: a `powershell -NoProfile -EncodedCommand <base64>` call. The
 * Windows counterpart of `bash -lc '<...>'`, shared by every `--host` site.
 */
export function buildWindowsAgentsCommand(cmd: WindowsAgentsCommand): string {
  return `powershell -NoProfile -EncodedCommand ${encodePowershell(windowsAgentsScript(cmd))}`;
}

/**
 * Build the `ssh <target> <cmd>` string for `agents secrets import` on a Windows
 * remote where the `.env` is piped over ssh stdin.
 *
 * We can't just run `agents secrets import <bundle> --from -`: the npm
 * `agents.ps1` shim does NOT forward the ssh-piped stdin down to the underlying
 * node process, so a raw fd-0 read (`--from -`) hangs forever (observed: the
 * push to a Windows host times out). PowerShell ITSELF can read the pipe, so we
 * read stdin into a temp file in PowerShell, import `--from <file>` (a plain
 * file read, which the shim handles fine), and delete the temp file afterwards
 * — success or failure. Backend defaults to the platform native store
 * (Credential Manager, or the headless file store when there's no logon
 * session), matching a local `agents secrets import`.
 */
export function buildWindowsStdinImportCommand(bundle: string, opts: { force?: boolean } = {}): string {
  const force = opts.force ? ' --force' : '';
  const script = [
    '$in = [Console]::In.ReadToEnd()',
    '$tmp = [System.IO.Path]::GetTempFileName()',
    '[System.IO.File]::WriteAllText($tmp, $in)',
    `try { & agents secrets import ${powershellQuote(bundle)} --from $tmp${force}; $code = $LASTEXITCODE } ` +
      `finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }`,
    'if ($null -eq $code) { $code = 1 }',
    'exit $code',
  ].join('; ');
  return `powershell -NoProfile -EncodedCommand ${encodePowershell(script)}`;
}
