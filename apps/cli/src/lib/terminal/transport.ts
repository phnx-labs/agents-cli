/**
 * Transport — runs a LaunchSpec locally or on a remote host.
 *
 * Local: spawn the launcher (osascript / tmux) and wait for it to exit — these
 * are short-lived commands that create the surface and return, so waiting gives
 * a real success/failure. Remote: serialize the argv into one shell string and
 * hand it to `sshExec` — the same hardened SSH primitive `agents sessions
 * --host` and the browser driver use (target-injection guard, POSIX quoting,
 * connection multiplexing).
 */
import { spawn } from 'child_process';
import { sshExec } from '../ssh-exec.js';
import { shellQuote } from './quote.js';
import type { LaunchSpec } from './types.js';

/** Resolve a host alias to an ssh target. Default: identity (ssh_config resolves it). */
export type HostResolver = (alias: string) => string;

export interface RunResult {
  ok: boolean;
  error?: string;
}

/** Run the spec on this machine: spawn the launcher, resolve when it exits. */
export function runLocal(spec: LaunchSpec): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { stdio: 'ignore' });
    child.on('error', (err: any) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: `${spec.argv[0]} exited with code ${code}` }),
    );
  });
}

/** Serialize a launch argv into a single POSIX-quoted shell command string. */
export function remoteCommand(spec: LaunchSpec): string {
  return spec.argv.map(shellQuote).join(' ');
}

/** Run the spec on a remote host over SSH. */
export function runRemote(spec: LaunchSpec, target: string): RunResult {
  const res = sshExec(target, remoteCommand(spec), { multiplex: true });
  if (res.code === 0) return { ok: true };
  const err = (res.stderr || '').trim();
  return { ok: false, error: err || `ssh exited with code ${res.code}` };
}

/** Run a spec locally (no host / 'local') or on a resolved remote host. */
export async function runSpec(spec: LaunchSpec, host?: string, resolveHost?: HostResolver): Promise<RunResult> {
  if (!host || host === 'local') return runLocal(spec);
  const target = resolveHost ? resolveHost(host) : host;
  return runRemote(spec, target);
}
