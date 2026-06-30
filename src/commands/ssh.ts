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
import { readAndResolveBundleEnv } from '../lib/secrets/bundles.js';
import {
  getDevice,
  loadDevices,
  removeDevice,
  upsertDevice,
  type DeviceAuthMethod,
  type DevicePlatform,
  type DeviceProfile,
} from '../lib/devices/registry.js';
import {
  nodeToDeviceInput,
  parseTailscaleStatus,
  tailscaleStatusJson,
} from '../lib/devices/tailscale.js';
import { hostNameFor, renderSshConfig } from '../lib/devices/ssh-config.js';
import {
  ASKPASS_BUNDLE_ENV,
  ASKPASS_KEY_ENV,
  buildSshInvocation,
  writeAskpassShim,
} from '../lib/devices/connect.js';

/** Parse `user@host` or `host` into pieces. */
function parseTarget(target: string): { host: string; user?: string } {
  const at = target.indexOf('@');
  if (at === -1) return { host: target };
  return { user: target.slice(0, at), host: target.slice(at + 1) };
}

/** One-line summary of a device for `list`. */
function deviceSummary(d: DeviceProfile): string {
  const addr = hostNameFor(d) ?? chalk.gray('no address');
  const online = d.tailscale
    ? d.tailscale.online
      ? chalk.green('online')
      : chalk.gray('offline')
    : chalk.gray('unknown');
  const reach = d.tailscale?.online && !d.tailscale.direct ? chalk.yellow(' (relayed)') : '';
  return `  ${chalk.bold(d.name.padEnd(16))} ${String(d.platform).padEnd(8)} ${(d.user ? d.user + '@' : '') + addr}  ${online}${reach}`;
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

/** Register the `agents devices` command tree. */
function registerDevicesCommands(program: Command): void {
  const devicesCmd = program
    .command('devices')
    .description('Registry of SSH device profiles (platform, user, address, auth), self-populated from Tailscale.')
    .addHelpText('after', `
Typical workflow:
  agents devices sync            # ingest tailscale nodes (auto-detect platform)
  agents devices list            # see what's registered
  agents devices set win-mini --auth password --bundle muqsit
  agents devices render --write  # write ~/.ssh/config.d/agents include
`);

  devicesCmd
    .command('sync')
    .description('Ingest `tailscale status --json` and create/update device profiles (auto-detects platform, address, reachability).')
    .action(async () => {
      const spinner = ora('Reading tailscale status...').start();
      try {
        const nodes = parseTailscaleStatus(tailscaleStatusJson());
        spinner.text = `Updating ${nodes.length} device${nodes.length === 1 ? '' : 's'}...`;
        for (const node of nodes) {
          await upsertDevice(node.name, nodeToDeviceInput(node));
        }
        spinner.succeed(`Synced ${nodes.length} device${nodes.length === 1 ? '' : 's'} from Tailscale`);
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
      }
    });

  devicesCmd
    .command('list')
    .alias('ls')
    .description('List registered devices with platform, address, and reachability.')
    .action(async () => {
      const reg = await loadDevices();
      const names = Object.keys(reg).sort();
      if (names.length === 0) {
        console.log(chalk.gray("No devices. Run 'agents devices sync' or 'agents devices add <name> <user@host>'."));
        return;
      }
      console.log(chalk.bold(`Devices (${names.length})`));
      for (const name of names) console.log(deviceSummary(reg[name]));
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
        const { host, user } = parseTarget(target);
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
      const device = await mustGetDevice(name);

      // Preflight: a device Tailscale last saw offline would otherwise hang
      // for the full ConnectTimeout. Fail fast with a clear message instead.
      if (device.tailscale && !device.tailscale.online) {
        console.error(chalk.red(`Device '${name}' is offline (Tailscale last saw it ${device.tailscale.lastSeen ?? 'a while ago'}).`));
        console.error(chalk.gray("Run 'agents devices sync' to refresh reachability."));
        process.exit(1);
      }
      if (device.tailscale?.online && !device.tailscale.direct) {
        console.error(chalk.yellow(`Note: connection to '${name}' is relayed (DERP ${device.tailscale.relay ?? '?'}) — expect higher latency.`));
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
    const { env } = readAndResolveBundleEnv(bundle, { caller: 'agents ssh' });
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
