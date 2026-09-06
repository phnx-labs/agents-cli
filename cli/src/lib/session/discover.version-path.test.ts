import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractVersionFromManagedPath } from './discover.js';

/**
 * The version a session resumes under is derived from its transcript path when
 * the transcript carries no embedded version. Every isolated agent EXCEPT codex
 * lives under `versions/<agent>/<version>/home/…`; codex is relocated by
 * CODEX_HOME to `~/.agents/.codex-homes/<version>/`, so its rollouts sit outside
 * the `versions/<agent>/` markers — which is exactly why a codex session read
 * `version = NULL` and native resume fell back to `/continue` (PHNX-3626).
 */
describe('extractVersionFromManagedPath', () => {
  it('reads the label from the current .history/versions/<agent>/<label>/ home', () => {
    // state.ts VERSIONS_DIR — every managed home on a fleet box today. Missing
    // this marker sent droid/cursor/antigravity sessions to the config-symlink
    // fallback, i.e. the DEFAULT installation's label, whatever home they ran in.
    const p = '/home/u/.agents/.history/versions/droid/0.161.0/home/.factory/sessions/abc.jsonl';
    expect(extractVersionFromManagedPath('droid', p)).toBe('0.161.0');
  });

  it('reads the version from the standard versions/<agent>/<version>/ home', () => {
    const p = '/home/u/.agents/versions/claude/2.1.207/home/.claude/projects/-repo/abc.jsonl';
    expect(extractVersionFromManagedPath('claude', p)).toBe('2.1.207');
  });

  it('reads the codex version from the relocated .codex-homes/<version>/ layout', () => {
    const p = '/home/u/.agents/.codex-homes/0.146.0/sessions/2026/08/30/rollout-abc.jsonl';
    expect(extractVersionFromManagedPath('codex', p)).toBe('0.146.0');
  });

  it('does not match the codex-homes marker for a non-codex agent', () => {
    // The relocated-home marker is codex-specific; another agent must not read a
    // version off an incidental `.codex-homes/` path segment.
    const p = '/home/u/.agents/.codex-homes/0.146.0/sessions/x.jsonl';
    expect(extractVersionFromManagedPath('claude', p)).toBeUndefined();
  });

  it('returns undefined for an unmanaged dotfile transcript', () => {
    expect(extractVersionFromManagedPath('codex', '/home/u/.codex/sessions/rollout-x.jsonl')).toBeUndefined();
  });
});

describe('resolveSessionVersion (PHNX-3940 — a path-derived label reports the release it runs)', () => {
  it('maps the managed-path label through the installation record; an embedded version is untouched', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-session-version-'));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    vi.resetModules();
    try {
      const { resolveSessionVersion } = await import('./discover.js');
      const { createInstallation, recordRelease } = await import('../installations/store.js');
      const dir = path.join(home, '.agents', '.history', 'versions', 'droid', '0.161.0');
      fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
      // The label stayed 0.161.0 while an automatic update moved the release.
      recordRelease(createInstallation('droid', '0.161.0', '0.161.0'), '0.170.0');
      const transcript = path.join(dir, 'home', '.factory', 'sessions', 'abc.jsonl');
      expect(resolveSessionVersion('droid', transcript)).toBe('0.170.0');
      // A transcript that embeds its own version already names the release.
      expect(resolveSessionVersion('claude', transcript, '2.1.263')).toBe('2.1.263');
      // A legacy dir with no record is its own release by construction.
      fs.mkdirSync(path.join(home, '.agents', '.history', 'versions', 'cursor', '2026.08.04', 'home'), { recursive: true });
      const legacy = path.join(home, '.agents', '.history', 'versions', 'cursor', '2026.08.04', 'home', '.cursor', 'x.jsonl');
      expect(resolveSessionVersion('cursor', legacy)).toBe('2026.08.04');
    } finally {
      process.env.HOME = prevHome;
      vi.resetModules();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
