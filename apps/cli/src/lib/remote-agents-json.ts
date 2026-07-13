/**
 * Shared cross-machine fan-out for JSON-producing `agents` commands.
 *
 * Registered online devices are queried in parallel over the canonical SSH
 * transport. A recursion-guard environment variable makes each peer answer for
 * itself, and version-skewed or unreachable peers are skipped without hiding
 * healthy results from the rest of the fleet.
 */
import { spawn } from 'child_process';
import chalk from 'chalk';
import { SSH_OPTS, controlOpts, assertValidSshTarget, shellQuote } from './ssh-exec.js';
import { sshTargetFor } from './devices/connect.js';
import { resolveExplicitTargets } from './devices/resolve-target.js';
import { loadDevices, type DeviceProfile } from './devices/registry.js';
import { remoteShellFor, buildWindowsAgentsCommand } from './hosts/remote-cmd.js';
import { machineId, normalizeHost } from './machine-id.js';

const REMOTE_TIMEOUT_MS = 12_000;

export interface RemoteAgentsJsonOptions<T> {
  args: string[];
  noFanoutEnv: string;
  hosts?: string[];
  parse: (stdout: string, machine: string) => T[];
}

export interface RemoteAgentsJsonResult<T> {
  items: T[];
  deviceCount: number;
}

/** Build the command one peer runs, with a guard that prevents recursive fan-out. */
export function remoteAgentsJsonCommand(args: string[], noFanoutEnv: string, os?: string): string {
  if (remoteShellFor(os) === 'powershell') {
    return buildWindowsAgentsCommand({ args, env: { [noFanoutEnv]: '1' } });
  }
  const inner = `${noFanoutEnv}=1 agents ${args.map(shellQuote).join(' ')}`;
  return `bash -lc ${shellQuote(inner)}`;
}

function sshCapture(target: string, remoteCmd: string): Promise<{ code: number | null; stdout: string }> {
  assertValidSshTarget(target);
  return new Promise((resolve) => {
    const args = [...SSH_OPTS, ...controlOpts(), target, remoteCmd];
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(null);
    }, REMOTE_TIMEOUT_MS);
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });
}

/** Query explicit hosts, or every registered online peer when hosts is omitted. */
export async function gatherRemoteAgentsJson<T>(
  options: RemoteAgentsJsonOptions<T>,
): Promise<RemoteAgentsJsonResult<T>> {
  const self = machineId();
  const targets: Array<{ target: string; machine: string; name: string; os?: string }> = [];

  if (options.hosts && options.hosts.length > 0) {
    targets.push(...await resolveExplicitTargets(options.hosts));
  } else {
    let devices: Record<string, DeviceProfile>;
    try {
      devices = await loadDevices();
    } catch {
      return { items: [], deviceCount: 0 };
    }
    for (const device of Object.values(devices)) {
      if (device.tailscale?.online !== true) continue;
      if (normalizeHost(device.name) === self) continue;
      if (!['windows', 'linux', 'macos'].includes(device.platform)) continue;
      try {
        targets.push({
          target: sshTargetFor(device),
          machine: normalizeHost(device.name),
          name: device.name,
          os: device.platform,
        });
      } catch {
        // A registered profile without a dialable address is not a peer yet.
      }
    }
  }

  const results = await Promise.all(targets.map(async (target) => {
    const command = remoteAgentsJsonCommand(options.args, options.noFanoutEnv, target.os);
    const result = await sshCapture(target.target, command);
    if (result.code !== 0) {
      process.stderr.write(chalk.gray(`  ${target.name}: unreachable or no agents CLI — skipped\n`));
      return [] as T[];
    }
    return options.parse(result.stdout, target.machine);
  }));

  return { items: results.flat(), deviceCount: targets.length };
}
