/**
 * Shared SSH exec primitive — the single hardened choke point for running a
 * command on a remote host over the system `ssh`.
 *
 * `agents hosts` dispatch and the browser driver both go through here so the
 * connection hardening (`BatchMode`, `accept-new`, `ConnectTimeout`) and the
 * target-injection guard live in exactly one place. Target validation is the
 * canonical definition; `commands/secrets.ts` re-exports it.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from './state.js';

/**
 * SSH target: a bare ssh-config host alias (e.g. `yosemite-s0`) or `user@host`.
 * The strict allowlist blocks shell metacharacters so a target can't be
 * smuggled in as part of a remote command, and `sshExec` additionally rejects a
 * leading `-` so it can never be parsed as an ssh argv flag.
 */
export const SSH_TARGET_RE = /^[a-zA-Z0-9._-]+(@[a-zA-Z0-9._-]+)?$/;

export function assertValidSshTarget(host: string): void {
  if (host.startsWith('-') || !SSH_TARGET_RE.test(host)) {
    throw new Error(
      `Invalid SSH target ${JSON.stringify(host)}. Expected a host alias or user@host (letters, digits, '.', '_', '-').`,
    );
  }
}

/** POSIX single-quote a string for safe interpolation into a remote shell command. */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Hardened ssh options applied to every connection — the single baseline every
 * `ssh` in the codebase composes from (directly here, or as `[...SSH_OPTS, …]`
 * in the few callers that need extra flags like `-L`/`-N`/`ProxyCommand`).
 *
 * `ServerAliveInterval`/`ServerAliveCountMax` add in-connection keepalive: a
 * silently-dropped link (laptop sleeps, Wi-Fi flips) is detected and the ssh
 * process exits within ~45s instead of hanging forever — so a followed run or a
 * long-lived `-N` tunnel can't leave a zombie ssh + socket pinned on the laptop.
 */
export const SSH_OPTS: readonly string[] = [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
];

/**
 * OpenSSH connection-multiplexing options. The first connection to a host opens
 * a control socket; subsequent connections (even from a *separate* `agents`
 * invocation) reuse it, skipping the TCP+auth handshake — so repeated
 * `--host <name>` calls to the same box feel local instead of paying ~100-300ms
 * each. `ControlPersist=60s` keeps the master alive briefly after the last
 * client exits. `%C` (a short fixed-length hash of local-host/remote/port/user)
 * keeps the socket path well under macOS's 104-char `sun_path` limit.
 *
 * This is **on by default** for every `sshExec`/`sshStream` call: the poll loops
 * (`followHostTask`), readiness probes, and per-host fan-outs are exactly the
 * high-frequency callers that benefit most from socket reuse, and they should
 * never have to remember to opt in. A caller passes `multiplex: false` only for
 * a genuine one-shot where a lingering 60s master is pure overhead.
 *
 * The socket directory is created lazily; if ssh can't open the control socket
 * it falls back to a normal connection (multiplexing is an optimisation, never a
 * requirement), so this can never make a reachable host unreachable.
 */
let controlDirEnsured = false;
export function controlOpts(): string[] {
  // OpenSSH on Windows has no ControlMaster/ControlPath (unix-socket) support —
  // passing those options makes ssh error out. Multiplexing is a pure latency
  // optimisation, so on Windows we simply skip it and use a fresh connection.
  if (process.platform === 'win32') return [];
  const dir = path.join(getCacheDir(), 'ssh');
  if (!controlDirEnsured) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      /* best-effort — ssh degrades to a fresh connection if the dir is missing */
    }
    controlDirEnsured = true;
  }
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${path.join(dir, 'cm-%C')}`,
    '-o', 'ControlPersist=60s',
  ];
}

/**
 * Compose an ssh connection-option prefix.
 *
 * `hostKeyOpts` (a caller's host-key posture, e.g. a pinned
 * `StrictHostKeyChecking=yes` + managed `UserKnownHostsFile`) go FIRST, ahead of
 * the `SSH_OPTS` baseline: ssh honors the *first* value it sees for each option,
 * so an override placed after the baseline's `accept-new` would be silently
 * ignored. Pure so the ordering contract is unit-testable. See RUSH-1767.
 */
export function sshConnectOpts(mux: string[], hostKeyOpts?: string[]): string[] {
  return [...(hostKeyOpts ?? []), ...SSH_OPTS, ...mux];
}

export interface SshExecOptions {
  /** Piped to the remote command's stdin (never interpolated into the shell). */
  input?: string;
  /** Kill the ssh process after this many ms. */
  timeoutMs?: number;
  /** Extra ssh flags inserted before the target (e.g. `-tt`). */
  extraSshArgs?: string[];
  /** Reuse a persistent control socket across calls (default true; see `controlOpts`). */
  multiplex?: boolean;
  /**
   * Host-key `-o` options that OVERRIDE the accept-new baseline — prepended so
   * ssh's first-value-wins rule takes them (see {@link sshConnectOpts}). Used to
   * force strict verification against the managed known_hosts store on the
   * credential-copy path (RUSH-1767).
   */
  hostKeyOpts?: string[];
}

export interface SshExecResult {
  /** Remote exit status, or null if ssh itself failed / timed out. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run `remoteCmd` on `target` over ssh and capture stdout/stderr/exit.
 *
 * `remoteCmd` is passed as a single argv to ssh (the remote login shell parses
 * it); callers that build it from user input must `shellQuote` the pieces.
 */
export function sshExec(target: string, remoteCmd: string, opts: SshExecOptions = {}): SshExecResult {
  assertValidSshTarget(target);
  const mux = opts.multiplex === false ? [] : controlOpts();
  const args = [...sshConnectOpts(mux, opts.hostKeyOpts), ...(opts.extraSshArgs ?? []), target, remoteCmd];
  const res = spawnSync('ssh', args, {
    input: opts.input,
    encoding: 'utf-8',
    timeout: opts.timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const timedOut = !!(res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
  return {
    code: typeof res.status === 'number' ? res.status : null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut,
  };
}

export interface SshExecRawResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
}

/**
 * Like {@link sshExec} but returns raw stdout/stderr Buffers — no UTF-8 decode.
 *
 * Use when byte-exactness matters, e.g. offset-tracked log tailing: a multibyte
 * character split across a read boundary must stay raw bytes, not collapse to a
 * U+FFFD replacement char (which would desync a byte offset from the wire).
 */
export function sshExecRaw(target: string, remoteCmd: string, opts: SshExecOptions = {}): SshExecRawResult {
  assertValidSshTarget(target);
  const mux = opts.multiplex === false ? [] : controlOpts();
  const args = [...sshConnectOpts(mux, opts.hostKeyOpts), ...(opts.extraSshArgs ?? []), target, remoteCmd];
  const res = spawnSync('ssh', args, {
    input: opts.input,
    // No `encoding` → spawnSync returns Buffers.
    timeout: opts.timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const timedOut = !!(res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
  return {
    code: typeof res.status === 'number' ? res.status : null,
    stdout: (res.stdout as Buffer | null) ?? Buffer.alloc(0),
    stderr: (res.stderr as Buffer | null) ?? Buffer.alloc(0),
    timedOut,
  };
}

/** True if `target` is reachable over ssh (a passwordless `true` succeeds quickly). */
export function sshReachable(target: string, timeoutMs = 10000): boolean {
  return sshExec(target, 'true', { timeoutMs, multiplex: true }).code === 0;
}

export interface SshStreamOptions {
  /**
   * Allocate a remote pseudo-terminal (`ssh -tt`) so an interactive remote
   * command (a picker, a prompt) renders live on the local terminal. Callers
   * pass this when the *local* process is itself a TTY; piped/scripted callers
   * leave it off and forward a non-interactive invocation instead.
   */
  tty?: boolean;
  /** Reuse a persistent control socket across calls (default true; see `controlOpts`). */
  multiplex?: boolean;
  /**
   * Host-key `-o` options that OVERRIDE the accept-new baseline — prepended so
   * ssh's first-value-wins rule takes them (see {@link sshConnectOpts}). Used to
   * force strict verification against the managed known_hosts store on the
   * interactive credential-copy path (RUSH-1767).
   */
  hostKeyOpts?: string[];
}

/**
 * Foreground counterpart to `sshExec`: run `remoteCmd` on `target` with the
 * local stdio wired straight through (`stdio: 'inherit'`), so output streams as
 * it is produced and — with `tty` — keystrokes reach a remote picker. Blocks
 * until the remote command exits and returns its exit code (255 is ssh's own
 * connection-layer failure; any other non-zero is the remote command's code).
 */
export function sshStream(target: string, remoteCmd: string, opts: SshStreamOptions = {}): number {
  assertValidSshTarget(target);
  const mux = opts.multiplex === false ? [] : controlOpts();
  const tty = opts.tty ? ['-tt'] : [];
  const args = [...sshConnectOpts(mux, opts.hostKeyOpts), ...tty, target, remoteCmd];
  const res = spawnSync('ssh', args, { stdio: 'inherit' });
  if (typeof res.status === 'number') return res.status;
  return 255; // spawn error / signal — treat as a connection-layer failure
}
