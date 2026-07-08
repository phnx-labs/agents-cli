import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildLock,
  serializeLock,
  writeLock,
  readLock,
  verifyLock,
  diffLock,
  lockDiffIsClean,
  LOCK_VERSION,
  type LockSource,
} from './lock.js';

/**
 * Build a temp resource root with the layout the lock captures:
 *   commands/plan.md, commands/test.md   (single files)
 *   skills/debug/SKILL.md + a nested file (a directory resource)
 *   hooks/guard.sh + hooks/guard.yaml    (script + sidecar — must not collide)
 *   mcp/server.yaml                       (single file)
 */
function makeResourceRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-lock-test-'));
  fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, 'commands', 'plan.md'), '# plan\nrun the plan\n');
  fs.writeFileSync(path.join(root, 'commands', 'test.md'), '# test\nrun the tests\n');
  fs.mkdirSync(path.join(root, 'skills', 'debug', 'refs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'debug', 'SKILL.md'), '---\nname: debug\n---\nbody\n');
  fs.writeFileSync(path.join(root, 'skills', 'debug', 'refs', 'notes.md'), 'notes\n');
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hooks', 'guard.sh'), '#!/bin/sh\necho guard\n');
  fs.writeFileSync(path.join(root, 'hooks', 'guard.yaml'), 'matches: []\n');
  fs.mkdirSync(path.join(root, 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mcp', 'server.yaml'), 'name: server\n');
  return root;
}

/**
 * Enumerate the temp root's resources into LockSource[] — mirrors the mapping
 * enumerateLockSources() does per layer, but confined to this one dir so the
 * test is deterministic (no dependency on the real ~/.agents layers).
 */
function sourcesFor(root: string): LockSource[] {
  const out: LockSource[] = [];
  for (const kind of ['commands', 'skills', 'hooks', 'mcp']) {
    const kindDir = path.join(root, kind);
    if (!fs.existsSync(kindDir)) continue;
    for (const name of fs.readdirSync(kindDir)) {
      out.push({ path: path.join(kindDir, name), key: `${kind}/${name}` });
    }
  }
  return out;
}

describe('agents.lock generation', () => {
  it('captures a sha256 per resolved file, keyed by relpath', () => {
    const root = makeResourceRoot();
    const lock = buildLock(sourcesFor(root));

    expect(lock.version).toBe(LOCK_VERSION);
    const keys = Object.keys(lock.resources);
    // Directory resources expand to every contained file; files map 1:1.
    expect(keys).toContain('commands/plan.md');
    expect(keys).toContain('commands/test.md');
    expect(keys).toContain('skills/debug/SKILL.md');
    expect(keys).toContain('skills/debug/refs/notes.md');
    expect(keys).toContain('mcp/server.yaml');
    // Script + sidecar with the same basename stay distinct — no collision.
    expect(keys).toContain('hooks/guard.sh');
    expect(keys).toContain('hooks/guard.yaml');
    // Every value is a 64-char hex sha256.
    for (const v of Object.values(lock.resources)) expect(v).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic and sorted (byte-stable serialization)', () => {
    const root = makeResourceRoot();
    const a = serializeLock(buildLock(sourcesFor(root)));
    const b = serializeLock(buildLock(sourcesFor(root)));
    expect(a).toBe(b);
    const keys = Object.keys(JSON.parse(a).resources);
    expect(keys).toEqual([...keys].sort());
    expect(a.endsWith('\n')).toBe(true);
  });

  it('round-trips through write + read', () => {
    const root = makeResourceRoot();
    const lock = buildLock(sourcesFor(root));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-lock-root-'));
    writeLock(projectRoot, lock);
    const back = readLock(projectRoot);
    expect(back).toEqual(lock);
  });
});

describe('agents lock --frozen verification', () => {
  it('passes when nothing changed', () => {
    const root = makeResourceRoot();
    const lock = buildLock(sourcesFor(root));
    const diff = verifyLock(lock, sourcesFor(root));
    expect(lockDiffIsClean(diff)).toBe(true);
  });

  it('reports the exact changed path when a file is mutated', () => {
    const root = makeResourceRoot();
    const lock = buildLock(sourcesFor(root));

    fs.writeFileSync(path.join(root, 'commands', 'plan.md'), '# plan\nMUTATED\n');

    const diff = verifyLock(lock, sourcesFor(root));
    expect(lockDiffIsClean(diff)).toBe(false);
    expect(diff.changed).toEqual(['commands/plan.md']);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('detects a mutated file nested inside a directory resource', () => {
    const root = makeResourceRoot();
    const lock = buildLock(sourcesFor(root));

    fs.writeFileSync(path.join(root, 'skills', 'debug', 'refs', 'notes.md'), 'CHANGED\n');

    const diff = verifyLock(lock, sourcesFor(root));
    expect(diff.changed).toEqual(['skills/debug/refs/notes.md']);
  });

  it('detects an added file', () => {
    const root = makeResourceRoot();
    const lock = buildLock(sourcesFor(root));

    fs.writeFileSync(path.join(root, 'commands', 'ship.md'), '# ship\n');

    const diff = verifyLock(lock, sourcesFor(root));
    expect(diff.added).toEqual(['commands/ship.md']);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(lockDiffIsClean(diff)).toBe(false);
  });

  it('detects a removed file', () => {
    const root = makeResourceRoot();
    const lock = buildLock(sourcesFor(root));

    fs.rmSync(path.join(root, 'mcp', 'server.yaml'));

    const diff = verifyLock(lock, sourcesFor(root));
    expect(diff.removed).toEqual(['mcp/server.yaml']);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it('reports added, removed, and changed together', () => {
    const root = makeResourceRoot();
    const lock = buildLock(sourcesFor(root));

    fs.writeFileSync(path.join(root, 'commands', 'plan.md'), 'changed\n'); // changed
    fs.rmSync(path.join(root, 'commands', 'test.md')); // removed
    fs.writeFileSync(path.join(root, 'hooks', 'extra.sh'), '#!/bin/sh\n'); // added

    const diff = diffLock(lock, buildLock(sourcesFor(root)));
    expect(diff.changed).toEqual(['commands/plan.md']);
    expect(diff.removed).toEqual(['commands/test.md']);
    expect(diff.added).toEqual(['hooks/extra.sh']);
  });
});

describe('readLock error handling', () => {
  it('returns null when no lock exists (distinct from malformed)', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-lock-empty-'));
    expect(readLock(projectRoot)).toBeNull();
  });

  it('throws (fails closed) on a malformed lock rather than treating it as absent', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-lock-bad-'));
    fs.writeFileSync(path.join(projectRoot, 'agents.lock'), '{ not json');
    expect(() => readLock(projectRoot)).toThrow();
  });

  it('throws on an unsupported lock version', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-lock-ver-'));
    fs.writeFileSync(path.join(projectRoot, 'agents.lock'), JSON.stringify({ version: 999, resources: {} }));
    expect(() => readLock(projectRoot)).toThrow(/version/);
  });
});
