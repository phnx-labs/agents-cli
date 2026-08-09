/**
 * `agents cp <src> <dst>` — first-class fleet file transfer.
 *
 * Accepts `host:path` on either side (local = bare absolute path). Resolves
 * `~` and `$HOME` remote paths ON the remote before transfer so a `$HOME` in
 * the remote spec can never silently expand to the local user's home directory
 * — the documented silent-failure class in `remote-dispatch-mutation-safety`.
 *
 * Reuses the same SSH fabric (SSH_OPTS, deviceIdentityArgs, resolveDeviceTarget)
 * that `agents ssh` and `--host` dispatch use.
 */

import type { Command } from 'commander';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { resolveDeviceTarget } from '../lib/devices/resolve-target.js';
import { sshTargetFor, deviceIdentityArgs } from '../lib/devices/connect.js';
import { sshExec, SSH_OPTS } from '../lib/ssh-exec.js';

// ---------------------------------------------------------------------------
// Endpoint parsing
// ---------------------------------------------------------------------------

/**
 * A remote endpoint — host (device name or user@device) and a path on that
 * host. The path may begin with `~` or `$HOME`; {@link resolveRemotePath}
 * expands those on the remote before transfer.
 */
export interface RemoteEndpoint {
  isRemote: true;
  /** Device name, user@device, or ad-hoc host literal. */
  host: string;
  /** Path as given by the caller — may contain `~` or `$HOME`. */
  path: string;
}

/** A local endpoint — an absolute local path. */
export interface LocalEndpoint {
  isRemote: false;
  /** Absolute local path. */
  path: string;
}

export type Endpoint = RemoteEndpoint | LocalEndpoint;

/**
 * Parse one CLI token into an {@link Endpoint}.
 *
 * Grammar: `host:path` is remote; anything else is local. The host part must
 * not contain a `/` (that would be a local absolute path with a colon in it —
 * unusual but valid; the colon test covers the common fleet pattern and rejects
 * the almost-never-seen edge case in favour of local-path semantics).
 *
 * Windows drive letters (`C:path`) are excluded by requiring the host part to
 * be at least two characters and not a single capital letter.
 */
export function parseEndpoint(token: string): Endpoint {
  const colonIdx = token.indexOf(':');
  if (colonIdx > 1 && !token.startsWith('/')) {
    const host = token.slice(0, colonIdx);
    const path = token.slice(colonIdx + 1);
    // A bare single uppercase letter before `:` looks like a Windows drive
    // letter — treat as local to avoid a confusing error.
    if (!/^[A-Z]$/.test(host) && !host.includes('/')) {
      return { isRemote: true, host, path };
    }
  }
  return { isRemote: false, path: token };
}

// ---------------------------------------------------------------------------
// Remote path resolution — the core safeguard
// ---------------------------------------------------------------------------

/**
 * Resolve the remote HOME directory in one SSH round-trip. Returns the
 * absolute path (always starts with `/`), or throws on failure.
 */
export async function resolveRemoteHome(
  target: string,
  extraSshArgs: string[],
): Promise<string> {
  const res = sshExec(target, 'printf "%s" "$HOME"', {
    extraSshArgs,
    timeoutMs: 10_000,
  });
  if (res.code !== 0) {
    throw new Error(
      `Cannot resolve remote $HOME on ${target}: ${res.stderr.trim() || 'ssh exited ' + String(res.code)}`,
    );
  }
  const home = res.stdout.trim();
  if (!home || !home.startsWith('/')) {
    throw new Error(
      `Remote $HOME on ${target} is not an absolute path: ${JSON.stringify(home)}`,
    );
  }
  return home;
}

/**
 * Pure home-prefix expansion. Given a remote HOME (already resolved on the
 * remote) and a raw path token, substitute a leading `~` or `$HOME`. Paths
 * without those prefixes are returned unchanged. Never consults
 * `process.env.HOME` — the local home must not leak into a remote path.
 */
export function expandRemoteHomePrefix(rawPath: string, remoteHome: string): string {
  if (rawPath === '~' || rawPath.startsWith('~/')) {
    return rawPath === '~' ? remoteHome : remoteHome + rawPath.slice(1);
  }
  if (rawPath === '$HOME' || rawPath.startsWith('$HOME/')) {
    return rawPath === '$HOME' ? remoteHome : remoteHome + rawPath.slice(5);
  }
  return rawPath;
}

/**
 * Expand a remote path's leading `~` or literal `$HOME` to an absolute path
 * resolved **on the remote**, not locally. A path that already starts with `/`
 * is returned unchanged (no round-trip).
 *
 * This is the safeguard against the silent-failure class: a `$HOME` or `~`
 * that would expand to the **local** user's home if left in a shell command.
 */
export async function resolveRemotePath(
  rawPath: string,
  target: string,
  extraSshArgs: string[],
): Promise<string> {
  if (
    rawPath === '~' ||
    rawPath.startsWith('~/') ||
    rawPath === '$HOME' ||
    rawPath.startsWith('$HOME/')
  ) {
    const home = await resolveRemoteHome(target, extraSshArgs);
    return expandRemoteHomePrefix(rawPath, home);
  }
  return rawPath;
}

// ---------------------------------------------------------------------------
// scp invocation
// ---------------------------------------------------------------------------

/**
 * Build the argv for the `scp` invocation. Pure — no spawning — so it is
 * unit-testable.
 *
 * `scp` accepts ssh `-o` options, so `SSH_OPTS` flows through unchanged.
 * Identity args (`-i key -o IdentitiesOnly=yes`) are included only when a
 * single remote device is involved; for two-remote transfers the identity
 * applies to both connections, which works when the fleet uses a shared key.
 *
 * Remote endpoints are formatted as `user@host:path` (or bare `host:path`),
 * local endpoints as their absolute path. Paths have already been resolved
 * (no `~` or `$HOME`) by the time this is called.
 */
export function buildScpArgv({
  srcSpec,
  dstSpec,
  identityArgs,
  recursive,
}: {
  srcSpec: string;
  dstSpec: string;
  identityArgs: string[];
  recursive: boolean;
}): string[] {
  const opts: string[] = [...SSH_OPTS, ...identityArgs];
  if (recursive) opts.push('-r');
  // Two-remote transfers route through the local machine (-3) to avoid
  // requiring direct SSH access between the two fleet boxes.
  if (srcSpec.includes(':') && dstSpec.includes(':')) opts.push('-3');
  return [...opts, srcSpec, dstSpec];
}

// ---------------------------------------------------------------------------
// Resolved spec — after host validation and path expansion
// ---------------------------------------------------------------------------

interface ResolvedEndpoint {
  /** The fully-resolved scp spec: `user@host:path` or `/abs/local/path`. */
  spec: string;
  /** Identity args for this endpoint's device (empty for local). */
  identityArgs: string[];
}

async function resolveEndpoint(ep: Endpoint): Promise<ResolvedEndpoint> {
  if (!ep.isRemote) {
    return { spec: ep.path, identityArgs: [] };
  }

  const device = await resolveDeviceTarget(ep.host);
  if (!device) {
    throw new Error(
      `Unknown device ${JSON.stringify(ep.host)}. Register it with \`agents devices add\` or check \`agents devices\`.`,
    );
  }

  const target = sshTargetFor(device);
  const idArgs = deviceIdentityArgs(device);
  const resolvedPath = await resolveRemotePath(ep.path, target, idArgs);

  if (!resolvedPath.startsWith('/')) {
    throw new Error(
      `Remote path on ${ep.host} must be absolute after expansion, got: ${JSON.stringify(resolvedPath)}. Use an absolute path or start with ~/`,
    );
  }

  return { spec: `${target}:${resolvedPath}`, identityArgs: idArgs };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate a local path: must be absolute. */
function validateLocalPath(raw: string): void {
  if (!raw.startsWith('/')) {
    throw new Error(
      `Local path must be absolute, got: ${JSON.stringify(raw)}`,
    );
  }
}

/** Validate a remote path: non-empty. */
function validateRemotePath(raw: string, host: string): void {
  if (!raw) {
    throw new Error(
      `Remote path for ${JSON.stringify(host)} is empty. Expected: ${host}:/abs/path`,
    );
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerCpCommand(program: Command): void {
  const cmd = program
    .command('cp <src> <dst>')
    .description('Copy a file or directory between fleet hosts. Either endpoint may be host:path (remote) or an absolute local path.')
    .option('-r, --recursive', 'Copy directories recursively')
    .action(async (srcToken: string, dstToken: string, opts: { recursive?: boolean }) => {
      const recursive = opts.recursive ?? false;

      const srcEp = parseEndpoint(srcToken);
      const dstEp = parseEndpoint(dstToken);

      if (!srcEp.isRemote && !dstEp.isRemote) {
        process.stderr.write(
          chalk.red('error:') +
            ' At least one endpoint must be remote (host:path). For local-only copies use `cp`.\n',
        );
        process.exit(1);
      }

      let srcResolved: ResolvedEndpoint;
      let dstResolved: ResolvedEndpoint;

      try {
        // Validate shapes before any network calls.
        if (!srcEp.isRemote) validateLocalPath(srcEp.path);
        if (srcEp.isRemote) validateRemotePath(srcEp.path, srcEp.host);
        if (!dstEp.isRemote) validateLocalPath(dstEp.path);
        if (dstEp.isRemote) validateRemotePath(dstEp.path, dstEp.host);

        [srcResolved, dstResolved] = await Promise.all([
          resolveEndpoint(srcEp),
          resolveEndpoint(dstEp),
        ]);
      } catch (err) {
        process.stderr.write(chalk.red('error:') + ' ' + (err as Error).message + '\n');
        process.exit(1);
      }

      // Merge identity args: for two-remote transfers, omit per-device identity
      // args (they apply to both connections via -3; a conflict would need
      // separate -i per connection which scp doesn't support). A shared fleet
      // key works without explicit -i.
      const identityArgs =
        srcResolved.identityArgs.length > 0 && dstResolved.identityArgs.length === 0
          ? srcResolved.identityArgs
          : dstResolved.identityArgs.length > 0 && srcResolved.identityArgs.length === 0
            ? dstResolved.identityArgs
            : srcResolved.identityArgs.join(',') === dstResolved.identityArgs.join(',')
              ? srcResolved.identityArgs
              : []; // two remotes with different keys — skip per-device flag, use agent's default key

      const argv = buildScpArgv({
        srcSpec: srcResolved.spec,
        dstSpec: dstResolved.spec,
        identityArgs,
        recursive,
      });

      const res = spawnSync('scp', argv, { stdio: 'inherit' });
      const code = typeof res.status === 'number' ? res.status : 1;
      if (code !== 0) {
        // scp already printed a diagnostic; just exit non-zero.
        process.exit(code);
      }
    });

  setHelpSections(cmd, {
    examples: `
      agents cp yosemite-s0:/abs/data.json /tmp/data.json   # download a file from a fleet host
      agents cp /tmp/build.tar.gz mac-mini:/abs/deploy/    # upload a local file to a fleet host
      agents cp -r yosemite-s0:/abs/src/ mac-mini:/abs/dst/ # copy a directory between two fleet hosts
      agents cp yosemite-s0:~/logs/run.log /tmp/run.log    # ~ is resolved on the remote host
    `,
    notes: `
      Local paths must be absolute (use /abs/path, not ./relative).
      Remote paths must be absolute after ~ / $HOME expansion.
      Remote $HOME is resolved on the remote host — never in the local shell.
      Both local-to-remote and remote-to-local transfers are supported.
      Remote-to-remote transfers route through the local machine (-3).
      Devices must be registered: 'agents devices' to list, 'agents devices add' to enroll.
    `,
  });
}
