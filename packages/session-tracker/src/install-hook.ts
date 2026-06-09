// Installs the polyglot src/hook.sh as a SessionStart hook in each agent's
// native config file. Idempotent — running twice does not double-register.
//
// CLI usage:
//   tsx src/install-hook.ts claude
//   tsx src/install-hook.ts claude codex cursor

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { AgentId } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.resolve(__dirname, 'hook.sh');

export interface InstallResult {
  agent: AgentId;
  installed: boolean;
  configPath: string;
  error?: string;
}

export interface InstallOptions {
  dryRun?: boolean;
  hookPathOverride?: string;
}

function hookCommand(agent: AgentId, opts: InstallOptions): string {
  const hook = opts.hookPathOverride ?? HOOK_PATH;
  return `${hook} ${agent}`;
}

async function readJson(p: string): Promise<any> {
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function writeJsonAtomic(p: string, data: any): Promise<void> {
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(tmp, p);
}

async function installClaude(opts: InstallOptions): Promise<InstallResult> {
  const configPath = path.join(os.homedir(), '.claude', 'settings.json');
  const command = hookCommand('claude', opts);
  if (opts.dryRun) {
    return { agent: 'claude', installed: false, configPath };
  }
  const cfg = await readJson(configPath);
  cfg.hooks = cfg.hooks ?? {};
  cfg.hooks.SessionStart = cfg.hooks.SessionStart ?? [];
  // Remove any prior registration of THIS hook path (idempotency).
  for (const entry of cfg.hooks.SessionStart) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    entry.hooks = entry.hooks.filter(
      (h: any) => !(h && h.command && String(h.command).includes('packages/session-tracker/src/hook.sh')),
    );
  }
  // Find or create the empty-matcher group and add our hook.
  let group = cfg.hooks.SessionStart.find((e: any) => e && e.matcher === '');
  if (!group) {
    group = { matcher: '', hooks: [] };
    cfg.hooks.SessionStart.push(group);
  }
  group.hooks.push({ type: 'command', command, timeout: 5 });
  await writeJsonAtomic(configPath, cfg);
  return { agent: 'claude', installed: true, configPath };
}

async function installCodex(opts: InstallOptions): Promise<InstallResult> {
  const configPath = path.join(os.homedir(), '.codex', 'hooks.json');
  const command = hookCommand('codex', opts);
  if (opts.dryRun) {
    return { agent: 'codex', installed: false, configPath };
  }
  const cfg = await readJson(configPath);
  cfg.hooks = cfg.hooks ?? {};
  cfg.hooks.SessionStart = cfg.hooks.SessionStart ?? [];
  for (const entry of cfg.hooks.SessionStart) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    entry.hooks = entry.hooks.filter(
      (h: any) => !(h && h.command && String(h.command).includes('packages/session-tracker/src/hook.sh')),
    );
  }
  let group = cfg.hooks.SessionStart.find((e: any) => e && (e.matcher === '' || e.matcher === 'startup|resume'));
  if (!group) {
    group = { matcher: 'startup|resume', hooks: [] };
    cfg.hooks.SessionStart.push(group);
  }
  group.hooks.push({ type: 'command', command, timeout: 5 });
  await writeJsonAtomic(configPath, cfg);
  return { agent: 'codex', installed: true, configPath };
}

async function installCursor(opts: InstallOptions): Promise<InstallResult> {
  const configPath = path.join(os.homedir(), '.cursor', 'hooks.json');
  const command = hookCommand('cursor', opts);
  if (opts.dryRun) {
    return { agent: 'cursor', installed: false, configPath };
  }
  const cfg = await readJson(configPath);
  cfg.hooks = cfg.hooks ?? {};
  cfg.hooks.sessionStart = cfg.hooks.sessionStart ?? [];
  cfg.hooks.sessionStart = cfg.hooks.sessionStart.filter(
    (h: any) => !(h && h.command && String(h.command).includes('packages/session-tracker/src/hook.sh')),
  );
  cfg.hooks.sessionStart.push({ type: 'command', command, timeout: 5 });
  await writeJsonAtomic(configPath, cfg);
  return { agent: 'cursor', installed: true, configPath };
}

async function installGrok(opts: InstallOptions): Promise<InstallResult> {
  const configPath = path.join(os.homedir(), '.grok', 'hooks', 'session-start.json');
  const command = hookCommand('grok', opts);
  if (opts.dryRun) {
    return { agent: 'grok', installed: false, configPath };
  }
  await writeJsonAtomic(configPath, { command, timeout: 5 });
  return { agent: 'grok', installed: true, configPath };
}

export async function installHookFor(
  agent: AgentId,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  try {
    switch (agent) {
      case 'claude':
        return await installClaude(opts);
      case 'codex':
        return await installCodex(opts);
      case 'cursor':
        return await installCursor(opts);
      case 'grok':
        return await installGrok(opts);
      default:
        return {
          agent,
          installed: false,
          configPath: '',
          error: `installation for ${agent} not yet implemented`,
        };
    }
  } catch (err) {
    return {
      agent,
      installed: false,
      configPath: '',
      error: (err as Error).message,
    };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const agents = process.argv.slice(2) as AgentId[];
  if (agents.length === 0) {
    console.error('usage: tsx src/install-hook.ts <agent> [<agent>...]');
    process.exit(2);
  }
  for (const a of agents) {
    const r = await installHookFor(a);
    console.log(JSON.stringify(r));
    if (r.error) process.exitCode = 1;
  }
}
