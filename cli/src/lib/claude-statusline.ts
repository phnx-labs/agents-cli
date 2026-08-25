import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { readClaudeHomeConfig } from './agent-spec/agents.js';
import { atomicWriteFileSync } from './fs-atomic.js';
import { mergeClaudeUsageCacheWindows, type UsageWindow } from './accounting/usage.js';

export const CLAUDE_STATUSLINE_COMMAND = 'agents __claude-statusline';
const DELEGATE_FILE = path.join('.agents', 'claude-statusline-delegate');

interface ClaudeStatusLinePayload {
  cwd?: string;
  workspace?: { current_dir?: string };
  model?: { display_name?: string; id?: string };
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function versionHomeFromEnv(env: NodeJS.ProcessEnv): string | null {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? path.dirname(configDir) : null;
}

function windowFromNative(
  key: 'session' | 'week',
  value: { used_percentage?: number; resets_at?: number } | undefined,
): UsageWindow | null {
  if (!value || !Number.isFinite(value.used_percentage)) return null;
  const resetSeconds = value.resets_at;
  return {
    key,
    label: key === 'session' ? 'Current session' : 'Current week',
    shortLabel: key === 'session' ? 'S' : 'W',
    usedPercent: Math.max(0, Math.min(100, value.used_percentage!)),
    resetsAt: Number.isFinite(resetSeconds) ? new Date(resetSeconds! * 1000) : null,
    windowMinutes: key === 'session' ? 300 : 10_080,
  };
}

export function ingestClaudeStatusLineUsage(
  payload: ClaudeStatusLinePayload,
  versionHome: string,
): boolean {
  const identity = readClaudeHomeConfig(versionHome)?.identity;
  if (!identity?.usageKey || !payload.rate_limits) return false;
  const windows = [
    windowFromNative('session', payload.rate_limits.five_hour),
    windowFromNative('week', payload.rate_limits.seven_day),
  ].filter((value): value is UsageWindow => value !== null);
  if (windows.length === 0) return false;
  mergeClaudeUsageCacheWindows(identity.usageKey, {
    source: 'live',
    sourceLabel: 'Claude response rate limits',
    capturedAt: new Date(),
    windows,
  });
  return true;
}

function delegatePath(versionHome: string): string {
  return path.join(versionHome, DELEGATE_FILE);
}

function renderDelegate(payload: string, versionHome: string): string {
  let command = '';
  try { command = fs.readFileSync(delegatePath(versionHome), 'utf8').trim(); } catch { return ''; }
  if (!command || command === CLAUDE_STATUSLINE_COMMAND) return '';
  const result = spawnSync(command, {
    shell: true,
    input: payload,
    encoding: 'utf8',
    env: process.env,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

export function renderClaudeStatusLine(
  payload: ClaudeStatusLinePayload,
  host = os.hostname().split('.')[0] || os.hostname(),
  delegated = '',
): string {
  const model = payload.model?.display_name?.trim() || payload.model?.id?.trim() || 'model pending';
  const parts = [host, model];
  if (delegated) parts.push(delegated);
  const fiveHour = payload.rate_limits?.five_hour?.used_percentage;
  const sevenDay = payload.rate_limits?.seven_day?.used_percentage;
  if (Number.isFinite(fiveHour)) parts.push(`5h ${Math.round(fiveHour!)}%`);
  if (Number.isFinite(sevenDay)) parts.push(`7d ${Math.round(sevenDay!)}%`);
  return parts.join(' · ');
}

export async function runClaudeStatusLine(): Promise<number> {
  const raw = await new Promise<string>((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
  let payload: ClaudeStatusLinePayload;
  try {
    const parsed: unknown = JSON.parse(raw);
    payload = isRecord(parsed) ? parsed as ClaudeStatusLinePayload : {};
  } catch {
    payload = {};
  }
  const versionHome = versionHomeFromEnv(process.env);
  if (versionHome) ingestClaudeStatusLineUsage(payload, versionHome);
  process.stdout.write(renderClaudeStatusLine(
    payload,
    undefined,
    versionHome ? renderDelegate(raw, versionHome) : '',
  ));
  return 0;
}

export function installClaudeStatusLine(versionHome: string): { changed: boolean; error?: string } {
  const settingsPath = path.join(versionHome, '.claude', 'settings.json');
  try {
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!isRecord(parsed)) return { changed: false, error: 'settings.json is not an object' };
      settings = parsed;
    }
    const priorStatusLine = isRecord(settings.statusLine) ? settings.statusLine : {};
    const existing = typeof priorStatusLine.command === 'string'
      ? priorStatusLine.command.trim()
      : '';
    if (existing === CLAUDE_STATUSLINE_COMMAND) return { changed: false };
    if (existing) {
      fs.mkdirSync(path.dirname(delegatePath(versionHome)), { recursive: true });
      atomicWriteFileSync(delegatePath(versionHome), `${existing}\n`);
    } else {
      fs.rmSync(delegatePath(versionHome), { force: true });
    }
    settings.statusLine = {
      ...priorStatusLine,
      type: 'command',
      command: CLAUDE_STATUSLINE_COMMAND,
    };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    atomicWriteFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    return { changed: true };
  } catch (error) {
    return { changed: false, error: error instanceof Error ? error.message : String(error) };
  }
}
