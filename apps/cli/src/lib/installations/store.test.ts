/**
 * The installation record is the frozen identity of an install. These pin the
 * behaviours that identity depends on: it is minted once and never re-minted,
 * migration infers the release from a pre-frozen directory name, and a record a
 * newer CLI wrote is refused rather than misread.
 *
 * Real filesystem, real records — HOME is redirected to a temp dir so `state.ts`
 * resolves the versions dir there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let home: string;

async function load() {
  vi.resetModules();
  return import('./store.js');
}

function versionDir(label: string, agent = 'claude'): string {
  return path.join(home, '.agents', '.history', 'versions', agent, label);
}

function makeVersionDir(label: string, agent = 'claude'): string {
  const dir = versionDir(label, agent);
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  return dir;
}

describe('installation store', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-installations-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('mints an opaque id that is not derived from the release', async () => {
    const store = await load();
    makeVersionDir('2.0.65');
    const created = store.createInstallation('claude', '2.0.65', '2.0.65');

    expect(created.id).toMatch(/^ins_[0-9a-f]{24}$/);
    expect(created.id).not.toContain('2.0.65');
    expect(created.label).toBe('2.0.65');
    expect(created.releaseVersion).toBe('2.0.65');
    expect(created.history).toEqual([{ releaseVersion: '2.0.65', at: created.createdAt }]);
    expect(fs.existsSync(path.join(versionDir('2.0.65'), 'installation.json'))).toBe(true);
  });

  it('keeps the same id when the install path runs again — a repair must not re-mint identity', async () => {
    const store = await load();
    makeVersionDir('2.0.65');
    const first = store.createInstallation('claude', '2.0.65', '2.0.65');
    const second = store.createInstallation('claude', '2.0.65', '2.0.65');

    expect(second.id).toBe(first.id);
    expect(second.history).toHaveLength(1);
  });

  it('migrates a pre-frozen version dir by reading its release from the directory name', async () => {
    const store = await load();
    const dir = makeVersionDir('1.9.0');
    expect(fs.existsSync(path.join(dir, 'installation.json'))).toBe(false);
    // Snapshot before migrating: writing the record into the dir bumps its mtime.
    const dirCreated = fs.statSync(dir).mtime.toISOString();

    const migrated = store.ensureInstallation('claude', '1.9.0');
    expect(migrated.label).toBe('1.9.0');
    expect(migrated.releaseVersion).toBe('1.9.0');
    // Dated from the directory, not from "now" — a migrated install did not
    // start existing at migration time.
    expect(migrated.createdAt).toBe(dirCreated);

    // Migration is persisted, so the id is stable across reads.
    expect((await load()).ensureInstallation('claude', '1.9.0').id).toBe(migrated.id);
  });

  it('refuses to describe an installation whose directory does not exist', async () => {
    const store = await load();
    expect(() => store.ensureInstallation('claude', '9.9.9')).toThrow(/No installation directory/);
  });

  it('moves the release forward while preserving id, label and creation time', async () => {
    const store = await load();
    makeVersionDir('2.0.65');
    const created = store.createInstallation('claude', '2.0.65', '2.0.65');
    const updated = store.recordRelease(created, '2.1.220');

    expect(updated.id).toBe(created.id);
    expect(updated.label).toBe('2.0.65');
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.releaseVersion).toBe('2.1.220');
    expect(updated.history.map((h) => h.releaseVersion)).toEqual(['2.0.65', '2.1.220']);

    // And it survives a reload, so the label keeps addressing the same install.
    expect((await load()).readInstallation('claude', '2.0.65')?.releaseVersion).toBe('2.1.220');
  });

  it('lists duplicate installations of the same release as separate identities', async () => {
    const store = await load();
    makeVersionDir('2.0.65');
    makeVersionDir('2.0.65-b');
    const a = store.createInstallation('claude', '2.0.65', '2.0.65');
    const b = store.createInstallation('claude', '2.0.65-b', '2.0.65');

    expect(a.id).not.toBe(b.id);
    const listed = store.listInstallations('claude');
    expect(listed.map((i) => i.label)).toEqual(['2.0.65', '2.0.65-b']);
    expect(listed.every((i) => i.releaseVersion === '2.0.65')).toBe(true);
  });

  it('refuses a record written by a newer schema instead of misreading it', async () => {
    const store = await load();
    const dir = makeVersionDir('2.0.65');
    store.createInstallation('claude', '2.0.65', '2.0.65');
    const file = path.join(dir, 'installation.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf-8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, schema: 99 }));

    expect(() => store.readInstallation('claude', '2.0.65')).toThrow(/newer agents-cli/);
  });

  it('refuses a corrupted record instead of silently minting a replacement', async () => {
    const store = await load();
    const dir = makeVersionDir('2.0.65');
    fs.writeFileSync(path.join(dir, 'installation.json'), '{ not json');

    expect(() => store.ensureInstallation('claude', '2.0.65')).toThrow(/not valid JSON/);
  });

  it('rejects a label that could escape the versions directory', async () => {
    const store = await load();
    expect(() => store.createInstallation('claude', '../escape', '1.0.0')).toThrow(/Invalid installation label/);
  });
});
