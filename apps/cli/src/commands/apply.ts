/**
 * `agents apply` (alias `ag apply`) — reconcile the whole fleet to a declared
 * profile in one command: install agents-cli + agents, sync config, and
 * propagate login so a machine that's signed in once seeds every device. Kills
 * the "6 hosts x ~8 harnesses = ~48 OAuth flows" slog.
 *
 * The manifest is the `fleet:` block of any `-f` file (default `agents.yaml`).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Command, Option } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { machineId } from '../lib/session/sync/config.js';
import { loadDevices, type DeviceProfile } from '../lib/devices/registry.js';
import { readFleetFile, resolveDesired } from '../lib/fleet/manifest.js';
import { snapshotAuth, materializeAuth, parseAuthBundle, KEYCHAIN_BOUND_ON_MAC } from '../lib/fleet/auth-sync.js';
import {
  agentIdOf,
  diffFleet,
  probeDevice,
  runFleetApply,
  pool,
  sourceHome,
  type SourceAuth,
  type DeviceApplyResult,
} from '../lib/fleet/apply.js';
import type { DeviceDesired, DeviceProbe, DeviceDiff, FleetPlan } from '../lib/fleet/types.js';

interface ApplyOptions {
  file?: string;
  plan?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  device?: string;
  only?: string;
  login?: boolean; // Commander sets false for --no-login
  recvAuth?: boolean; // hidden internal receiver
}

/** Version of the running agents-cli — the fleet target version. */
function localCliVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf-8'));
    return String(pkg.version ?? '');
  } catch {
    return '';
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

/** Hidden path: receive an auth bundle on stdin and materialize it locally. */
async function runRecvAuth(): Promise<void> {
  const raw = await readStdin();
  const bundle = parseAuthBundle(raw);
  const res = materializeAuth(bundle, { home: os.homedir() });
  if (res.errors.length > 0) {
    console.error(`recv-auth: ${res.errors.length} error(s): ${res.errors.join('; ')}`);
    process.exit(1);
  }
  console.log(`recv-auth: wrote login for ${res.written.join(', ') || '(nothing)'}`);
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const onData = (d: Buffer) => {
      process.stdin.pause();
      process.stdin.off('data', onData);
      resolve(/^y(es)?$/i.test(d.toString().trim()));
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}

const ONLY_KINDS: Record<string, Set<string>> = {
  agents: new Set(['install-cli', 'upgrade-cli', 'add-agent']),
  config: new Set(['sync-config']),
  login: new Set(['push-login', 'needs-login']),
};

/** Render the device x dimension matrix (cribbed from `doctor --devices`). */
function renderPlan(plan: FleetPlan): void {
  const rows = plan.devices;
  const nameWidth = Math.max('device'.length, ...rows.map((r) => r.device.length));

  const cell = (row: DeviceDiff, kinds: string[], okLabel: string): string => {
    if (!row.probe.reachable) return chalk.gray('- offline');
    const acts = row.actions.filter((a) => kinds.includes(a.kind));
    if (acts.length === 0) return chalk.green(`ok ${okLabel}`);
    if (acts.some((a) => a.kind === 'needs-login')) {
      const push = acts.filter((a) => a.kind === 'push-login').length;
      const need = acts.filter((a) => a.kind === 'needs-login').length;
      return chalk.yellow(`${push} push · ${need} manual`);
    }
    return chalk.cyan('↑ ' + acts.map((a) => a.agent ?? a.kind.replace('-cli', '')).join(','));
  };

  const header = `  ${'device'.padEnd(nameWidth)}   ${'agents-cli'.padEnd(12)}${'agents'.padEnd(20)}${'config'.padEnd(10)}login`;
  console.log(chalk.gray(header));
  for (const row of rows) {
    const cli = row.probe.reachable
      ? (row.actions.find((a) => a.kind === 'install-cli') ? chalk.cyan('install')
        : row.actions.find((a) => a.kind === 'upgrade-cli') ? chalk.cyan('upgrade')
        : chalk.green(`ok ${row.probe.cliVersion ?? ''}`))
      : chalk.gray('- offline');
    const agentsCell = row.probe.reachable
      ? (() => {
        const add = row.actions.filter((a) => a.kind === 'add-agent');
        return add.length === 0 ? chalk.green(`ok ${row.desired.agents.length}/${row.desired.agents.length}`) : chalk.cyan('+ ' + add.map((a) => a.agent).join(','));
      })()
      : chalk.gray('-');
    const configCell = row.probe.reachable
      ? (row.actions.some((a) => a.kind === 'sync-config') ? chalk.cyan('↑ sync') : chalk.green('ok'))
      : chalk.gray('-');
    const loginCell = cell(row, ['push-login', 'needs-login'], `${row.desired.agents.length}/${row.desired.agents.length}`);
    console.log(`  ${row.device.padEnd(nameWidth)}   ${stripPad(cli, 12)}${stripPad(agentsCell, 20)}${stripPad(configCell, 10)}${loginCell}`);
  }
  console.log();
  console.log(chalk.gray(`  ${plan.actions.length} action(s) across ${rows.filter((r) => r.probe.reachable).length} reachable device(s)`));

  // Distinguish *why* a login can't be propagated: a macOS keychain-bound token
  // vs. the source simply not being signed in to that agent (no portable file).
  const bound: string[] = [];
  const noToken: string[] = [];
  for (const r of rows) {
    for (const a of r.loginBlocked) {
      const tag = `${a}@${r.device}`;
      if (r.probe.platform === 'macos' && KEYCHAIN_BOUND_ON_MAC.has(a)) bound.push(tag);
      else noToken.push(tag);
    }
  }
  if (bound.length > 0) {
    console.log(chalk.yellow(`  manual login needed (macOS keychain-bound): ${bound.join(', ')}`));
  }
  if (noToken.length > 0) {
    console.log(chalk.yellow(`  manual login needed (no portable token on source): ${noToken.join(', ')}`));
  }
}

/** padEnd on the visible width, ignoring chalk color codes. Exported for tests. */
export function stripPad(s: string, width: number): string {
  // Strip the whole SGR sequence (ESC `[` ... `m`). Matching only the `[...m`
  // tail leaves each leading ESC byte counted as visible, so every colored
  // cell over-pads and the plan table misaligns in a real TTY.
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '').length;
  return s + ' '.repeat(Math.max(1, width - visible));
}

async function runApply(opts: ApplyOptions): Promise<void> {
  const file = opts.file ?? 'agents.yaml';
  const manifest = readFleetFile(path.resolve(file));
  const source = machineId();

  const registry = await loadDevices();
  const all = Object.values(registry);
  const online = all.filter((d) => d.tailscale?.online === true).map((d) => d.name);
  const registered = all.map((d) => d.name);

  let desired = resolveDesired(manifest, { onlineDevices: online, registeredDevices: registered, source });
  if (opts.device) {
    desired = desired.filter((d) => d.device === opts.device);
    if (desired.length === 0) throw new Error(`Device '${opts.device}' is not a target in this manifest.`);
  }
  if (opts.login === false) desired = desired.map((d) => ({ ...d, login: 'skip' as const }));
  if (desired.length === 0) {
    console.log(chalk.gray('No target devices — nothing to apply.'));
    return;
  }

  // Snapshot source auth once for every agent named anywhere in the profile.
  const allAgents = [...new Set(desired.flatMap((d) => d.agents.map(agentIdOf)))];
  const snap = snapshotAuth(allAgents, { home: sourceHome(), platform: process.platform });
  const filesByAgent = new Map<string, typeof snap.files>();
  for (const f of snap.files) {
    const arr = filesByAgent.get(f.agent) ?? [];
    arr.push(f);
    filesByAgent.set(f.agent, arr);
  }
  const sourceAuth: SourceAuth = {
    available: new Set(snap.files.map((f) => f.agent)),
    bound: new Set(snap.bound),
    filesByAgent,
  };

  // Probe every target device in parallel.
  const nameToProfile = new Map<string, DeviceProfile>(desired.map((d) => [d.device, registry[d.device]!]));
  console.log(chalk.gray(`Probing ${desired.length} device(s)…`));
  const probeList = await pool(desired, 6, async (d) => probeDevice(nameToProfile.get(d.device)!));
  const probes = new Map<string, DeviceProbe>(probeList.map((p) => [p.device, p]));

  const targetCliVersion = localCliVersion();
  let plan = diffFleet(desired, probes, { targetCliVersion, sourceAuth });

  // --only filter.
  if (opts.only) {
    const keep = new Set<string>();
    for (const k of opts.only.split(',').map((s) => s.trim())) for (const x of ONLY_KINDS[k] ?? []) keep.add(x);
    plan = {
      devices: plan.devices.map((r) => ({ ...r, actions: r.actions.filter((a) => keep.has(a.kind)) })),
      actions: plan.actions.filter((a) => keep.has(a.kind)),
    };
  }

  console.log();
  console.log(chalk.bold(`Fleet profile · ${desired.length} device(s) · ${allAgents.length} agent(s) (${allAgents.join(', ')})`));
  renderPlan(plan);

  const isDry = opts.plan || opts.dryRun;
  if (isDry) return;
  if (plan.actions.filter((a) => a.kind !== 'needs-login').length === 0) {
    console.log(chalk.green('\nNothing to do — fleet already matches the profile.'));
    return;
  }

  if (!opts.yes) {
    const ok = await confirm(chalk.bold(`\nApply this plan? (${plan.actions.length} action(s)) [y/N] `));
    if (!ok) {
      console.log(chalk.gray('Aborted.'));
      return;
    }
  }

  console.log();
  const results = await runFleetApply(plan.devices, nameToProfile, {
    targetCliVersion,
    source,
    sourceAuth,
  });
  reportResults(results);
}

function reportResults(results: DeviceApplyResult[]): void {
  let failures = 0;
  for (const r of results) {
    if (r.note && r.steps.length === 0) {
      console.log(`  ${chalk.gray(r.device.padEnd(16))} ${chalk.yellow('skipped')} ${chalk.gray(r.note)}`);
      continue;
    }
    const badge = r.ok ? chalk.green('ok  ') : chalk.red('fail');
    if (!r.ok) failures++;
    const summary = r.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.kind}`).join('  ');
    console.log(`  ${chalk.bold(r.device.padEnd(16))} ${badge}  ${chalk.gray(summary)}`);
    for (const s of r.steps.filter((x) => x.kind === 'needs-login')) {
      console.log(`      ${chalk.yellow('→')} ${chalk.gray(s.detail)}`);
    }
  }
  console.log();
  if (failures > 0) {
    console.error(chalk.red(`${failures} device(s) had failures.`));
    process.exit(1);
  }
  console.log(chalk.green('Fleet reconciled.'));
}

export function registerApplyCommand(program: Command): void {
  const applyCmd = program
    .command('apply')
    .description('Reconcile the fleet to a declared profile: install agents, sync config, propagate login.')
    .option('-f, --file <path>', 'Manifest file carrying a fleet: block (default: agents.yaml)')
    .option('--plan', 'Show the reconcile plan and exit (no changes)')
    .option('--dry-run', 'Alias for --plan')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .option('--device <name>', 'Scope the apply to a single device')
    .option('--only <dims>', 'Limit to dimensions: comma list of agents,config,login')
    .option('--no-login', 'Do not propagate logins')
    .addOption(new Option('--recv-auth', 'internal: receive an auth bundle on stdin').hideHelp())
    .action(async (opts: ApplyOptions) => {
      try {
        if (opts.recvAuth) {
          await runRecvAuth();
          return;
        }
        await runApply(opts);
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exit(1);
      }
    });

  setHelpSections(applyCmd, {
    examples: `
      # Preview what would change across the fleet
      agents apply --plan -f agents.yaml

      # Bring every device to the profile (installs, syncs, propagates login)
      ag apply -f agents.yaml

      # One device only
      agents apply --device yosemite-s1 -y
    `,
  });
}
