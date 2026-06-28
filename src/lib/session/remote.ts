/**
 * `agents sessions --host <target>` — run the session query on a remote machine
 * over SSH and stream its output back. Session transcripts and the index DB live
 * on the machine that produced them (see `discover.ts`, all `os.homedir()`-rooted),
 * so instead of syncing the bytes here we invoke the *remote's own* `agents
 * sessions` against its already-built index and forward stdout verbatim.
 *
 * This is the live counterpart to `agents sessions sync` (R2/CRDT, eventual): no
 * upfront copy, always current, but the peer must be reachable. SSH access is the
 * only auth — if you can `ssh <host>`, you own the box (no identity layer by design).
 *
 * Mirrors the transport already used by `agents secrets export --to-ssh`
 * (`src/commands/secrets.ts`): `ssh -o BatchMode=yes <host> bash -lc '<cmd>'`,
 * with `bash -lc` so the remote login PATH resolves `agents`.
 */
import { spawnSync } from 'child_process';
import chalk from 'chalk';

/**
 * SSH target: a bare ssh-config host alias (e.g. `yosemite-s1`) or `user@host`.
 * The strict allowlist blocks shell metacharacters and a leading `-`, so a target
 * can never be smuggled in as an ssh argv flag.
 */
export const SSH_TARGET_RE = /^[a-zA-Z0-9._-]+(@[a-zA-Z0-9._-]+)?$/;

export function assertValidSshTarget(host: string): void {
  if (!SSH_TARGET_RE.test(host)) {
    throw new Error(
      `Invalid SSH target ${JSON.stringify(host)}. Expected a host alias or user@host ` +
        `(letters, digits, '.', '_', '-').`,
    );
  }
}

/** POSIX single-quote a string for safe interpolation into a remote shell command. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Strip the `--host`/`-H` flag (and its value) from a raw `agents sessions` argv,
 * leaving the args to forward to the remote unchanged. The remote runs the same
 * binary, so every other flag (`--since`, `--last`, `--json`, query, …) carries
 * over for free. Handles every form commander accepts: `--host h`, `--host=h`,
 * `-H h`, `-H=h`, and the glued short form `-Hh`.
 *
 * @param argv full process argv; the sessions args begin at index 2
 *             (`[runtime, script, 'sessions', ...]`).
 */
export function buildForwardedArgs(argv: string[]): string[] {
  const args = argv.slice(2);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--host' || a === '-H') {
      i++; // also consume the separate value token
      continue;
    }
    if (a.startsWith('--host=') || a.startsWith('-H=')) continue;
    if (/^-H.+/.test(a)) continue; // glued short form: -Hyosemite-s1
    out.push(a);
  }
  return out;
}

/**
 * Build the single remote command string for `ssh <host> <cmd>`. Forwarded args
 * are quoted for the inner login shell, then the whole `agents …` invocation is
 * quoted again so it survives `bash -lc <...>`.
 */
export function buildRemoteCommand(forwardedArgs: string[]): string {
  const inner = ['agents', ...forwardedArgs].map(shellQuote).join(' ');
  return `bash -lc ${shellQuote(inner)}`;
}

const SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=10',
];

/**
 * Run the current `agents sessions` invocation on one or more remote machines over
 * SSH, streaming each remote's output to the terminal. Sets `process.exitCode = 1`
 * if any host fails. Reads the invocation from `process.argv` (override via
 * `argv` for testing).
 */
export function runRemoteSessions(hosts: string[], argv: string[] = process.argv): void {
  for (const host of hosts) assertValidSshTarget(host); // fail fast on any bad target

  const remoteCmd = buildRemoteCommand(buildForwardedArgs(argv));
  const multi = hosts.length > 1;
  let failures = 0;

  for (const host of hosts) {
    if (multi) process.stdout.write(chalk.cyan(`\n── ${host} ──\n`));
    const res = spawnSync('ssh', [...SSH_OPTS, host, remoteCmd], { stdio: 'inherit' });
    if (res.error) {
      failures++;
      console.error(chalk.red(`${host}: ${res.error.message}`));
      continue;
    }
    if (res.status !== 0) {
      failures++;
      console.error(
        chalk.red(`${host}: remote query failed (exit ${res.status ?? 'signal'}).`),
      );
    }
  }

  if (failures > 0) process.exitCode = 1;
}
