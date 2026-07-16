import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  snapshotAuth,
  materializeAuth,
  buildAuthBundle,
  parseAuthBundle,
  FLEET_AUTH_FILES,
  isPropagatableAgent,
} from './auth-sync.js';

function seedFile(home: string, rel: string, content: string, mode = 0o600): void {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  fs.chmodSync(abs, mode);
}

describe('snapshotAuth + materializeAuth round-trip', () => {
  it('captures portable credential files and rewrites them byte-identical on a target', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-src-'));
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-dst-'));
    seedFile(src, '.codex/auth.json', '{"tokens":"codex-abc"}');
    seedFile(src, '.gemini/oauth_creds.json', '{"refresh":"gem-xyz"}');
    seedFile(src, '.factory/auth.v2.file', 'droid-file');
    seedFile(src, '.factory/auth.v2.key', 'droid-key');

    const snap = snapshotAuth(['codex', 'gemini', 'droid'], { home: src, platform: 'linux' });
    // codex(1) + gemini(1) + droid(2) = 4 files
    expect(snap.files).toHaveLength(4);
    expect(snap.bound).toEqual([]);

    const bundle = buildAuthBundle('src-box', snap.files);
    const res = materializeAuth(bundle, { home: dst });
    expect(res.errors).toEqual([]);
    expect(res.written.sort()).toEqual(['codex', 'droid', 'gemini']);

    expect(fs.readFileSync(path.join(dst, '.codex/auth.json'), 'utf-8')).toBe('{"tokens":"codex-abc"}');
    expect(fs.readFileSync(path.join(dst, '.factory/auth.v2.key'), 'utf-8')).toBe('droid-key');
    // credential mode preserved at 0600
    expect(fs.statSync(path.join(dst, '.codex/auth.json')).mode & 0o777).toBe(0o600);
  });

  it('silently skips agents that are not signed in (no file on disk)', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-src-'));
    seedFile(src, '.codex/auth.json', '{"tokens":"only-codex"}');
    const snap = snapshotAuth(['codex', 'gemini', 'grok'], { home: src, platform: 'linux' });
    expect(snap.files.map((f) => f.agent)).toEqual(['codex']);
    expect(snap.bound).toEqual([]);
  });

  it('classifies claude + antigravity as keychain-bound on macOS (never captured)', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-src-'));
    // Even if a stale file exists, darwin must treat these as bound.
    seedFile(src, '.claude/.credentials.json', '{"claudeAiOauth":"x"}');
    const snap = snapshotAuth(['claude', 'antigravity', 'codex'], { home: src, platform: 'darwin' });
    expect(snap.bound.sort()).toEqual(['antigravity', 'claude']);
    expect(snap.files.map((f) => f.agent)).not.toContain('claude');
  });

  it('captures claude credentials on Linux (portable there)', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-src-'));
    seedFile(src, '.claude/.credentials.json', '{"claudeAiOauth":"linux-token"}');
    const snap = snapshotAuth(['claude'], { home: src, platform: 'linux' });
    expect(snap.files.map((f) => f.agent)).toEqual(['claude']);
    expect(snap.bound).toEqual([]);
  });
});

describe('parseAuthBundle', () => {
  it('accepts a well-formed bundle', () => {
    const b = buildAuthBundle('box', [{ agent: 'codex', rel: '.codex/auth.json', contentB64: 'eA==', mode: 0o600 }]);
    const parsed = parseAuthBundle(JSON.stringify(b));
    expect(parsed.source).toBe('box');
    expect(parsed.files).toHaveLength(1);
  });

  it('rejects path traversal in rel', () => {
    const evil = { v: 1, source: 'box', files: [{ agent: 'x', rel: '../../etc/passwd', contentB64: 'eA==', mode: 0o600 }] };
    expect(() => parseAuthBundle(JSON.stringify(evil))).toThrow(/unsafe path/);
  });

  it('rejects an absolute rel', () => {
    const evil = { v: 1, source: 'box', files: [{ agent: 'x', rel: '/etc/shadow', contentB64: 'eA==', mode: 0o600 }] };
    expect(() => parseAuthBundle(JSON.stringify(evil))).toThrow(/unsafe path/);
  });

  it('rejects a malformed / wrong-version bundle', () => {
    expect(() => parseAuthBundle('not json')).toThrow(/valid JSON/);
    expect(() => parseAuthBundle(JSON.stringify({ v: 2, source: 'b', files: [] }))).toThrow(/version/);
    expect(() => parseAuthBundle(JSON.stringify({ v: 1, files: [] }))).toThrow(/source/);
  });
});

describe('FLEET_AUTH_FILES coverage', () => {
  it('maps the verified portable-auth agents and marks them propagatable', () => {
    for (const agent of ['claude', 'codex', 'gemini', 'grok', 'kimi', 'opencode', 'droid', 'antigravity']) {
      expect(FLEET_AUTH_FILES[agent]?.length).toBeGreaterThan(0);
      expect(isPropagatableAgent(agent)).toBe(true);
    }
    expect(isPropagatableAgent('cursor')).toBe(false);
  });
});
