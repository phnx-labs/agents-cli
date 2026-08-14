/**
 * Tests for the project-pull library (RUSH-2536).
 *
 * Coverage:
 *   - fingerprintTargets — deterministic, order-independent
 *   - parseProjectPullEnvelope — fail-closed validation (schema, kind, machine, fingerprint)
 *   - projectPullComplete — exit-code predicate
 *   - pullProjectTargets — real git repos; missing / slug-mismatch / dirty / ahead blocks
 *   - buildPullEnvelope — round-trip with parseProjectPullEnvelope
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import {
  buildPullEnvelope,
  fingerprintTargets,
  parseProjectPullEnvelope,
  projectPullComplete,
  pullProjectTargets,
  type ProjectPullResult,
} from './project-pull.js';
import type { ProjectRepoTarget } from './projects.js';

// ---------------------------------------------------------------------------
// fingerprintTargets
// ---------------------------------------------------------------------------

describe('fingerprintTargets', () => {
  it('produces a 16-char hex string', () => {
    const fp = fingerprintTargets([{ path: '~/src/foo' }]);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same input', () => {
    const targets: ProjectRepoTarget[] = [
      { path: '~/src/a', expectedSlug: 'org/a' },
      { path: '~/src/b' },
    ];
    expect(fingerprintTargets(targets)).toBe(fingerprintTargets(targets));
  });

  it('is order-independent', () => {
    const t1: ProjectRepoTarget[] = [{ path: '~/a' }, { path: '~/b' }];
    const t2: ProjectRepoTarget[] = [{ path: '~/b' }, { path: '~/a' }];
    expect(fingerprintTargets(t1)).toBe(fingerprintTargets(t2));
  });

  it('differs when expectedSlug differs', () => {
    const fpWithSlug = fingerprintTargets([{ path: '~/src/a', expectedSlug: 'org/a' }]);
    const fpNoSlug   = fingerprintTargets([{ path: '~/src/a' }]);
    expect(fpWithSlug).not.toBe(fpNoSlug);
  });
});

// ---------------------------------------------------------------------------
// parseProjectPullEnvelope (fail-closed)
// ---------------------------------------------------------------------------

describe('parseProjectPullEnvelope', () => {
  const machine = 'test-machine';
  const targets: ProjectRepoTarget[] = [{ path: '~/src/a' }];

  function validEnvelope(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schemaVersion: 1,
      kind: 'project-pull',
      machine,
      targetFingerprint: fingerprintTargets(targets),
      results: [{ host: machine, path: '~/src/a', status: 'current' }],
      ...overrides,
    });
  }

  it('parses a well-formed envelope', () => {
    const results = parseProjectPullEnvelope(validEnvelope(), machine);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('current');
    expect(results[0].path).toBe('~/src/a');
  });

  it('returns [] for non-JSON input', () => {
    expect(parseProjectPullEnvelope('not json', machine)).toEqual([]);
  });

  it('returns [] when schemaVersion is wrong', () => {
    expect(parseProjectPullEnvelope(validEnvelope({ schemaVersion: 2 }), machine)).toEqual([]);
  });

  it('returns [] when kind is wrong', () => {
    expect(parseProjectPullEnvelope(validEnvelope({ kind: 'project-status' }), machine)).toEqual([]);
  });

  it('returns [] when machine does not match', () => {
    expect(parseProjectPullEnvelope(validEnvelope(), 'other-machine')).toEqual([]);
  });

  it('returns [] when fingerprint does not match and opts.expectedFingerprint is set', () => {
    const results = parseProjectPullEnvelope(validEnvelope(), machine, { expectedFingerprint: 'deadbeef12345678' });
    expect(results).toEqual([]);
  });

  it('accepts any fingerprint when opts.expectedFingerprint is absent', () => {
    const results = parseProjectPullEnvelope(validEnvelope(), machine);
    expect(results).toHaveLength(1);
  });

  it('returns [] when results is not an array', () => {
    expect(parseProjectPullEnvelope(validEnvelope({ results: null }), machine)).toEqual([]);
  });

  it('skips result rows missing a status or path', () => {
    const env = validEnvelope({
      results: [
        { host: machine, path: '~/src/a', status: 'current' },
        { host: machine, status: 'updated' },           // no path
        { host: machine, path: '~/src/b' },             // no status
        { host: machine, path: '~/src/c', status: 'bad-status' }, // invalid status
      ],
    });
    const results = parseProjectPullEnvelope(env, machine);
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('~/src/a');
  });

  it('maps optional fields through when present', () => {
    const env = validEnvelope({
      results: [{
        host: machine,
        path: '~/src/a',
        status: 'updated',
        branch: 'main',
        before: 'abcd1234',
        after: 'efgh5678',
        message: 'fast-forwarded',
        expectedSlug: 'org/a',
      }],
    });
    const [r] = parseProjectPullEnvelope(env, machine);
    expect(r.branch).toBe('main');
    expect(r.before).toBe('abcd1234');
    expect(r.after).toBe('efgh5678');
    expect(r.message).toBe('fast-forwarded');
    expect(r.expectedSlug).toBe('org/a');
  });
});

// ---------------------------------------------------------------------------
// projectPullComplete
// ---------------------------------------------------------------------------

describe('projectPullComplete', () => {
  const base = { host: 'h', path: '~/p' } as const;

  it('returns true for all-updated', () => {
    const results: ProjectPullResult[] = [{ ...base, status: 'updated' }, { ...base, status: 'updated' }];
    expect(projectPullComplete(results)).toBe(true);
  });

  it('returns true for all-current', () => {
    const results: ProjectPullResult[] = [{ ...base, status: 'current' }];
    expect(projectPullComplete(results)).toBe(true);
  });

  it('returns true when some are missing (missing does not count as failure)', () => {
    const results: ProjectPullResult[] = [{ ...base, status: 'current' }, { ...base, status: 'missing' }];
    expect(projectPullComplete(results)).toBe(true);
  });

  it('returns false when any is blocked', () => {
    const results: ProjectPullResult[] = [{ ...base, status: 'current' }, { ...base, status: 'blocked' }];
    expect(projectPullComplete(results)).toBe(false);
  });

  it('returns false when any is failed', () => {
    const results: ProjectPullResult[] = [{ ...base, status: 'updated' }, { ...base, status: 'failed' }];
    expect(projectPullComplete(results)).toBe(false);
  });

  it('returns true for an empty result set', () => {
    expect(projectPullComplete([])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pullProjectTargets — real git repos
// ---------------------------------------------------------------------------

describe('pullProjectTargets', () => {
  let root: string;
  let remote: string;
  let author: string;
  let local: string;

  async function configIdentity(dir: string): Promise<void> {
    const g = simpleGit(dir);
    await g.addConfig('user.email', 'test@example.com');
    await g.addConfig('user.name', 'Test');
    await g.addConfig('commit.gpgsign', 'false');
    await g.addConfig('core.autocrlf', 'false');
  }

  async function commitFile(dir: string, name: string, body: string, msg: string): Promise<void> {
    const g = simpleGit(dir);
    fs.writeFileSync(path.join(dir, name), body);
    await g.add('-A');
    await g.commit(msg);
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-pull-'));
    remote = path.join(root, 'remote.git');
    author = path.join(root, 'author');
    local = path.join(root, 'local');

    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]);
    await simpleGit().clone(remote, author);
    await configIdentity(author);
    await commitFile(author, 'README.md', 'v1\n', 'init');
    await simpleGit(author).push('origin', 'main');

    await simpleGit().clone(remote, local);
    await configIdentity(local);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports missing for a path that does not exist', async () => {
    const targets: ProjectRepoTarget[] = [{ path: path.join(root, 'nonexistent') }];
    const results = await pullProjectTargets(targets, 'host');
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('missing');
  });

  it('reports missing for a directory that is not a git repo', async () => {
    const plainDir = path.join(root, 'plain');
    fs.mkdirSync(plainDir);
    const targets: ProjectRepoTarget[] = [{ path: plainDir }];
    const results = await pullProjectTargets(targets, 'host');
    expect(results[0].status).toBe('missing');
  });

  it('fast-forwards a clean checkout that is behind upstream', async () => {
    await commitFile(author, 'new.txt', 'new\n', 'upstream commit');
    await simpleGit(author).push('origin', 'main');

    const targets: ProjectRepoTarget[] = [{ path: local }];
    const results = await pullProjectTargets(targets, 'host');

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('updated');
    expect(results[0].before).toBeTruthy();
    expect(results[0].after).toBeTruthy();
    expect(results[0].before).not.toBe(results[0].after);
    expect(fs.existsSync(path.join(local, 'new.txt'))).toBe(true);
  });

  it('reports current when already up-to-date', async () => {
    const targets: ProjectRepoTarget[] = [{ path: local }];
    const results = await pullProjectTargets(targets, 'host');
    expect(results[0].status).toBe('current');
  });

  it('blocks a dirty tree', async () => {
    fs.writeFileSync(path.join(local, 'dirty.txt'), 'unsaved\n');
    const targets: ProjectRepoTarget[] = [{ path: local }];
    const results = await pullProjectTargets(targets, 'host');
    expect(results[0].status).toBe('blocked');
    expect(results[0].message).toMatch(/dirty|uncommitted/i);
  });

  it('blocks when the checkout has local commits ahead of upstream', async () => {
    await commitFile(local, 'local.txt', 'local\n', 'local commit');
    const targets: ProjectRepoTarget[] = [{ path: local }];
    const results = await pullProjectTargets(targets, 'host');
    expect(results[0].status).toBe('blocked');
    expect(results[0].message).toMatch(/ahead/i);
  });

  it('blocks on a feature branch', async () => {
    await simpleGit(local).checkoutBranch('feature/x', 'main');
    const targets: ProjectRepoTarget[] = [{ path: local }];
    const results = await pullProjectTargets(targets, 'host');
    expect(results[0].status).toBe('blocked');
  });

  it('processes multiple targets sequentially, continuing past missing ones', async () => {
    const missing = path.join(root, 'missing');
    const targets: ProjectRepoTarget[] = [
      { path: missing },
      { path: local },
    ];
    const results = await pullProjectTargets(targets, 'host');
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('missing');
    expect(results[1].status).toBe('current');
  });

  it('reports the host field from the argument', async () => {
    const targets: ProjectRepoTarget[] = [{ path: local }];
    const results = await pullProjectTargets(targets, 'my-machine');
    expect(results[0].host).toBe('my-machine');
  });
});

// ---------------------------------------------------------------------------
// buildPullEnvelope + round-trip through parseProjectPullEnvelope
// ---------------------------------------------------------------------------

describe('buildPullEnvelope round-trip', () => {
  it('produces an envelope that parses back to the same results', () => {
    const targets: ProjectRepoTarget[] = [{ path: '~/src/a', expectedSlug: 'org/a' }];
    const results: ProjectPullResult[] = [
      { host: 'test-host', path: '~/src/a', expectedSlug: 'org/a', status: 'current', branch: 'main' },
    ];
    const envelope = buildPullEnvelope(results, targets);

    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.kind).toBe('project-pull');
    expect(typeof envelope.machine).toBe('string');
    expect(envelope.targetFingerprint).toBe(fingerprintTargets(targets));

    const parsed = parseProjectPullEnvelope(JSON.stringify(envelope), envelope.machine, {
      expectedFingerprint: envelope.targetFingerprint,
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('~/src/a');
    expect(parsed[0].status).toBe('current');
    expect(parsed[0].branch).toBe('main');
  });
});
