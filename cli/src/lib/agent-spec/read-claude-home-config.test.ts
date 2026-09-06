import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readClaudeHomeConfig } from './agents.js';
import { updateMeta } from '../state.js';
import type { NativeAccountRecord } from '../types.js';

const dirs: string[] = [];
function tempHome(oauthAccount: Record<string, unknown>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-claude-home-'));
  dirs.push(home);
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ oauthAccount }));
  return home;
}

function setNativeRows(rows: NativeAccountRecord[]): void {
  updateMeta((meta) => ({
    ...meta,
    accounts: { ...meta.accounts, native: Object.fromEntries(rows.map((r) => [r.id, r])) },
  }));
}

afterEach(() => {
  setNativeRows([]);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('readClaudeHomeConfig identity completion (PHNX-3940 read-side)', () => {
  it('completes an email-only worker home from the registry row', () => {
    setNativeRows([
      {
        id: 'acc-1',
        name: 'work',
        agent: 'claude',
        identityKey: 'claude:account=aaa-111:org=ooo-222',
        identityLabel: 'work@getrush.ai',
        scope: 'version',
      },
    ]);
    const home = tempHome({ emailAddress: 'work@getrush.ai' });
    const cfg = readClaudeHomeConfig(home);
    expect(cfg?.identity.accountId).toBe('aaa-111');
    expect(cfg?.identity.organizationId).toBe('ooo-222');
    expect(cfg?.identity.accountKey).toBe('claude:account=aaa-111:org=ooo-222');
    expect(cfg?.identity.usageKey).toBe('claude:org=ooo-222');
    expect(cfg?.identity.email).toBe('work@getrush.ai');
  });

  it('stays email-only when the email is ambiguous (two orgs under one email)', () => {
    setNativeRows([
      { id: 'a', name: 'team', agent: 'claude', identityKey: 'claude:account=a1:org=team', identityLabel: 'both@getrush.ai', scope: 'version' },
      { id: 'b', name: 'max', agent: 'claude', identityKey: 'claude:account=a2:org=max', identityLabel: 'both@getrush.ai', scope: 'version' },
    ]);
    const home = tempHome({ emailAddress: 'both@getrush.ai' });
    const cfg = readClaudeHomeConfig(home);
    expect(cfg?.identity.email).toBe('both@getrush.ai');
    expect(cfg?.identity.accountId).toBeNull();
    expect(cfg?.identity.organizationId).toBeNull();
    expect(cfg?.identity.accountKey).toBeNull();
    expect(cfg?.identity.usageKey).toBeNull();
  });

  it('does not override uuids already present on a headed home', () => {
    setNativeRows([
      { id: 'acc-1', name: 'work', agent: 'claude', identityKey: 'claude:account=REGISTRY:org=REGISTRY', identityLabel: 'work@getrush.ai', scope: 'version' },
    ]);
    const home = tempHome({ emailAddress: 'work@getrush.ai', accountUuid: 'disk-acc', organizationUuid: 'disk-org' });
    const cfg = readClaudeHomeConfig(home);
    expect(cfg?.identity.accountId).toBe('disk-acc');
    expect(cfg?.identity.organizationId).toBe('disk-org');
  });

  it('leaves an unregistered email-only home email-only', () => {
    const home = tempHome({ emailAddress: 'stranger@getrush.ai' });
    const cfg = readClaudeHomeConfig(home);
    expect(cfg?.identity.email).toBe('stranger@getrush.ai');
    expect(cfg?.identity.accountId).toBeNull();
    expect(cfg?.identity.accountKey).toBeNull();
  });
});
