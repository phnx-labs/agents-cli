import type { Command } from 'commander';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { getCliLaunch } from '../lib/cli-entry.js';
import { loadDevices } from '../lib/devices/registry.js';
import { machineId, normalizeHost } from '../lib/machine-id.js';
import { getConfigValue, setConfigValue } from '../lib/device-config.js';
import { isPromptCancelled, requireInteractiveSelection } from './utils.js';

export async function runWatchdogSetupWizard(): Promise<void> {
  const registry = await loadDevices();
  const devices = [...new Set([...Object.keys(registry), machineId()].map(normalizeHost))].sort();
  const enabled = new Set(devices.filter((device) => getConfigValue('watchdog.enabled', { device }).value === true));
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    requireInteractiveSelection('watchdog devices', ['agents watchdog on', 'agents watchdog on --host <device>']);
  }

  try {
    const { checkbox } = await import('@inquirer/prompts');
    const selected = await checkbox<string>({
      message: 'Devices where the watchdog should run:',
      choices: devices.map((device) => ({ name: device, value: device, checked: enabled.has(device) })),
    });
    const selectedSet = new Set(selected);
    for (const device of devices) {
      const on = selectedSet.has(device);
      if (device === normalizeHost(machineId())) {
        setConfigValue('watchdog.enabled', on);
        continue;
      }
      const launch = getCliLaunch(['watchdog', on ? 'on' : 'off', '--host', device]);
      const result = spawnSync(launch.command, launch.args, { stdio: 'inherit', env: process.env });
      if ((result.status ?? 1) !== 0) throw new Error(`Could not configure watchdog on ${device}`);
    }
    console.log(chalk.green(selected.length === 0
      ? 'Watchdog disabled on every registered device'
      : `Watchdog enabled on: ${selected.join(', ')}`));
  } catch (error) {
    if (isPromptCancelled(error)) {
      console.log(chalk.gray('Cancelled'));
      return;
    }
    throw error;
  }
}

export function registerSetupWatchdogCommand(setup: Command): void {
  setup.command('watchdog')
    .description('Choose the devices where the daemon watchdog pass runs.')
    .action(runWatchdogSetupWizard);
}
