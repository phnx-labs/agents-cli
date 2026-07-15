/**
 * Generic `--host` passthrough — the single choke point that runs an allowlisted
 * `agents <command>` on a remote host instead of locally. Called once from
 * `index.ts` before commander parses; returns `true` when it handled the
 * invocation (the local command must then NOT run).
 *
 * Transport is SSH (via `ssh-exec.ts`), never a daemon: SSH is the one hardened
 * choke point already used everywhere, and it gives auth + encryption + host-key
 * trust for free. Read-only commands stream synchronously (`sshStream`); the one
 * long-running case — `teams start --watch` — dispatches detached so the remote
 * supervisor outlives a dropped connection.
 *
 * Commands with their own richer `--host` handling (`run`/`sessions`/`feed`/
 * `computer`/`secrets`/`logs`/…) are listed in {@link OWN_HOST_COMMANDS} and
 * fall through to their local actions. Everything else either routes via this
 * table or, when `--host`/`--device` is present, exits with a clear
 * "not supported" message — never commander's raw `unknown option`.
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

/**
 * First-class groups that run transparently on a remote via SSH when
 * `--host`/`--device` is present. Keep both canonical names and aliases
 * (`repo`/`repos`, `exec`/`run`) so either argv form routes the same way.
 *
 * Prefer adding here over per-command SSH code — this is the single choke point.
 */
const REMOTE_PASSTHROUGH: Record<string, RemoteSpec> = {
  // status / inspect
  view: {},
  inspect: {},
  doctor: {},
  status: {},
  check: {},
  list: {},
  usage: {},
  cost: {},
  output: {},
  budget: {},
  // config / resources
  sync: { nonInteractive: ['--yes'] },
  pull: {},
  push: {},
  repo: {},
  repos: {},
  plugins: {},
  skills: {},
  hooks: {},
  commands: {},
  rules: {},
  memory: {},
  permissions: {},
  perms: {},
  mcp: {},
  cli: {},
  subagents: {},
  workflows: {},
  packages: {},
  models: {},
  profiles: {},
  defaults: {},
  alias: {},
  // lifecycle
  teams: {},
  message: {},
  routines: {},
  jobs: {},
  cron: {},
  // misc remote-sensible
  prune: {},
  trash: {},
  restore: {},
  worktree: {},
  events: {},
  audit: {},
  lock: {},
  feedback: {},
  wallet: {},
  daemon: {},
  pty: {},
  tmux: {},
  watchdog: {},
  factory: {},
  browser: {},
  versions: {},
};

/**
 * Commands that register and interpret `--host`/`--device` themselves — must
 * fall through to local commander even when the flag is present. Do not add
 * these to {@link REMOTE_PASSTHROUGH}.
 */
const OWN_HOST_COMMANDS = new Set([
  'run',
  'exec', // deprecated alias of run
  'sessions',
  'feed',
  'computer',
  'secrets',
  'logs',
  'hosts',
  'ssh',
  'devices',
  'fleet', // alias of devices
]);

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
 * host-routable and a `--host` (or its `--device` alias) was given. Returns
 * `false` (run locally) when neither flag is present, the command owns its own
 * host handling, the target is this very machine, or placement flags need the
 * local action. Returns `true` after printing a clear error when the flag is
 * present on a command that is neither routable nor self-handling — so the user
 * never sees commander's raw `unknown option '--host'`.
 *
 * @param command the resolved subcommand name (`process.argv`'s first non-flag).
 * @param allArgs `process.argv.slice(2)` — the command name followed by its args.
 */
export async function maybeRunOnHost(command: string, allArgs: string[]): Promise<boolean> {
  const hostFlag = flagValue(allArgs, 'host', 'H');
  const deviceFlag = flagValue(allArgs, 'device');
  const hostName = hostFlag ?? deviceFlag;
  if (!hostName) return false;

  // Commands with their own richer --host semantics must reach local commander
  // BEFORE any single-target conflict gate. sessions/feed merge --host and
  // --device into a multi-host list; rejecting "conflicting" pairs would break
  // `agents sessions --host a --device b` / `agents feed --host a --device b`.
  if (OWN_HOST_COMMANDS.has(command)) return false;

  // Placement, not routing: `teams add`/`teams create` read `--device`/`--devices`
  // (and `--host`/`--hosts`) as WHERE to place a teammate / the team pool — the
  // command itself always runs locally on the orchestrator. Bail before the
  // generic teams routing below so those flags reach the local action. Every
  // other teams subcommand (`status`/`logs`/`stop`/…) keeps `--host` routing.
  // Find the subcommand = the first non-flag token AFTER `teams` (robust to any
  // leading global flags), then bail for the add/create aliases.
  if (command === 'teams') {
    const teamsIdx = allArgs.indexOf('teams');
    const sub = teamsIdx >= 0 ? allArgs.slice(teamsIdx + 1).find((a) => !a.startsWith('-')) : undefined;
    if (sub === 'add' || sub === 'a' || sub === 'create' || sub === 'c' || sub === 'new') {
      return false;
    }
  }

  // `--hosts` is always a generic fleet flag — bail for every command so the
  // local aggregator handles it. `--devices` is fan-out on most commands but
  // a placement flag on `routines` (which devices may run the routine), so
  // only exempt routines from the bail.
  if (allArgs.includes('--hosts')) return false;
  if (allArgs.includes('--devices') && command !== 'routines') return false;

  const spec = REMOTE_PASSTHROUGH[command];
  if (!spec) {
    // Flag was accepted (no raw commander "unknown option") but this group has
    // no remote semantics — say so clearly instead of falling through.
    console.error(
      chalk.red(
        `\`agents ${command}\` does not support --host/--device (no remote interpretation).`,
      ) +
        chalk.gray(
          ' Run without the flag, or use a host-routable group (repos, view, sync, teams, doctor, …).',
        ),
    );
    process.exitCode = 1;
    return true;
  }

  // Single-target remote path only: reject a conflicting --host/--device pair
  // rather than silently preferring one (same rule as `agents run`).
  if (hostFlag && deviceFlag && hostFlag !== deviceFlag) {
    console.error(chalk.red('Conflicting --host/--device values — pass just one.'));
    process.exitCode = 1;
    return true;
  }

  // Running against your own machine is just a local run — skip the SSH round-trip.
  // `machineId()` is the same self-identifier the device registry and session
  // sync use (lowercased short hostname); compare case-insensitively.
  // Strip the routing flags from process.argv so the local command never sees
  // an unregistered `--host`/`--device` and dies with "unknown option".
  if (hostName.toLowerCase() === machineId()) {
    const stripped = stripRoutingFlags(allArgs, STRIP_SPECS);
    process.argv = [process.argv[0], process.argv[1], ...stripped];
    return false;
  }

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

  // Doctor commands probe the agent CLIs; remote POSIX login shells often don't
  // have the agents shims on PATH, which produces false "not installed" negatives.
  // Bootstrap PATH with the canonical shim locations before the remote command.
  // Windows is skipped: PowerShell usually has the shim dir via the install
  // profile, and single-quoted env values would not expand $HOME/$PATH.
  const isDoctorCommand =
    command === 'doctor' || (command === 'teams' && forwarded[1] === 'doctor');
  const remoteOs = resolveRemoteOsSync(host.name);
  const env = isDoctorCommand && !/^win/i.test((remoteOs ?? '').trim())
    ? { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' }
    : undefined;
  const remoteCmd = buildRemoteAgentsInvocation(forwarded, remoteCwd, remoteOs, env);
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
