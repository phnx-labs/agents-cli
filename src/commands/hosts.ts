/**
 * `agents hosts` — register and inspect agent hosts (machines you offload runs to).
 *
 * The registry is a thin overlay: ssh-config hosts are dispatchable with zero
 * registration (connection details stay in ~/.ssh/config); enrollment only adds
 * capability metadata or bootstraps agents-cli, plus inline (non-ssh-config)
 * hosts. Dispatch itself is `agents run --host <name>` (see commands/exec.ts).
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { checkbox, confirm } from '@inquirer/prompts';
import { assertValidSshTarget } from '../lib/ssh-exec.js';
import { getProvider, listAllHosts, resolveHost } from '../lib/hosts/registry.js';
import { sshTargetFor, type Host } from '../lib/hosts/types.js';
import { listSshConfigHosts, listKnownHosts, isSshConfigHost } from '../lib/hosts/ssh-config.js';
import {
  probeHost,
  remoteAgentsVersion,
  bootstrapAgentsCli,
  localCliVersion,
} from '../lib/hosts/ready.js';
import { listTasks, loadTask, localLogPath } from '../lib/hosts/tasks.js';
import { followHostTask } from '../lib/hosts/progress.js';
import * as fs from 'fs';

interface AddOptions { cap?: string[]; os?: string; enroll?: boolean; }

/** Parse `user@host` or `host` into its pieces. */
function parseTarget(target: string): { address: string; user?: string } {
  const at = target.indexOf('@');
  if (at === -1) return { address: target };
  return { user: target.slice(0, at), address: target.slice(at + 1) };
}

/** Bootstrap/verify agents-cli on a freshly-enrolled host (best-effort, prompts). */
async function maybeBootstrap(target: string, hostName: string): Promise<void> {
  const probe = probeHost(target);
  if (!probe.reachable) {
    console.log(chalk.yellow(`  Not reachable over SSH yet — skipping bootstrap. Fix key auth, then: agents hosts check ${hostName}`));
    return;
  }
  const remoteVer = remoteAgentsVersion(target);
  const localVer = localCliVersion();
  if (!remoteVer) {
    const ok = await confirm({ message: `  agents-cli not found on ${hostName}. Install ${localVer ? `v${localVer}` : 'latest'} now?`, default: true });
    if (ok) {
      console.log(chalk.gray('  Installing agents-cli on the host…'));
      const r = bootstrapAgentsCli(target, localVer);
      console.log(r.ok ? chalk.green('  Installed.') : chalk.red(`  Install failed:\n${r.output}`));
    }
    return;
  }
  const remoteClean = remoteVer.replace(/^v/, '');
  if (localVer && remoteClean !== localVer) {
    const ok = await confirm({ message: `  ${hostName} has agents-cli ${remoteClean}, you have ${localVer}. Upgrade to match?`, default: false });
    if (ok) {
      const r = bootstrapAgentsCli(target, localVer);
      console.log(r.ok ? chalk.green('  Upgraded.') : chalk.red(`  Upgrade failed:\n${r.output}`));
    }
  }
}

async function registerHost(spec: Host): Promise<void> {
  const provider = getProvider('local');
  await provider.register!(spec);
}

async function doAdd(name: string | undefined, target: string | undefined, opts: AddOptions): Promise<void> {
  // No name + no target → interactive scan of ssh sources.
  if (!name && !target) {
    const existing = new Set((await listAllHosts()).filter((h) => h.enrolled).map((h) => h.name));
    const candidates = [...new Set([...listSshConfigHosts(), ...listKnownHosts()])].filter((c) => !existing.has(c));
    if (candidates.length === 0) {
      console.log(chalk.yellow('No SSH hosts found in ~/.ssh/config or ~/.ssh/known_hosts. Add one explicitly: agents hosts add <name> <user@host>'));
      return;
    }
    const picked = await checkbox({
      message: 'Select hosts to enroll (connection details come from ~/.ssh/config)',
      choices: candidates.map((c) => ({ value: c, name: c })),
    });
    for (const c of picked) {
      // The ssh target is the candidate name itself either way: ssh resolves it
      // for ssh-config hosts, and it's a reachable hostname for known_hosts ones.
      const source = isSshConfigHost(c) ? 'ssh-config' : 'inline';
      const probe = probeHost(c);
      await registerHost({ name: c, provider: 'local', source, ...(source === 'inline' ? { address: c } : {}), os: probe.os, caps: opts.cap });
      console.log(chalk.green(`Enrolled ${c}`) + chalk.gray(` (${source}${probe.os ? `, ${probe.os}` : ''})`));
      if (opts.enroll !== false) await maybeBootstrap(c, c);
    }
    return;
  }

  if (!name) {
    console.log(chalk.red('Usage: agents hosts add <name> [user@host]'));
    process.exitCode = 1;
    return;
  }

  let spec: Host;
  let sshTarget: string;
  if (target) {
    assertValidSshTarget(target);
    const { address, user } = parseTarget(target);
    spec = { name, provider: 'local', source: 'inline', address, user, caps: opts.cap, os: opts.os };
    sshTarget = target;
  } else if (isSshConfigHost(name)) {
    spec = { name, provider: 'local', source: 'ssh-config', caps: opts.cap, os: opts.os };
    sshTarget = name;
  } else {
    console.log(chalk.red(`"${name}" is not in ~/.ssh/config. Pass a target: agents hosts add ${name} <user@host>`));
    process.exitCode = 1;
    return;
  }

  const probe = probeHost(sshTarget);
  if (!spec.os && probe.os) spec.os = probe.os;
  await registerHost(spec);
  console.log(chalk.green(`Enrolled ${name}`) + chalk.gray(` (${spec.source}${spec.os ? `, ${spec.os}` : ''}${spec.caps?.length ? `, caps: ${spec.caps.join(',')}` : ''})`));
  if (opts.enroll !== false) await maybeBootstrap(sshTarget, name);
}

async function doList(json: boolean): Promise<void> {
  const hosts = await listAllHosts();
  if (json) {
    console.log(JSON.stringify(hosts, null, 2));
    return;
  }
  if (hosts.length === 0) {
    console.log(chalk.gray('No hosts. Enroll one: agents hosts add <name> <user@host>  (or just: agents hosts add)'));
    return;
  }
  console.log(chalk.bold('NAME').padEnd(20) + chalk.bold('SOURCE').padEnd(13) + chalk.bold('TARGET').padEnd(28) + chalk.bold('CAPS'));
  for (const h of hosts) {
    const tgt = h.source === 'ssh-config' ? chalk.gray('(ssh-config)') : `${h.user ? h.user + '@' : ''}${h.address ?? ''}`;
    const mark = h.enrolled ? '' : chalk.gray(' ·available');
    console.log(h.name.padEnd(20) + h.source.padEnd(13) + tgt.padEnd(28) + (h.caps?.join(',') ?? '') + mark);
  }
}

async function doCheck(name: string): Promise<void> {
  const host = await resolveHost(name);
  if (!host) {
    console.log(chalk.red(`Unknown host "${name}". Known: ${(await listAllHosts()).map((h) => h.name).join(', ') || '(none)'}`));
    process.exitCode = 1;
    return;
  }
  const target = sshTargetFor(host);
  process.stdout.write(`Probing ${chalk.cyan(name)} (${target})… `);
  const probe = probeHost(target);
  if (!probe.reachable) {
    console.log(chalk.red('unreachable'));
    process.exitCode = 1;
    return;
  }
  console.log(chalk.green('reachable') + chalk.gray(probe.os ? ` · ${probe.os}` : ''));
  const ver = remoteAgentsVersion(target);
  console.log(`  agents-cli: ${ver ? chalk.green(ver) : chalk.yellow('not installed')}`);
}

async function doRemove(name: string): Promise<void> {
  const host = await resolveHost(name);
  if (!host || !host.enrolled) {
    console.log(chalk.yellow(`"${name}" is not enrolled (nothing to remove).`));
    return;
  }
  await getProvider('local').remove!(name);
  console.log(chalk.green(`Removed ${name}`));
}

async function doPs(json: boolean): Promise<void> {
  const tasks = listTasks();
  if (json) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }
  if (tasks.length === 0) {
    console.log(chalk.gray('No host tasks yet. Dispatch one: agents run <agent> "<task>" --host <name>'));
    return;
  }
  console.log(chalk.bold('ID').padEnd(11) + chalk.bold('HOST').padEnd(16) + chalk.bold('AGENT').padEnd(10) + chalk.bold('STATUS').padEnd(11) + chalk.bold('PROMPT'));
  for (const t of tasks) {
    const status = t.status === 'completed' ? chalk.green(t.status) : t.status === 'failed' ? chalk.red(t.status) : chalk.yellow(t.status);
    console.log(t.id.padEnd(11) + t.host.padEnd(16) + t.agent.padEnd(10) + status.padEnd(11) + t.prompt.slice(0, 50));
  }
}

async function doLogs(id: string, follow: boolean): Promise<void> {
  const task = loadTask(id);
  if (!task) {
    console.log(chalk.red(`Unknown task "${id}".`));
    process.exitCode = 1;
    return;
  }
  if (follow && task.status === 'running') {
    const code = await followHostTask(task.target, { remoteLog: task.remoteLog, remoteExit: task.remoteExit, taskId: id, echo: true });
    process.exitCode = code === -1 ? 1 : code;
    return;
  }
  try {
    process.stdout.write(fs.readFileSync(localLogPath(id), 'utf-8'));
  } catch {
    console.log(chalk.gray('(no local log captured for this task)'));
  }
}

/** Register the `agents hosts` command tree. */
export function registerHostsCommand(program: Command): void {
  const hosts = program
    .command('hosts')
    .description('Register and inspect agent hosts (machines you offload runs to with `agents run --host <name>`).');

  hosts
    .command('add [name] [target]')
    .description('Enroll a host. With no args, pick from ~/.ssh/config + known_hosts. `target` is user@host for hosts not in ssh config.')
    .option('--cap <cap...>', 'Capability tag(s) for routing (e.g. --cap gpu)')
    .option('--os <os>', 'Override detected OS label')
    .option('--no-enroll', 'Register only — skip the remote agents-cli bootstrap/version check')
    .action((name: string | undefined, target: string | undefined, opts: AddOptions) => doAdd(name, target, opts));

  hosts
    .command('list')
    .alias('ls')
    .description('List enrolled + ssh-config hosts (metadata only, no probing).')
    .option('--json', 'Output JSON')
    .action((opts: { json?: boolean }) => doList(!!opts.json));

  hosts
    .command('check <name>')
    .description('Probe one host: reachable? agents-cli version?')
    .action((name: string) => doCheck(name));

  hosts
    .command('remove <name>')
    .alias('rm')
    .description('Remove a host from the registry (does not touch ~/.ssh/config).')
    .action((name: string) => doRemove(name));

  hosts
    .command('ps')
    .description('List dispatched host tasks.')
    .option('--json', 'Output JSON')
    .action((opts: { json?: boolean }) => doPs(!!opts.json));

  hosts
    .command('logs <id>')
    .description('Show a host task log; -f to follow a running one.')
    .option('-f, --follow', 'Follow live output')
    .action((id: string, opts: { follow?: boolean }) => doLogs(id, !!opts.follow));
}
