import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CLAUDE_STATUSLINE_COMMAND,
  ingestClaudeStatusLineUsage,
  installClaudeStatusLine,
  renderClaudeStatusLine,
} from './claude-statusline.js';
import {
  readClaudeUsageCache,
  setClaudeUsageCachePathForTest,
} from './accounting/usage.js';

const dirs: string[] = [];
let priorCachePath: string | null = null;

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-claude-statusline-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  if (priorCachePath !== null) setClaudeUsageCachePathForTest(priorCachePath);
  priorCachePath = null;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Claude native status line', () => {
  it('renders hostname, active model, delegated output, and native quota windows', () => {
    expect(renderClaudeStatusLine({
      model: { display_name: 'Opus 5' },
      rate_limits: {
        five_hour: { used_percentage: 1 },
        seven_day: { used_percentage: 80 },
      },
    }, 'zion', 'agents-cli · rush-3194')).toBe(
      'zion · Opus 5 · agents-cli · rush-3194 · 5h 1% · 7d 80%',
    );
  });

  it('writes a native response snapshot under the version home organization identity', () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({
      oauthAccount: {
        emailAddress: 'person@example.com',
        accountUuid: 'account-1',
        organizationUuid: 'org-1',
      },
    }));
    priorCachePath = setClaudeUsageCachePathForTest(path.join(home, 'usage.json'));

    expect(ingestClaudeStatusLineUsage({
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: 1_800_000_000 },
        seven_day: { used_percentage: 34, resets_at: 1_800_100_000 },
      },
    }, home)).toBe(true);

    const snapshot = readClaudeUsageCache('claude:org=org-1');
    expect(snapshot?.source).toBe('last_seen');
    expect(snapshot?.windows.map((window) => [window.key, window.usedPercent])).toEqual([
      ['session', 12],
      ['week', 34],
    ]);
  });

  it('does not erase the cache when Claude omits rate_limits', () => {
    const home = tempHome();
    expect(ingestClaudeStatusLineUsage({}, home)).toBe(false);
  });

  it('wraps and preserves a pre-existing status-line command', () => {
    const home = tempHome();
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: 'opus',
      customTopLevel: { keep: true },
      statusLine: {
        type: 'command',
        command: '/home/me/statusline.sh',
        padding: 2,
        refreshInterval: 7,
        customField: 'keep',
      },
    }));

    expect(installClaudeStatusLine(home)).toEqual({ changed: true });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.model).toBe('opus');
    expect(settings.customTopLevel).toEqual({ keep: true });
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: CLAUDE_STATUSLINE_COMMAND,
      padding: 2,
      refreshInterval: 7,
      customField: 'keep',
    });
    expect(fs.readFileSync(path.join(home, '.agents', 'claude-statusline-delegate'), 'utf8')).toBe(
      '/home/me/statusline.sh\n',
    );
    expect(installClaudeStatusLine(home)).toEqual({ changed: false });
  });

  it('does not resurrect a removed custom status-line command', () => {
    const home = tempHome();
    const delegate = path.join(home, '.agents', 'claude-statusline-delegate');
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(delegate), { recursive: true });
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(delegate, '/home/me/removed-statusline.sh\n');
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { padding: 4 } }));

    expect(installClaudeStatusLine(home)).toEqual({ changed: true });
    expect(fs.existsSync(delegate)).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine).toEqual({
      padding: 4,
      type: 'command',
      command: CLAUDE_STATUSLINE_COMMAND,
    });
  });
});
