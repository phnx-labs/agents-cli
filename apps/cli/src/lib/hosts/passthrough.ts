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
import { dispatchAgentsCommand, withActorEnv } from './dispatch.js';
import {
  stripRoutingFlags,
  buildRemoteAgentsInvocation,
  HOST_ROUTING_SPECS,
  type StripSpec,
} from './remote-cmd.js';
import { resolveRemoteOsSync } from './remote-os.js';
import { machineId } from '../session/sync/config.js';
import { loadDevices, type DeviceProfile, type DeviceRegistry } from '../devices/registry.js';
import {
  fanOutDevices,
  planFleetTargets,
  runLocalCommand,
  runOnDevice,
  type FleetSkipReason,
  type FanOutDeviceResult,
} from '../devices/fleet.js';
import { platformGroupLabel } from '../devices/health-report.js';

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
  'harness', // `--host <agent>` names the host CLI to run under, not a remote device
  'harnesses',
  'sessions',
  'feed',
  'activity', // fans `--host`/`--device`/`--devices-all` out itself (feed-style)
  'computer',
  'secrets',
  'logs',
  'hosts',
  'ssh',
  'devices',
  'fleet', // alias of devices
  'apply', // `--device` scopes the fleet reconcile to one device (it targets devices itself)
  'monitors', // `--device` names the OWNER machine (pin-to-one), not a routing target
]);

/** `--no-tty` is stripped like the routing flags but carries no value. The plural
 * fleet flags are stripped only when we handle the `all` sentinel ourselves;
 * otherwise they fall through to command-level aggregators. */
const STRIP_SPECS: StripSpec[] = [
  ...HOST_ROUTING_SPECS,
  { long: 'no-tty', takesValue: false },
  { long: 'hosts', takesValue: true },
  { long: 'devices', takesValue: true },
];

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

/** Injectable dependencies for {@link runFleetPassthrough} — used by tests. */
export interface FleetPassthroughOptions {
  /** Override the device registry loader (tests). */
  loadDevices?: () => Promise<DeviceRegistry>;
  /** Override the per-device runner (tests). Defaults to `runOnDevice`. */
  runner?: typeof runOnDevice;
  /** Override the local runner for the self device (tests). Defaults to `runLocalCommand`. */
  localRunner?: typeof runLocalCommand;
  /** Override this machine's id (tests). Defaults to `machineId()`. */
  self?: string;
}

interface FleetTargetWithDevice {
  name: string;
  device: DeviceProfile;
  skip?: FleetSkipReason;
}

/** Detect the `all` sentinel on any routing flag. */
function isFleetAllSentinel(
  hostFlag: string | undefined,
  deviceFlag: string | undefined,
  hostsFlag: string | undefined,
  devicesFlag: string | undefined,
): boolean {
  return (
    hostFlag?.toLowerCase() === 'all' ||
    deviceFlag?.toLowerCase() === 'all' ||
    hostsFlag?.toLowerCase() === 'all' ||
    devicesFlag?.toLowerCase() === 'all'
  );
}

/** Strip routing flags from the argv and ensure the per-device call emits JSON. */
function buildFleetForwardedArgs(allArgs: string[]): string[] {
  const stripped = stripRoutingFlags(allArgs, STRIP_SPECS);
  if (!stripped.includes('--json')) stripped.push('--json');
  return stripped;
}

/** Parse stdout as JSON; on failure return an object describing the error. */
function safeJsonParse(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return { parseError: 'invalid JSON', snippet: stdout.trim().slice(0, 200) };
  }
}

/** One-line summary of a per-device `agents view [agent] --json` payload. */
function summarizeViewResult(forwarded: string[], json: unknown): string {
  // After routing flags are stripped, the agent argument is the first token that
  // is not a flag (e.g. `kimi` in `agents view kimi --json`).
  const agentArg = forwarded.find((a, i) => i > 0 && !a.startsWith('-'));
  // `agents view --json` returns an array; `agents view <agent> --json` returns
  // a single object. Normalize to the per-agent shape.
  const agent = agentArg
    ? (Array.isArray(json) ? (json[0] as any) : (json as any))
    : undefined;
  if (!agentArg) {
    const rows = Array.isArray(json) ? json : [];
    const count = rows.reduce((n, r: any) => n + (r.versions?.length ?? 0), 0);
    return count === 0 ? 'no agents installed' : `${count} version${count === 1 ? '' : 's'}`;
  }
  if (!agent || !Array.isArray(agent.versions) || agent.versions.length === 0) {
    return 'not installed';
  }
  const v = agent.versions.find((x: any) => x.isDefault) ?? agent.versions[0];
  const parts: string[] = [chalk.cyan(String(v.version))];
  if (v.signedIn) {
    parts.push(chalk.green('active'));
    if (v.email) parts.push(chalk.gray(String(v.email)));
  } else {
    parts.push(chalk.gray('signed out'));
  }
  return parts.join(' · ');
}

function formatCompactUsd(usd: number): string {
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
}

function formatCompactTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** One-line summary of a per-device `agents output --json` payload. */
function summarizeOutputResult(json: unknown): string {
  const p = json as any;
  const burn = p?.burn;
  if (!burn || typeof burn !== 'object') return 'ok';
  const parts: string[] = [];
  if (typeof burn.costUsd === 'number') parts.push(`${formatCompactUsd(burn.costUsd)} burned`);
  if (typeof burn.outputTokens === 'number') parts.push(`${formatCompactTokens(burn.outputTokens)} output tokens`);
  const commits = p?.output?.commits;
  if (typeof commits === 'number' && commits > 0) parts.push(`${commits} commits`);
  return parts.length ? parts.join(' · ') : 'ok';
}

/** Best-effort summary of any per-device JSON payload. */
function summarizeResult(command: string, forwarded: string[], json: unknown): string {
  if (command === 'view') return summarizeViewResult(forwarded, json);
  if (command === 'output') return summarizeOutputResult(json);
  return 'ok';
}

const GROUP_ORDER = ['macOS', 'Linux', 'Windows', 'Other'];

/** Render the grouped-by-OS fleet roster from per-device results. */
function renderFleetRoster(
  command: string,
  forwarded: string[],
  results: Array<FanOutDeviceResult<unknown> & { device: DeviceProfile }>,
  self: string,
): void {
  const agentArg = forwarded[1];
  const installed = results.filter((r) => r.status === 'ok').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  const title = agentArg ? `${command} ${agentArg}` : command;
  const summaryParts: string[] = [];
  if (installed) summaryParts.push(`${installed} installed`);
  if (failed) summaryParts.push(`${failed} unreachable`);
  if (skipped) summaryParts.push(`${skipped} skipped`);
  console.log(chalk.bold(title) + chalk.gray(` · ${results.length} device${results.length === 1 ? '' : 's'}`));
  console.log('');

  const nameW = Math.max(6, ...results.map((r) => r.name.length));
  const grouped = new Map<string, Array<FanOutDeviceResult<unknown> & { device: DeviceProfile }>>();
  for (const r of results) {
    const g = platformGroupLabel(r.device.platform);
    (grouped.get(g) ?? grouped.set(g, []).get(g)!).push(r);
  }

  for (const group of GROUP_ORDER) {
    const members = grouped.get(group);
    if (!members || members.length === 0) continue;
    members.sort((a, b) => {
      const aSelf = a.name.toLowerCase() === self.toLowerCase();
      const bSelf = b.name.toLowerCase() === self.toLowerCase();
      return (aSelf ? -1 : bSelf ? 1 : 0) || a.name.localeCompare(b.name);
    });
    console.log(chalk.bold(group));
    for (const r of members) {
      const isSelf = r.name.toLowerCase() === self.toLowerCase();
      const prefix = isSelf ? chalk.cyan('▸') : ' ';
      let glyph: string;
      let text: string;
      if (r.status === 'skipped') {
        glyph = chalk.gray('○');
        text = chalk.gray(String(r.reason ?? 'skipped'));
      } else if (r.status === 'failed') {
        glyph = chalk.red('✕');
        text = chalk.red(String(r.error ?? 'unreachable').split('\n')[0].slice(0, 80));
      } else {
        glyph = chalk.green('●');
        text = summarizeResult(command, forwarded, r.value);
      }
      const selfNote = isSelf ? chalk.cyan('   ← this machine') : '';
      console.log(` ${prefix} ${r.name.padEnd(nameW)}  ${glyph}  ${text}${selfNote}`);
    }
    console.log('');
  }

  if (summaryParts.length) {
    console.log(chalk.gray(summaryParts.join(' · ')));
  }
}

/** Run `agents <command> …` across every registered device and render the roster. */
export async function runFleetPassthrough(
  command: string,
  allArgs: string[],
  spec: RemoteSpec,
  opts: FleetPassthroughOptions = {},
): Promise<boolean> {
  const self = opts.self ?? machineId();
  const registry = await (opts.loadDevices ?? loadDevices)();
  const planned = planFleetTargets(registry);
  const targets: FleetTargetWithDevice[] = planned.map((t) => ({
    name: t.device.name,
    device: t.device,
    skip: t.skip,
  }));

  const forwarded = buildFleetForwardedArgs(allArgs);
  const runner = opts.runner ?? runOnDevice;
  const localRunner = opts.localRunner ?? runLocalCommand;

  const results = await fanOutDevices<unknown, FleetTargetWithDevice>(
    targets,
    async (target) => {
      const cmd = ['agents', ...forwarded];
      const isSelf = target.device.name.toLowerCase() === self.toLowerCase();
      const res = isSelf ? localRunner(cmd) : runner(target.device, cmd);
      if (res.code !== 0) {
        const detail = (res.stderr || res.stdout || 'unreachable').trim().slice(0, 200);
        throw new Error(detail || 'unreachable');
      }
      return safeJsonParse(res.stdout);
    },
    { perDeviceTimeoutMs: 120_000 },
  );

  // Map fan-out results back to typed results with device attached for rendering.
  const typedResults: Array<FanOutDeviceResult<unknown> & { device: DeviceProfile }> = results.map((r, i) => ({
    ...r,
    device: targets[i].device,
  }));

  if (allArgs.includes('--json')) {
    const out: Record<string, unknown> = {};
    for (const r of typedResults) {
      out[r.name] = r.status === 'ok' ? r.value : { error: r.error ?? r.reason ?? 'unknown' };
    }
    console.log(JSON.stringify(out, null, 2));
  } else {
    renderFleetRoster(command, forwarded, typedResults, self);
  }

  const anyFailed = typedResults.some((r) => r.status === 'failed');
  process.exitCode = anyFailed ? 1 : 0;
  return true;
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
export async function maybeRunOnHost(
  command: string,
  allArgs: string[],
  opts?: FleetPassthroughOptions,
): Promise<boolean> {
  const hostFlag = flagValue(allArgs, 'host', 'H');
  const deviceFlag = flagValue(allArgs, 'device');
  const hostsFlag = flagValue(allArgs, 'hosts');
  const devicesFlag = flagValue(allArgs, 'devices');
  const hostName = hostFlag ?? deviceFlag;
  const fleetAll = isFleetAllSentinel(hostFlag, deviceFlag, hostsFlag, devicesFlag);
  // Proceed when any routing flag is present, including the plural fleet flags
  // that may carry the `all` sentinel.
  if (!hostName && !hostsFlag && !devicesFlag) return false;

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

  // `--hosts` / `--devices` are command-level fleet flags unless their value is
  // the `all` sentinel, which this module fans out generically. On `routines`,
  // a non-all `--devices` value is placement (which devices may run the routine).
  if (allArgs.includes('--hosts') && hostsFlag?.toLowerCase() !== 'all') return false;
  if (allArgs.includes('--devices')) {
    if (devicesFlag === undefined) return false; // malformed, let commander error
    const isAll = devicesFlag.toLowerCase() === 'all';
    if (!isAll && command !== 'routines') return false;
  }

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

  // Reject a conflicting --host/--device pair before either the fleet fan-out
  // or single-target path runs. Equal values (e.g. both `all`) are allowed.
  if (hostFlag && deviceFlag && hostFlag !== deviceFlag) {
    console.error(chalk.red('Conflicting --host/--device values — pass just one.'));
    process.exitCode = 1;
    return true;
  }

  // Generic fleet fan-out for the `all` sentinel — before single-host resolution
  // so `all` is never treated as a literal hostname.
  if (fleetAll) {
    return runFleetPassthrough(command, allArgs, spec, opts);
  }

  // After the bailouts and fleet fan-out above, the only remaining path is a
  // single-target --host/--device. Guard for the type checker: plural non-all
  // flags and bare flags were already handled.
  if (!hostName) return false;

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
  const doctorPath = isDoctorCommand && !/^win/i.test((remoteOs ?? '').trim())
    ? { PATH: '$HOME/.agents/.cache/shims:$HOME/.local/bin:$PATH' }
    : undefined;
  // Forward actor provenance (AGENTS_ACTOR*/GIT_*) across the SSH hop, merged
  // UNDER the doctor PATH so that PATH still wins — without this the remote
  // re-resolves the actor from THIS box's SSH_CONNECTION and mis-credits it
  // (RUSH-2028). Flows to both POSIX (export) and Windows ($env:) dialects.
  const env = withActorEnv(doctorPath);
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
