/**
 * `agents devices` (registry) + `agents ssh` (smart wrapper).
 *
 * `agents devices` keeps a registry of SSH device profiles — platform, login
 * user, address, and auth — self-populated from `tailscale status --json`.
 * `agents ssh <name>` then connects through one hardened path: preflight
 * (offline → fail fast instead of a 2-minute hang), platform-aware exec
 * (PowerShell on Windows), and password-from-bundle auth via an askpass shim.
 * Rendering the registry to an ssh_config include also lets plain ssh / scp /
 * rsync / `agents sessions --host` resolve the same logical names.
 */

import type { Command } from 'commander';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { readAndResolveBundleEnv, isHeadlessSecretsContext } from '../lib/secrets/bundles.js';
import { machineId } from '../lib/session/sync/config.js';
import {
  addIgnored,
  getDevice,
  loadDevices,
  loadIgnored,
  removeDevice,
  removeIgnored,
  upsertDevice,
  type DeviceAuthMethod,
  type DevicePlatform,
  type DeviceProfile,
  type DeviceRegistry,
} from '../lib/devices/registry.js';
import {
  nodeToDeviceInput,
  parseTailscaleStatus,
  tailscaleStatusJson,
} from '../lib/devices/tailscale.js';
import { localLoginUser, planDeviceReconciliation, runDeviceSync, withDefaultUser } from '../lib/devices/sync.js';
import { resolveDeviceTarget, splitUserHost } from '../lib/devices/resolve-target.js';
import { clearPendingSentinel } from '../lib/devices/pending.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { hostNameFor, renderSshConfig } from '../lib/devices/ssh-config.js';
import {
  ASKPASS_BUNDLE_ENV,
  ASKPASS_KEY_ENV,
  buildSshInvocation,
  writeAskpassShim,
} from '../lib/devices/connect.js';
import {
  planFleetTargets,
  runFleet,
  skipLabel,
  upgradeCommand,
  type FleetRunResult,
} from '../lib/devices/fleet.js';
import {
  fleetCapacity,
  fmtBytes,
  headroom,
  probeFleetStats,
  type DeviceStats,
  type Headroom,
} from '../lib/devices/health.js';

/** One-line summary of a device for `list`. `isSelf` marks the machine this
 * command is running on so it stands out from the rest of the tailnet. */
function deviceSummary(d: DeviceProfile, isSelf = false): string {
  const addr = hostNameFor(d) ?? chalk.gray('no address');
  const online = d.tailscale
    ? d.tailscale.online
      ? chalk.green('online')
      : chalk.gray('offline')
    : chalk.gray('unknown');
  const reach = d.tailscale?.online && !d.tailscale.direct ? chalk.yellow(' (relayed)') : '';
  const marker = isSelf ? chalk.cyan('▸ ') : '  ';
  const name = isSelf ? chalk.bold.cyan(d.name.padEnd(16)) : chalk.bold(d.name.padEnd(16));
  const here = isSelf ? chalk.cyan('  ← this machine') : '';
  return `${marker}${name} ${String(d.platform).padEnd(8)} ${(d.user ? d.user + '@' : '') + addr}  ${online}${reach}${here}`;
}

const HEADROOM_BADGE: Record<Headroom, string> = {
  idle: chalk.green('○ idle'),
  light: chalk.green('● light'),
  busy: chalk.yellow('● busy'),
  loaded: chalk.red('● loaded'),
  unknown: chalk.gray('· —'),
};

/** A right-aligned percentage cell, colored by severity (green/yellow/red). */
function pctCell(v: number | undefined, width: number): string {
  if (v === undefined) return chalk.gray('—'.padStart(width));
  const s = `${Math.round(v)}%`.padStart(width);
  if (v < 40) return chalk.green(s);
  if (v < 75) return chalk.yellow(s);
  return chalk.red(s);
}

/**
 * Render the device list. When `statsMap` is provided, resource columns are
 * appended — normalized load, memory, a headroom badge, and (in `full` mode)
 * core count and free/total memory — so it's obvious which boxes have room.
 * Without it (probe skipped) the classic reachability line is used. A fleet
 * capacity summary is appended whenever stats were gathered.
 */
function renderDeviceTable(
  reg: DeviceRegistry,
  names: string[],
  self: string | undefined,
  statsMap?: Map<string, DeviceStats>,
  full = false,
): string[] {
  if (!statsMap) return names.map((n) => deviceSummary(reg[n], n === self));

  const lines: string[] = [];
  const head =
    '  ' +
    chalk.gray('device'.padEnd(16)) +
    chalk.gray('platform'.padEnd(8)) +
    ' ' +
    (full ? chalk.gray('cores'.padStart(6)) : '') +
    chalk.gray('load'.padStart(5)) +
    chalk.gray('mem'.padStart(6)) +
    (full ? '  ' + chalk.gray('free/total'.padEnd(12)) : '') +
    '  ' +
    chalk.gray('headroom');
  lines.push(head);

  for (const name of names) {
    const d = reg[name];
    const isSelf = name === self;
    const marker = isSelf ? chalk.cyan('▸ ') : '  ';
    const label = isSelf ? chalk.bold.cyan(name.padEnd(16)) : chalk.bold(name.padEnd(16));
    const plat = String(d.platform).padEnd(8);
    const offline = d.tailscale && !d.tailscale.online;
    const stats = statsMap.get(name);
    if (offline) {
      lines.push(`${marker}${label}${plat} ${chalk.gray('offline')}`);
      continue;
    }
    const relay = !isSelf && d.tailscale?.online && !d.tailscale.direct ? chalk.yellow(' relay') : '';
    const cores = full ? chalk.gray(String(stats?.ncpu ?? '—').padStart(6)) : '';
    const load = pctCell(stats?.loadPercent, 5);
    const mem = pctCell(stats?.memPercent, 6);
    const freeTotal = full
      ? '  ' +
        (stats?.reachable && stats.memTotalBytes
          ? `${fmtBytes(stats.memFreeBytes)}/${fmtBytes(stats.memTotalBytes)}`.padEnd(12)
          : chalk.gray('—'.padEnd(12)))
      : '';
    const badge = HEADROOM_BADGE[headroom(stats)];
    const here = isSelf ? chalk.cyan('  ← this machine') : '';
    lines.push(`${marker}${label}${plat} ${cores}${load}${mem}${freeTotal}  ${badge}${relay}${here}`);
  }

  // Fleet capacity summary — total cores + how much RAM is free right now.
  const cap = fleetCapacity(statsMap.values());
  if (cap.reachable > 0) {
    const freePct = cap.memTotalBytes > 0 ? Math.round((cap.memFreeBytes / cap.memTotalBytes) * 100) : 0;
    lines.push(
      chalk.gray(
        `  Fleet capacity: ${cap.cores} cores · ${fmtBytes(cap.memFreeBytes)} free / ${fmtBytes(cap.memTotalBytes)} RAM (${freePct}% free) across ${cap.reachable} reachable device${cap.reachable === 1 ? '' : 's'}`,
      ),
    );
  }
  return lines;
}

/** Resolve a device or exit with a clear error. */
async function mustGetDevice(name: string): Promise<DeviceProfile> {
  const d = await getDevice(name);
  if (!d) {
    console.error(chalk.red(`Unknown device '${name}'. See 'agents devices list'.`));
    process.exit(1);
  }
  return d;
}

/**
 * Interactive `agents devices sync`: discover tailscale nodes, present a
 * checkbox pre-checked with what's already registered, and reconcile the
 * choice. Checked = registered (and un-ignored). Unchecked = removed from the
 * registry AND added to the ignore-list, so auto-discovery never re-suggests
 * it — this is the "click to register/unregister" surface, with dismissals that
 * stick.
 */
async function runInteractiveDeviceSync(): Promise<void> {
  const spinner = ora('Reading tailscale status...').start();
  let nodes;
  try {
    nodes = parseTailscaleStatus(tailscaleStatusJson());
  } catch (err: any) {
    spinner.fail(err.message);
    process.exit(1);
  }
  const [reg, ignored] = await Promise.all([loadDevices(), loadIgnored()]);
  const registered = new Set(Object.keys(reg));
  spinner.stop();

  if (nodes.length === 0) {
    console.log(chalk.gray('No tailscale nodes found.'));
    return;
  }

  const { checkbox } = await import('@inquirer/prompts');
  let selected: string[];
  try {
    selected = await checkbox({
      // Everything not already dismissed starts checked, so pressing Enter keeps
      // the fleet as-is (matching what auto-sync would register). Unchecking a
      // device removes it AND dismisses it so auto-sync never re-adds it.
      message: 'Your fleet — uncheck a device to remove and stop suggesting it:',
      pageSize: Math.min(nodes.length, 20),
      choices: nodes.map((n) => {
        const flags = [n.platform, n.online ? undefined : 'offline', ignored.has(n.name) ? 'ignored' : undefined]
          .filter(Boolean)
          .join(', ');
        return { value: n.name, name: `${n.name}  ${chalk.gray(`(${flags})`)}`, checked: !ignored.has(n.name) };
      }),
    });
  } catch (err) {
    if (isPromptCancelled(err)) {
      console.log(chalk.gray('Cancelled — no changes.'));
      return;
    }
    throw err;
  }

  const byName = new Map(nodes.map((n) => [n.name, n]));
  const plan = planDeviceReconciliation(byName.keys(), selected, registered, ignored);
  const localUser = localLoginUser();
  for (const name of plan.toRegister) {
    const input = withDefaultUser(nodeToDeviceInput(byName.get(name)!), reg[name]?.user, localUser);
    await upsertDevice(name, input);
  }
  for (const name of plan.toUnignore) await removeIgnored(name);
  for (const name of plan.toRemove) await removeDevice(name);
  for (const name of plan.toIgnore) await addIgnored(name);

  const parts = [
    chalk.green(`${plan.toRegister.length} registered`),
    plan.toRemove.length ? chalk.yellow(`${plan.toRemove.length} removed`) : null,
    plan.toIgnore.length ? chalk.gray(`${plan.toIgnore.length} ignored`) : null,
  ].filter(Boolean);
  console.log(parts.join(chalk.gray(' · ')));
}

/** Print a per-device result table for fleet update/run. */
function printFleetResults(results: FleetRunResult[]): void {
  const nameW = Math.max(8, ...results.map((r) => r.name.length));
  console.log(
    chalk.bold('DEVICE'.padEnd(nameW)) + '  ' +
    chalk.bold('STATUS'.padEnd(8)) + '  ' +
    chalk.bold('DETAIL'),
  );
  for (const r of results) {
    const status =
      r.status === 'ok' ? chalk.green('ok'.padEnd(8)) :
      r.status === 'skipped' ? chalk.gray('skipped'.padEnd(8)) :
      chalk.red('failed'.padEnd(8));
    const detail =
      r.status === 'skipped' ? chalk.gray(skipLabel(r.reason as 'offline' | 'no-address')) :
      r.status === 'failed' ? chalk.red(r.detail || `exit ${r.code ?? '?'}`) :
      chalk.gray(r.code === 0 ? 'exit 0' : '');
    console.log(`${r.name.padEnd(nameW)}  ${status}  ${detail}`);
  }
  const ok = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  console.log(chalk.gray(`${ok} ok · ${failed} failed · ${skipped} skipped`));
  if (failed > 0) process.exitCode = 1;
}

/** Register the `agents devices` command tree (also aliased as `fleet`). */
function registerDevicesCommands(program: Command): void {
  const devicesCmd = program
    .command('devices')
    .alias('fleet')
    .description('Registry of SSH device profiles (platform, user, address, auth), self-populated from Tailscale. Alias: fleet.')
    .addHelpText('after', `
Typical workflow:
  agents devices sync            # curate: pick which tailscale nodes to keep (TTY)
  agents devices sync --yes      # non-interactive: register all non-ignored nodes
  agents devices list            # see what's registered
  agents devices ignore ipad165  # dismiss a node so it's never re-suggested
  agents devices set win-mini --auth password --bundle muqsit
  agents devices render --write  # write ~/.ssh/config.d/agents include
  agents fleet update            # roll out latest agents-cli to every online device
  agents fleet run uname -a      # run a command on every online device

\`agents fleet\` is an alias for \`agents devices\` — same subcommands.
`);

  devicesCmd
    .command('sync')
    .description('Ingest `tailscale status --json` into device profiles. In a terminal, opens a checkbox to register/unregister nodes; with --yes, registers every non-ignored node.')
    .option('--yes', 'skip the picker; register all discovered non-ignored nodes')
    .action(async (opts: { yes?: boolean }) => {
      if (isInteractiveTerminal() && !opts.yes) {
        await runInteractiveDeviceSync();
        return;
      }
      const spinner = ora('Reading tailscale status...').start();
      try {
        const res = await runDeviceSync();
        const extra = res.pending.length ? chalk.gray(` (${res.pending.length} new)`) : '';
        spinner.succeed(`Synced ${res.synced} device${res.synced === 1 ? '' : 's'} from Tailscale${extra}`);
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
      }
    });

  devicesCmd
    .command('register <name>')
    .description('Register a discovered (pending) node by name — used by the menu-bar "NEW DEVICES → Register" action.')
    .action(async (name: string) => {
      try {
        const nodes = parseTailscaleStatus(tailscaleStatusJson());
        const node = nodes.find((n) => n.name === name);
        if (!node) {
          console.error(chalk.red(`'${name}' is not a current tailscale node. See 'agents devices sync'.`));
          process.exit(1);
        }
        await removeIgnored(name); // a re-registered node is no longer dismissed
        const d = await upsertDevice(name, nodeToDeviceInput(node));
        clearPendingSentinel(name); // drop the notification immediately
        console.log(chalk.green(`Registered '${name}'`) + chalk.gray(` (${d.platform})`));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('ignore <name>')
    .description('Dismiss a node from auto-discovery so it is never re-suggested (and remove it from the registry if present).')
    .action(async (name: string) => {
      try {
        await removeDevice(name);
        await addIgnored(name);
        clearPendingSentinel(name); // drop the notification immediately
        console.log(chalk.green(`Ignored '${name}'`) + chalk.gray(" — it won't be suggested again. Undo with `agents devices unignore`."));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('unignore <name>')
    .description('Undo `ignore`: allow a node to be discovered and registered again.')
    .action(async (name: string) => {
      const ok = await removeIgnored(name);
      if (!ok) {
        console.error(chalk.gray(`'${name}' was not ignored.`));
        return;
      }
      console.log(chalk.green(`No longer ignoring '${name}'`) + chalk.gray(' — run `agents devices sync` to register it.'));
    });

  devicesCmd
    .command('list')
    .alias('ls')
    .description('List registered devices with platform, address, reachability, and live resource headroom.')
    .option('--json', 'output the registry as a JSON array (for scripts and hooks)')
    .option('--no-stats', 'skip the live resource probe (instant; names/addresses only)')
    .option('-f, --full', 'full mode: add per-device core count and free/total memory')
    .action(async (opts: { json?: boolean; stats?: boolean; full?: boolean }) => {
      const reg = await loadDevices();
      const names = Object.keys(reg).sort();
      if (opts.json) {
        // Registry-only, always fast — the Factory extension polls this path.
        process.stdout.write(JSON.stringify(names.map((n) => reg[n]), null, 2) + '\n');
        return;
      }
      if (names.length === 0) {
        console.log(chalk.gray("No devices. Run 'agents devices sync' or 'agents devices add <name> <user@host>'."));
        return;
      }
      const self = machineId();

      let statsMap: Map<string, DeviceStats> | undefined;
      if (opts.stats !== false) {
        // Probe only reachable devices, in parallel, bounded by the per-probe
        // timeout — a slow box degrades to "—", it never hangs the table.
        const probeable = planFleetTargets(reg)
          .filter((t) => !t.skip)
          .map((t) => t.device);
        const spinner = isInteractiveTerminal()
          ? ora(`Probing ${probeable.length} device${probeable.length === 1 ? '' : 's'}…`).start()
          : undefined;
        try {
          statsMap = await probeFleetStats(probeable, { selfName: self });
        } finally {
          spinner?.stop();
        }
      }

      console.log(chalk.bold(`Devices (${names.length})`));
      for (const line of renderDeviceTable(reg, names, self, statsMap, opts.full)) console.log(line);
    });

  devicesCmd
    .command('show <name>')
    .description('Show the full profile for one device.')
    .action(async (name: string) => {
      const d = await mustGetDevice(name);
      console.log(JSON.stringify(d, null, 2));
    });

  devicesCmd
    .command('add <name> <target>')
    .description('Add a device manually (target is user@host or host).')
    .option('--platform <platform>', 'windows | linux | macos')
    .action(async (name: string, target: string, opts: { platform?: string }) => {
      try {
        const { host, user } = splitUserHost(target);
        const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
        const d = await upsertDevice(name, {
          platform: (opts.platform as DevicePlatform) ?? undefined,
          user,
          address: { via: 'manual', dnsName: isIp ? undefined : host, ip: isIp ? host : undefined },
        });
        console.log(chalk.green(`Added device '${name}'`) + chalk.gray(` (${d.platform}, ${user ? user + '@' : ''}${host})`));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('set <name>')
    .description('Update fields on an existing device (platform, user, auth).')
    .option('--platform <platform>', 'windows | linux | macos')
    .option('--user <user>', 'login user')
    .option('--auth <method>', 'key | password')
    .option('--bundle <bundle>', 'secrets bundle holding the password (for --auth password)')
    .option('--bundle-key <key>', "key within the bundle (default 'password')")
    .action(async (name: string, opts: { platform?: string; user?: string; auth?: string; bundle?: string; bundleKey?: string }) => {
      try {
        const existing = await mustGetDevice(name);
        const auth = opts.auth || opts.bundle || opts.bundleKey
          ? {
              method: (opts.auth as DeviceAuthMethod) ?? existing.auth.method,
              bundle: opts.bundle ?? existing.auth.bundle,
              bundleKey: opts.bundleKey ?? existing.auth.bundleKey,
            }
          : undefined;
        const d = await upsertDevice(name, {
          platform: (opts.platform as DevicePlatform) ?? undefined,
          user: opts.user ?? undefined,
          auth,
        });
        console.log(chalk.green(`Updated device '${name}'`) + chalk.gray(` (auth: ${d.auth.method}${d.auth.bundle ? ` via ${d.auth.bundle}` : ''})`));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  devicesCmd
    .command('rm <name>')
    .alias('remove')
    .description('Remove a device from the registry.')
    .action(async (name: string) => {
      const ok = await removeDevice(name);
      if (!ok) {
        console.error(chalk.red(`Unknown device '${name}'.`));
        process.exit(1);
      }
      console.log(chalk.green(`Removed device '${name}'`));
    });

  devicesCmd
    .command('render')
    .description('Render the registry to ssh_config. Prints to stdout, or use --write to update ~/.ssh/config.d/agents.')
    .option('--write', 'write to ~/.ssh/config.d/agents instead of printing')
    .action(async (opts: { write?: boolean }) => {
      const reg = await loadDevices();
      const text = renderSshConfig(reg);
      if (!opts.write) {
        process.stdout.write(text);
        return;
      }
      const dir = path.join(os.homedir(), '.ssh', 'config.d');
      const file = path.join(dir, 'agents');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, text, { mode: 0o600 });
      console.log(chalk.green(`Wrote ${file}`));
      console.log(chalk.gray('Add this to ~/.ssh/config (once):  Include config.d/agents'));
    });

  devicesCmd
    .command('update')
    .description('Roll out agents-cli to every online registered device (`agents upgrade --yes` on each). Offline devices are skipped.')
    .argument('[version]', 'Target version or dist-tag (default: latest)')
    .action(async (version: string | undefined) => {
      let cmd: string[];
      try {
        cmd = upgradeCommand(version);
      } catch (err: any) {
        console.error(chalk.red(err?.message ?? err));
        process.exit(1);
      }
      const reg = await loadDevices();
      const targets = planFleetTargets(reg);
      if (targets.length === 0) {
        console.log(chalk.gray("No devices. Run 'agents devices sync' first."));
        return;
      }
      console.log(chalk.gray(`Running \`${cmd.join(' ')}\` on ${targets.filter((t) => !t.skip).length} online device(s)…`));
      const results = runFleet(targets, cmd);
      printFleetResults(results);
    });

  devicesCmd
    .command('run <cmd...>')
    .description('Run a command on every online registered device. Offline devices are skipped. Alias surface: agents fleet run …')
    .allowUnknownOption()
    .action(async (cmd: string[]) => {
      if (!cmd.length) {
        console.error(chalk.red('Usage: agents fleet run <cmd...>'));
        process.exit(1);
      }
      const reg = await loadDevices();
      const targets = planFleetTargets(reg);
      if (targets.length === 0) {
        console.log(chalk.gray("No devices. Run 'agents devices sync' first."));
        return;
      }
      console.log(chalk.gray(`Running \`${cmd.join(' ')}\` on ${targets.filter((t) => !t.skip).length} online device(s)…`));
      const results = runFleet(targets, cmd);
      printFleetResults(results);
    });
}

/** Register the `agents ssh` smart wrapper. */
function registerSshWrapper(program: Command): void {
  const sshCmd = program
    .command('ssh <name> [cmd...]')
    .description('Connect to a registered device. Preflights reachability, picks the right shell, and authenticates (key or password-from-bundle).')
    .allowUnknownOption()
    .addHelpText('after', `
Examples:
  agents ssh win-mini                       # interactive login
  agents ssh win-mini hostname              # run a command (PowerShell on Windows)
  agents ssh yosemite-s0 uptime             # run a command (POSIX)

Devices come from 'agents devices'. Password auth pulls the secret from a
secrets bundle via an askpass shim — the password never touches argv.
`)
    .action(async (name: string, cmd: string[]) => {
      // Hidden askpass bridge: ssh execs the shim, which re-invokes us here.
      if (name === '__askpass') {
        await runAskpass();
        return;
      }
      // Accept the full fleet target grammar: a registered `name`, a
      // `user@device` (same device, login user overridden — dialed via its
      // Tailscale route, not LAN DNS), or an ad-hoc `user@host`/`host` literal.
      // A bare unregistered alias still errors as "Unknown device".
      const device = resolveDeviceTarget(name, await loadDevices());
      if (!device) {
        console.error(chalk.red(`Unknown device '${name}'. See 'agents devices list'.`));
        process.exit(1);
      }

      // Preflight: a device Tailscale last saw offline would otherwise hang
      // for the full ConnectTimeout. Fail fast with a clear message instead.
      if (device.tailscale && !device.tailscale.online) {
        console.error(chalk.red(`Device '${device.name}' is offline (Tailscale last saw it ${device.tailscale.lastSeen ?? 'a while ago'}).`));
        console.error(chalk.gray("Run 'agents devices sync' to refresh reachability."));
        process.exit(1);
      }
      if (device.tailscale?.online && !device.tailscale.direct) {
        console.error(chalk.yellow(`Note: connection to '${device.name}' is relayed (DERP ${device.tailscale.relay ?? '?'}) — expect higher latency.`));
      }

      try {
        const shim = writeAskpassShim();
        const { args, env } = buildSshInvocation(device, cmd, shim);
        const res = spawnSync('ssh', args, {
          stdio: 'inherit',
          env: { ...process.env, ...env },
        });
        process.exit(res.status ?? 1);
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  // Keep the hidden askpass invocation out of help.
  void sshCmd;
}

/**
 * The askpass side of password auth. Invoked by the shim (which ssh execs with
 * SSH_ASKPASS): read the target bundle/key from the environment the wrapper
 * set, resolve it through the existing Keychain path, and print the password
 * to stdout for ssh to consume.
 */
async function runAskpass(): Promise<void> {
  const bundle = process.env[ASKPASS_BUNDLE_ENV];
  const key = process.env[ASKPASS_KEY_ENV] ?? 'password';
  if (!bundle) {
    console.error(`askpass: ${ASKPASS_BUNDLE_ENV} not set`);
    process.exit(1);
  }
  try {
    const { env } = readAndResolveBundleEnv(bundle, { caller: 'agents ssh', agentOnly: isHeadlessSecretsContext() });
    const value = env[key];
    if (value === undefined) {
      console.error(`askpass: key '${key}' not found in bundle '${bundle}'`);
      process.exit(1);
    }
    process.stdout.write(value);
  } catch (err: any) {
    console.error(`askpass: ${err?.message ?? err}`);
    process.exit(1);
  }
}

/** Register both `agents ssh` and `agents devices`. */
export function registerSshCommands(program: Command): void {
  registerSshWrapper(program);
  registerDevicesCommands(program);
}
