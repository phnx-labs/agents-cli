/**
 * Generic `--host` passthrough — the single choke point that runs an allowlisted
 * `agents <command>` on a remote host instead of locally, so read-only and
 * config commands (`view`, `usage`, `cost`, `doctor`, `inspect`, `list`, `sync`)
 * and the team lifecycle (`teams …`) all gain remote support with no per-command
 * code. Called once from `index.ts` before commander parses; returns `true` when
 * it handled the invocation (the local command must then NOT run).
 *
 * Transport is SSH (via `ssh-exec.ts`), never a daemon: SSH is the one hardened
 * choke point already used everywhere, and it gives auth + encryption + host-key
 * trust for free. Read-only commands stream synchronously (`sshStream`); the one
 * long-running case — `teams start --watch` — dispatches detached so the remote
 * supervisor outlives a dropped connection.
 *
 * `run` and `sessions` are deliberately absent from the table below: they own
 * richer `--host` handling in their own command actions (detached run dispatch;
 * multi-host session fan-out) and must fall through to it.
 */

import chalk from 'chalk';
import { assertValidSshTarget, sshStream } from '../ssh-exec.js';
import { resolveHost, resolveHostByCap } from './registry.js';
import { sshTargetFor, type Host } from './types.js';
import { dispatchAgentsCommand } from './dispatch.js';
import {
  stripRoutingFlags,
  buildRemoteAgentsInvocation,
  HOST_ROUTING_SPECS,
  type StripSpec,
} from './remote-cmd.js';
import { resolveRemoteOsSync } from './remote-os.js';
import { machineId } from '../session/sync/config.js';

/** Per-command remote behaviour. Absence from this map = not host-routable here. */
interface RemoteSpec {
  /** Flags appended when running non-interactively (no local TTY / `--no-tty`). */
  nonInteractive?: string[];
}

const REMOTE_PASSTHROUGH: Record<string, RemoteSpec> = {
  view: {},
  usage: {},
  cost: {},
  doctor: {},
  inspect: {},
  list: {},
  sync: { nonInteractive: ['--yes'] },
  teams: {},
  message: {},
};

/** `--no-tty` is stripped like the routing flags but carries no value. */
const STRIP_SPECS: StripSpec[] = [...HOST_ROUTING_SPECS, { long: 'no-tty', takesValue: false }];

/** Pull the value of `--host`/`-H`/`--remote-cwd` (any form) out of an argv. */
export function flagValue(args: string[], long: string, short?: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === `--${long}` || (short && a === `-${short}`)) return args[i + 1];
    if (a.startsWith(`--${long}=`)) return a.slice(long.length + 3);
    if (short && a.startsWith(`-${short}=`)) return a.slice(short.length + 2);
    if (short && new RegExp(`^-${short}(.+)`).test(a)) return a.slice(2);
  }
  return undefined;
}

/** Synthesize a `Host` for a raw `user@host` / bare-alias target (not enrolled). */
function syntheticHost(target: string): Host {
  const at = target.indexOf('@');
  if (at !== -1) {
    return { name: target, provider: 'local', source: 'inline', user: target.slice(0, at), address: target.slice(at + 1) };
  }
  // Bare name: ssh resolves it from ~/.ssh/config, or connects to it as a hostname.
  return { name: target, provider: 'local', source: 'ssh-config' };
}

/** Resolve a `--host` value to a Host: enrolled name → capability tag → raw target. */
async function resolveTargetHost(name: string, any: boolean): Promise<Host> {
  const enrolled = await resolveHost(name);
  if (enrolled) return enrolled;
  try {
    return await resolveHostByCap(name, any);
  } catch (e) {
    // "Multiple hosts tagged …" is actionable — surface it. "No host tagged" falls
    // through to treating the value as a literal ssh target.
    if (e instanceof Error && e.message.startsWith('Multiple hosts')) throw e;
  }
  assertValidSshTarget(name); // rejects injection / flag-smuggling before it reaches ssh
  return syntheticHost(name);
}

/**
 * Route `agents <command> … --host <name>` to a remote if the command is
 * host-routable and a `--host` was given. Returns `false` (run locally) when
 * there is no `--host`, the command isn't in the table, or the target is this
 * very machine.
 *
 * @param command the resolved subcommand name (`process.argv`'s first non-flag).
 * @param allArgs `process.argv.slice(2)` — the command name followed by its args.
 */
export async function maybeRunOnHost(command: string, allArgs: string[]): Promise<boolean> {
  const spec = REMOTE_PASSTHROUGH[command];
  if (!spec) return false;

  const hostName = flagValue(allArgs, 'host', 'H');
  if (!hostName) return false;

  // Running against your own machine is just a local run — skip the SSH round-trip.
  // `machineId()` is the same self-identifier the device registry and session
  // sync use (lowercased short hostname); compare case-insensitively.
  if (hostName.toLowerCase() === machineId()) return false;

  const remoteCwd = flagValue(allArgs, 'remote-cwd');
  const any = allArgs.includes('--any');

  let host: Host;
  try {
    host = await resolveTargetHost(hostName, any);
  } catch (e) {
    console.error(chalk.red(e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
    return true;
  }
  const target = sshTargetFor(host);

  // Interactive only when our own stdout is a terminal and the caller didn't opt
  // out — otherwise force the command's non-interactive path so no half-drawn
  // picker is piped into a file or another program.
  const interactive = !!process.stdout.isTTY && !allArgs.includes('--no-tty');

  let forwarded = stripRoutingFlags(allArgs, STRIP_SPECS);
  if (!interactive && spec.nonInteractive) forwarded = [...forwarded, ...spec.nonInteractive];

  // The one long-running case: keep the remote team supervisor alive past a
  // disconnect by dispatching it detached (nohup), still streaming live.
  const isWatchedTeamStart = command === 'teams' && forwarded[1] === 'start' && forwarded.includes('--watch');
  if (isWatchedTeamStart) {
    try {
      const { exitCode } = await dispatchAgentsCommand(host, { forwardedArgs: forwarded, remoteCwd });
      process.exitCode = exitCode && exitCode > 0 ? exitCode : 0;
    } catch (e) {
      console.error(chalk.red(e instanceof Error ? e.message : String(e)));
      process.exitCode = 1;
    }
    return true;
  }

  const remoteCmd = buildRemoteAgentsInvocation(forwarded, remoteCwd, resolveRemoteOsSync(host.name));
  const code = sshStream(target, remoteCmd, { tty: interactive, multiplex: true });
  if (code === 255) {
    console.error(
      chalk.red(`${host.name}: unreachable over SSH (asleep, offline, or host key changed?).`) +
        chalk.gray(' Check: agents hosts check ' + host.name),
    );
  }
  process.exitCode = code;
  return true;
}
