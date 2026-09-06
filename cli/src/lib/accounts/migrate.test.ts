/**
 * Real-filesystem tests for folding N per-account installations into 1 install
 * + N slots (PHNX-3940 T7). Uses the fork-private HOME from tests/setup.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  applyAccountMigration,
  planAccountMigration,
} from './migrate.js';
import {
  createInstallation,
  getGlobalDefault,
  getVersionDir,
  invalidateInstalledVersionsCache,
  listInstalledVersions,
  setGlobalDefault,
} from '../installations/versions.js';
import { getDB } from '../session/db.js';
import { readSlots } from './slots.js';
import { listNativeAccounts, removeAccount } from '../account-registry.js';
import { getHistoryDir, getVersionsDir, readMeta } from '../state.js';
import { restoreVersion } from '../../commands/trash.js';

const suffix = `t7${Date.now().toString(36)}`;
const labels = {
  emptyDefault: `0.1.0-${suffix}`,
  empty2: `0.2.0-${suffix}`,
  empty3: `0.3.0-${suffix}`,
  gmailOld: `0.4.0-${suffix}`,
  icloud: `0.5.0-${suffix}`,
  gmailNew: `0.6.0-${suffix}`,
} as const;
const gmail = `gmail-${suffix}@example.com`;
const icloud = `icloud-${suffix}@example.com`;
const allLabels = Object.values(labels);
const plantedAccounts: string[] = [];
const sessionId = `t7-sess-${suffix}`;

function plantInstall(label: string, release: string, login?: { email: string }): string {
  const dir = getVersionDir('claude', label);
  const pkgRoot = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(path.join(pkgRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({
    name: '@anthropic-ai/claude-code',
    version: release,
    bin: { claude: 'bin/claude-launcher' },
  }));
  fs.writeFileSync(path.join(pkgRoot, 'bin', 'claude-launcher'), 'REAL BINARY');
  const homeDir = path.join(dir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  if (login) {
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({
      oauthAccount: {
        emailAddress: login.email,
        accountUuid: `acct-${login.email}`,
        organizationUuid: `org-${login.email}`,
        organizationType: 'claude_pro',
      },
    }));
    fs.writeFileSync(
      path.join(homeDir, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 86_400_000 } }),
    );
  }
  createInstallation('claude', label, release);
  return dir;
}

function treeSnapshot(root: string): string {
  const rows: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        rows.push(`${rel}/`);
        walk(full);
      } else if (entry.name.endsWith('.db') || entry.name.endsWith('-wal') || entry.name.endsWith('-shm') || entry.name === 'last-active.json') {
        rows.push(`${rel}:present`);
      } else {
        const buf = fs.readFileSync(full);
        rows.push(`${rel}:${buf.length}:${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}`);
      }
    }
  };
  walk(root);
  return rows.join('\n');
}

function listTrashLabels(): string[] {
  const root = path.join(getHistoryDir(), 'trash', 'versions', 'claude');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((n) => allLabels.includes(n as typeof allLabels[number])).sort();
}

function fixtureFleet(): { sessionFile: string; prevDefault: string | null } {
  const prevDefault = getGlobalDefault('claude');
  plantInstall(labels.emptyDefault, '0.1.0');
  plantInstall(labels.empty2, '0.2.0');
  plantInstall(labels.empty3, '0.3.0');
  plantInstall(labels.gmailOld, '0.4.0', { email: gmail });
  plantInstall(labels.icloud, '0.5.0', { email: icloud });
  plantInstall(labels.gmailNew, '0.6.0', { email: gmail });
  invalidateInstalledVersionsCache('claude');
  setGlobalDefault('claude', labels.emptyDefault);

  const sessionFile = path.join(
    getVersionDir('claude', labels.icloud),
    'home',
    '.claude',
    'projects',
    '-Users-t7-proj',
    `${suffix}.jsonl`,
  );
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: 'user', message: { content: 'hello from t7' } })}\n`);
  const db = getDB();
  db.prepare(`
    INSERT INTO sessions (id, short_id, agent, timestamp, last_activity, file_path, is_team_origin)
    VALUES (?, ?, 'claude', ?, ?, ?, 0)
  `).run(sessionId, sessionId.slice(0, 8), new Date().toISOString(), new Date().toISOString(), sessionFile);
  return { sessionFile, prevDefault };
}

function cleanup(prevDefault: string | null): void {
  try {
    getDB().prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  } catch { /* db may not exist */ }
  for (const name of plantedAccounts.splice(0)) {
    try { removeAccount(`claude#${name}`); } catch { /* already gone */ }
  }
  for (const row of listNativeAccounts(readMeta()).filter((a) => a.identityLabel === gmail || a.identityLabel === icloud)) {
    try { removeAccount(`claude#${row.name}`); } catch { /* already gone */ }
  }
  for (const label of allLabels) {
    const dir = getVersionDir('claude', label);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    const trash = path.join(getHistoryDir(), 'trash', 'versions', 'claude', label);
    if (fs.existsSync(trash)) fs.rmSync(trash, { recursive: true, force: true });
  }
  const accountsDir = path.join(getHistoryDir(), 'accounts', 'claude');
  if (fs.existsSync(accountsDir)) {
    for (const id of fs.readdirSync(accountsDir)) {
      const p = path.join(accountsDir, id);
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  const manifests = path.join(getHistoryDir(), 'accounts');
  if (fs.existsSync(manifests)) {
    for (const f of fs.readdirSync(manifests)) {
      if (f.startsWith('migration-') && f.endsWith('.json')) fs.rmSync(path.join(manifests, f), { force: true });
    }
  }
  if (prevDefault) setGlobalDefault('claude', prevDefault);
  else setGlobalDefault('claude', undefined);
  invalidateInstalledVersionsCache('claude');
}

describe('accounts migrate (PHNX-3940 T7)', () => {
  let prevDefault: string | null = null;

  afterEach(() => {
    cleanup(prevDefault);
    prevDefault = null;
  });

  it('--dry-run leaves install bytes untouched and reports 1 install + 2 slots + 4 trash', async () => {
    prevDefault = fixtureFleet().prevDefault;
    const versionsRoot = path.join(getVersionsDir(), 'claude');
    const before = treeSnapshot(versionsRoot);
    const plan = await planAccountMigration(['claude'], { isActive: async () => false });
    const ours = plan.harnesses[0]!;
    expect(ours.inventory.filter((i) => allLabels.includes(i.label as typeof allLabels[number]))).toHaveLength(6);
    expect(ours.actions.filter((a) => a.kind === 'slot')).toHaveLength(2);
    expect(ours.actions.filter((a) => a.kind === 'trash')).toHaveLength(4);
    expect(ours.canonical).toBe(labels.gmailNew);
    expect(treeSnapshot(versionsRoot)).toBe(before);
    expect(getGlobalDefault('claude')).toBe(labels.emptyDefault);
    expect(fs.readdirSync(versionsRoot).filter((n) => allLabels.includes(n as typeof allLabels[number])).sort()).toEqual([...allLabels].sort());
  });

  it('apply folds 6 installs into 1 install + 2 slots + 4 trashed, repoints default, reindexes sessions, writes a manifest', async () => {
    const fx = fixtureFleet();
    prevDefault = fx.prevDefault;
    const result = await applyAccountMigration(['claude'], { isActive: async () => false });
    const ours = result.plan.harnesses[0]!;
    expect(ours.actions.filter((a) => a.kind === 'slot')).toHaveLength(2);
    expect(ours.actions.filter((a) => a.kind === 'trash')).toHaveLength(4);
    expect(ours.canonical).toBe(labels.gmailNew);
    expect(getGlobalDefault('claude')).toBe(labels.gmailNew);
    expect(listInstalledVersions('claude').filter((v) => allLabels.includes(v as typeof allLabels[number]))).toEqual([labels.gmailNew]);

    const slots = Object.values(readSlots(readMeta()));
    const oursSlots = slots.filter((s) => fs.existsSync(path.join(s.slotDir, '.claude.json')));
    expect(oursSlots.length).toBeGreaterThanOrEqual(2);
    for (const slot of oursSlots) {
      expect(fs.existsSync(path.join(slot.slotDir, '.claude', '.credentials.json'))).toBe(true);
      expect(fs.existsSync(path.join(slot.slotDir, 'node_modules'))).toBe(false);
    }

    const natives = listNativeAccounts(readMeta()).filter((a) => a.agent === 'claude' && (a.identityLabel === gmail || a.identityLabel === icloud));
    expect(natives).toHaveLength(2);
    plantedAccounts.push(...natives.map((a) => a.name));

    const liveHome = path.join(getVersionDir('claude', labels.gmailNew), 'home');
    expect(fs.existsSync(path.join(liveHome, '.claude.json'))).toBe(false);

    const row = getDB().prepare(`SELECT file_path FROM sessions WHERE id = ?`).get(sessionId) as { file_path: string };
    expect(row.file_path).not.toBe(fx.sessionFile);
    expect(row.file_path.includes(`${path.sep}accounts${path.sep}claude${path.sep}`)).toBe(true);
    expect(fs.existsSync(row.file_path)).toBe(true);
    expect(result.sessionsReindexed).toBeGreaterThanOrEqual(1);

    expect(fs.existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')) as { dryRun: boolean; schema: number };
    expect(manifest.dryRun).toBe(false);
    expect(manifest.schema).toBe(1);
    expect(listTrashLabels()).toEqual(expect.arrayContaining([labels.emptyDefault, labels.empty2, labels.empty3, labels.gmailOld]));
  });

  it('a busy home is deferred and never moved', async () => {
    prevDefault = fixtureFleet().prevDefault;
    const result = await applyAccountMigration(['claude'], {
      isActive: async (inst) => inst.label === labels.icloud,
    });
    const ours = result.plan.harnesses[0]!;
    expect(ours.actions.some((a) => a.kind === 'defer' && a.label === labels.icloud)).toBe(true);
    expect(fs.existsSync(getVersionDir('claude', labels.icloud))).toBe(true);
    expect(fs.existsSync(path.join(getVersionDir('claude', labels.icloud), 'home', '.claude.json'))).toBe(true);
    const live = listInstalledVersions('claude').filter((v) => allLabels.includes(v as typeof allLabels[number])).sort();
    expect(live).toEqual([labels.icloud, labels.gmailNew].sort());
  });

  it('agents trash restore reverses one trashed home', async () => {
    prevDefault = fixtureFleet().prevDefault;
    await applyAccountMigration(['claude'], { isActive: async () => false });
    expect(fs.existsSync(getVersionDir('claude', labels.emptyDefault))).toBe(false);
    expect(listTrashLabels()).toContain(labels.emptyDefault);
    restoreVersion(`claude@${labels.emptyDefault}`);
    expect(fs.existsSync(getVersionDir('claude', labels.emptyDefault))).toBe(true);
    expect(fs.existsSync(path.join(getVersionDir('claude', labels.emptyDefault), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude-launcher'))).toBe(true);
  });

  it('fails loud on an unreadable installation.json', async () => {
    const label = `0.9.0-${suffix}-bad`;
    plantInstall(label, '0.9.0');
    fs.writeFileSync(path.join(getVersionDir('claude', label), 'installation.json'), '{not-json');
    invalidateInstalledVersionsCache('claude');
    await expect(planAccountMigration(['claude'], { isActive: async () => false }))
      .rejects.toThrow(/Unreadable installation\.json for claude@0\.9\.0/);
    fs.rmSync(getVersionDir('claude', label), { recursive: true, force: true });
  });

  it('fails loud when a slot dir already exists for the account', async () => {
    prevDefault = fixtureFleet().prevDefault;
    await applyAccountMigration(['claude'], { isActive: async () => false });
    const natives = listNativeAccounts(readMeta()).filter((a) => a.identityLabel === gmail || a.identityLabel === icloud);
    plantedAccounts.push(...natives.map((a) => a.name));
    const extra = `0.7.0-${suffix}`;
    plantInstall(extra, '0.7.0', { email: gmail });
    invalidateInstalledVersionsCache('claude');
    await expect(applyAccountMigration(['claude'], { isActive: async () => false }))
      .rejects.toThrow(/Slot already exists/);
    fs.rmSync(getVersionDir('claude', extra), { recursive: true, force: true });
  });
});
