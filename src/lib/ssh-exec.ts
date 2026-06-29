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

/** Hardened ssh options applied to every connection. */
export const SSH_OPTS: readonly string[] = [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
];

export interface SshExecOptions {
  /** Piped to the remote command's stdin (never interpolated into the shell). */
  input?: string;
  /** Kill the ssh process after this many ms. */
  timeoutMs?: number;
  /** Extra ssh flags inserted before the target (e.g. `-tt`). */
  extraSshArgs?: string[];
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
  const args = [...SSH_OPTS, ...(opts.extraSshArgs ?? []), target, remoteCmd];
  const res = spawnSync('ssh', args, {
    input: opts.input,
    encoding: 'utf-8',
    timeout: opts.timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const timedOut = !!(res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
  return {
    code: typeof res.status === 'number' ? res.status : null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut,
  };
}

/** True if `target` is reachable over ssh (a passwordless `true` succeeds quickly). */
export function sshReachable(target: string, timeoutMs = 10000): boolean {
  return sshExec(target, 'true', { timeoutMs }).code === 0;
}
