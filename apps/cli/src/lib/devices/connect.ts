/**
 * Connection layer for `agents ssh` — turn a device profile into a real ssh
 * invocation, with platform-aware command wrapping and password-from-bundle
 * auth.
 *
 * Auth is genuinely two first-class, non-interactive methods:
 *  - `key`      — the system ssh agent / on-disk keys (BatchMode-friendly).
 *  - `password` — the secret is pulled from a Keychain-backed secrets bundle
 *                 by an askpass shim. The wrapper points `SSH_ASKPASS` at the
 *                 shim and forces its use; ssh calls the shim, the shim calls
 *                 back into `agents ssh __askpass`, which resolves the bundle
 *                 via the existing `readAndResolveBundleEnv` path and prints
 *                 the password to ssh. The password never touches argv or an
 *                 expect buffer.
 */
import * as fs from 'fs';
import * as path from 'path';
import { assertValidSshTarget, shellQuote } from '../ssh-exec.js';
import { getCliLaunch } from '../cli-entry.js';
import { encodePwshBase64 } from '../pwsh.js';
import { getCacheDir } from '../state.js';
import { hostKeyCheckingOpts } from './known-hosts.js';
import { hostNameFor } from './ssh-config.js';
import { type DeviceProfile } from './registry.js';

/** Env var the askpass shim reads to know which bundle holds the password. */
export const ASKPASS_BUNDLE_ENV = 'AGENTS_SSH_BUNDLE';
/** Env var the askpass shim reads to know which key in the bundle is the password. */
export const ASKPASS_KEY_ENV = 'AGENTS_SSH_KEY';

/**
 * Build the `user@host` (or bare `host`) ssh target for a device and validate
 * it against the shared injection guard. Throws if the device has no address.
 */
export function sshTargetFor(device: DeviceProfile): string {
  const host = hostNameFor(device);
  if (!host) {
    throw new Error(`Device '${device.name}' has no address (dnsName/ip). Run \`agents devices sync\` or \`agents devices add\`.`);
  }
  const target = device.user ? `${device.user}@${host}` : host;
  assertValidSshTarget(target);
  return target;
}

/**
 * Wrap a remote command for the device's shell. Windows devices speak
 * PowerShell, so a bare command is run through `powershell -NoProfile
 * -EncodedCommand`; POSIX devices get the command verbatim (the remote login
 * shell parses it). Returns undefined when no command was given (interactive
 * login).
 */
export function wrapRemoteCommand(device: DeviceProfile, cmd: string[]): string | undefined {
  if (cmd.length === 0) return undefined;
  const joined = cmd.join(' ');
  if (device.shell === 'powershell') {
    return `powershell -NoProfile -EncodedCommand ${encodePwshBase64(joined)}`;
  }
  return joined;
}

/** Host-key posture for {@link buildSshInvocation}. */
export interface SshHostKeyOptions {
  /**
   * True when the device's host key is already pinned in the managed
   * known_hosts store — connections then verify with `StrictHostKeyChecking=yes`
   * (a key swap is refused). False (the default) keeps `accept-new` for a
   * genuine first enrollment, whose learned key lands in the managed store and
   * pins the host for every subsequent connect. See {@link hostKeyCheckingOpts}.
   */
  pinned?: boolean;
  /** Managed known_hosts path override (tests). Defaults to the CLI-managed store. */
  knownHostsFile?: string;
}

/**
 * Build the argv (after the `ssh` program name) and the environment overlay
 * for connecting to a device. For password auth this points `SSH_ASKPASS` at
 * the shim and disables pubkey + the host's interactive password prompt so the
 * shim is the only auth path. Pure (no spawn) so it is unit-testable.
 *
 * Host-key checking runs against the CLI-managed known_hosts store (never the
 * user's `~/.ssh/known_hosts`): strict once `hostKey.pinned` is set, else
 * `accept-new` to learn+pin the key on first connect (RUSH-1767).
 */
export function buildSshInvocation(
  device: DeviceProfile,
  cmd: string[],
  askpassShimPath: string,
  hostKey: SshHostKeyOptions = {},
): { args: string[]; env: Record<string, string> } {
  const target = sshTargetFor(device);
  const remote = wrapRemoteCommand(device, cmd);
  const env: Record<string, string> = {};
  const args: string[] = [
    ...hostKeyCheckingOpts(hostKey.pinned ?? false, hostKey.knownHostsFile),
    '-o', 'ConnectTimeout=10',
  ];

  if (device.auth.method === 'password') {
    if (!device.auth.bundle) {
      throw new Error(`Device '${device.name}' uses password auth but has no secrets bundle. Set one with \`agents devices set ${device.name} --bundle <name>\`.`);
    }
    env.SSH_ASKPASS = askpassShimPath;
    env.SSH_ASKPASS_REQUIRE = 'force';
    env[ASKPASS_BUNDLE_ENV] = device.auth.bundle;
    env[ASKPASS_KEY_ENV] = device.auth.bundleKey ?? 'password';
    args.push('-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1');
  } else {
    args.push('-o', 'BatchMode=yes');
  }

  // An interactive login (no remote command) needs a real tty.
  if (!remote) args.push('-tt');
  args.push(target);
  if (remote) args.push(remote);
  return { args, env };
}

/**
 * Build the askpass shim's `#!/bin/sh` body: a script that re-invokes this CLI
 * as `agents ssh __askpass`. The relaunch argv comes from {@link getCliLaunch},
 * never a hand-rolled `[process.execPath, process.argv[1], …]` — on a Bun
 * standalone binary `process.argv[1]` is the *virtual* embedded entry
 * `/$bunfs/root/agents`, which the CLI would then receive as a bogus subcommand
 * (`unknown command '/$bunfs/root/agents'`), print nothing, and hand ssh an
 * empty password. `getCliLaunch` resolves the physical executable so the shim
 * works on both the standalone and JS/dev builds. Every argv element is
 * shell-quoted. Pure (takes the launch as a parameter) so it is unit-testable.
 */
export function buildAskpassShimBody(
  launch: { command: string; args: string[] } = getCliLaunch(['ssh', '__askpass']),
): string {
  const exec = [launch.command, ...launch.args].map(shellQuote).join(' ');
  return `#!/bin/sh\n# Generated by agents-cli — bridges ssh SSH_ASKPASS back into the CLI.\nexec ${exec}\n`;
}

/**
 * Write (idempotently) the askpass shim — a tiny executable that re-invokes
 * this CLI as `agents ssh __askpass`. ssh execs `SSH_ASKPASS` with no usable
 * args, so the shim carries no secret itself; it only bridges ssh's askpass
 * protocol back into the CLI, which then resolves the bundle.
 */
export function writeAskpassShim(): string {
  const dir = path.join(getCacheDir(), 'devices');
  fs.mkdirSync(dir, { recursive: true });
  const shimPath = path.join(dir, 'askpass.sh');
  fs.writeFileSync(shimPath, buildAskpassShimBody(), { mode: 0o700 });
  return shimPath;
}
