/**
 * `agents fleet capture` (alias surface of `agents devices capture`) — snapshot
 * the live environment into the `fleet:` block of `agents.yaml` so a fresh
 * machine can reconstruct it with `agents apply`.
 *
 * Local-read + local-write, zero SSH. Records device NAMES only (never IPs or
 * usernames — those are re-resolved live from Tailscale at apply-time), plus the
 * source's own agents as defaults, browser profiles, secrets-bundle names, and
 * routine names. The heavy lifting is the pure `captureFleet` builder; this
 * command just gathers inputs and persists via `updateMeta`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import * as yaml from 'yaml';
import { loadDevices, isControlDevice } from '../lib/devices/registry.js';
import { readMeta, updateMeta, getDeviceMetaPath } from '../lib/state.js';
import { listBundles } from '../lib/secrets/bundles.js';
import { listJobs } from '../lib/routines.js';
import { captureFleet, type CaptureInputs } from '../lib/fleet/capture.js';
import type { FleetDefaults } from '../lib/fleet/types.js';

interface CaptureOptions {
  dryRun?: boolean;
  fromPins?: boolean;
  device?: string;
}

/** The committed per-device pin dir: `~/.agents/devices/`. Derived from the
 * device-meta path so it honors any AGENTS_HOME override the same way. */
function devicesPinDir(): string {
  return path.dirname(path.dirname(getDeviceMetaPath()));
}

/** Read `devices/<name>/agents.yaml` pin files into `name -> [id@latest]`. Only
 * used with `--from-pins`; keeps capture zero-SSH by reading committed state. */
function agentsFromPins(names: string[]): Record<string, string[]> {
  const dir = devicesPinDir();
  const out: Record<string, string[]> = {};
  for (const name of names) {
    const p = path.join(dir, name, 'agents.yaml');
    if (!fs.existsSync(p)) continue;
    try {
      const doc = yaml.parse(fs.readFileSync(p, 'utf-8')) as { agents?: Record<string, unknown> };
      const ids = doc?.agents ? Object.keys(doc.agents) : [];
      if (ids.length > 0) out[name] = ids.map((id) => `${id}@latest`);
    } catch {
      /* skip an unparsable pin file — capture is best-effort per device */
    }
  }
  return out;
}

async function runCapture(opts: CaptureOptions): Promise<void> {
  const meta = readMeta();

  // Roster: registered, non-control device names only.
  const registry = await loadDevices();
  let names = Object.values(registry)
    .filter((d) => !isControlDevice(d))
    .map((d) => d.name)
    .sort();
  if (opts.device) {
    names = names.filter((n) => n === opts.device);
    if (names.length === 0) throw new Error(`Device '${opts.device}' is not a registered device.`);
  }

  // Defaults seeded from the source machine's own installed agents.
  const sourceAgents = Object.keys(meta.agents ?? {}).sort();
  const defaults: FleetDefaults = {
    agents: sourceAgents.map((id) => `${id}@latest`),
    sync: ['user'],
    login: 'sync',
  };

  const inputs: CaptureInputs = {
    devices: names,
    defaults,
    agentsByDevice: opts.fromPins ? agentsFromPins(names) : undefined,
    // Browser profiles are intentionally NOT captured — the central `browser:`
    // block already syncs via the repo, and its ssh:// endpoints can carry
    // `user@host`, which must never be copied into the fleet: block.
    secretsBundles: listBundles().map((b) => b.name),
    routines: listJobs().map((j) => j.name),
  };

  const next = captureFleet(meta.fleet, inputs);

  if (opts.dryRun) {
    console.log(chalk.gray('# agents.yaml fleet: block (dry run — not written)'));
    console.log(yaml.stringify({ fleet: next }).trimEnd());
    return;
  }

  updateMeta((m) => ({ ...m, fleet: next }));
  const deviceCount = Object.keys(next.devices === 'all' ? {} : next.devices).length;
  console.log(
    chalk.green('Captured fleet profile') +
      chalk.gray(
        ` — ${deviceCount} device(s), ${defaults.agents?.length ?? 0} agent(s), ` +
          `${inputs.secretsBundles?.length ?? 0} secret bundle(s), ${inputs.routines?.length ?? 0} routine(s).`,
      ),
  );
  console.log(chalk.gray('  Wrote agents.yaml → fleet:. Push it (`agents repo push`) and run `agents apply` on any machine.'));
}

/** Attach `capture` to the `devices`/`fleet` command tree. */
export function registerFleetCaptureCommand(devicesCmd: Command): void {
  devicesCmd
    .command('capture')
    .description('Snapshot the live environment (roster names, agents, browser, secret-bundle names, routines) into agents.yaml fleet:.')
    .option('--dry-run', 'print the fleet: block that would be written, and exit')
    .option('--from-pins', 'record per-device agents from committed devices/<name>/agents.yaml')
    .option('--device <name>', 'capture a single device')
    .action(async (opts: CaptureOptions) => {
      try {
        await runCapture(opts);
      } catch (e) {
        console.error(chalk.red((e as Error).message));
        process.exit(1);
      }
    });
}
