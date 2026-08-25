import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  snapshotAuth,
  FLEET_AUTH_FILES,
  isPropagatableAgent,
  hasPortableAuthFiles,
  isCredentialSafeToPropagate,
  SINGLE_USE_ROTATING_REFRESH_AGENTS,
} from './auth-sync.js';

function seedFile(home: string, rel: string, content: string, mode = 0o600): void {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  fs.chmodSync(abs, mode);
}

// RUSH-2527 / SING-1b: a native OAuth / session login MUST NOT be copied between
// devices. `snapshotAuth` — the read/capture side of `apply`'s former login
// propagation — therefore captures NOTHING, for every agent, on every platform,
// signed in or not. The old receive/materialize primitive is deleted, so there
// is no hidden write path left to exercise.
describe('snapshotAuth — native OAuth logins are never captured (SING-1b)', () => {
  it('captures nothing even for a signed-in portable runtime (codex) on Linux', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-src-'));
    seedFile(src, '.codex/auth.json', '{"tokens":"codex-abc"}');
    const snap = snapshotAuth(['codex', 'gemini'], { home: src, platform: 'linux' });
    expect(snap.files).toEqual([]);
    expect(snap.bound).toEqual([]);
  });

  it('captures nothing for claude on Linux (was portable there) nor codex', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-src-'));
    seedFile(src, '.claude/.credentials.json', '{"claudeAiOauth":"linux-token"}');
    seedFile(src, '.codex/auth.json', '{"tokens":"x"}');
    const snap = snapshotAuth(['claude', 'codex'], { home: src, platform: 'linux' });
    expect(snap.files).toEqual([]);
    expect(snap.bound).toEqual([]);
  });

  it('captures nothing on macOS either — claude/antigravity are never read', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-src-'));
    seedFile(src, '.claude/.credentials.json', '{"claudeAiOauth":"x"}');
    const snap = snapshotAuth(['claude', 'antigravity', 'codex'], { home: src, platform: 'darwin' });
    expect(snap.files).toEqual([]);
    expect(snap.bound).toEqual([]);
  });

  it('captures nothing for a single-use rotating refresh token (droid) — same as every other login now', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-src-'));
    seedFile(src, '.factory/auth.v2.file', 'droid-file');
    seedFile(src, '.factory/auth.v2.key', 'droid-key');
    const snap = snapshotAuth(['droid'], { home: src, platform: 'linux' });
    expect(snap.files).toEqual([]);
    expect(snap.bound).toEqual([]);
  });
});

describe('FLEET_AUTH_FILES coverage', () => {
  it('maps the portable-auth agents but NONE are propagatable anymore (SING-1b)', () => {
    for (const agent of ['claude', 'codex', 'grok', 'kimi', 'opencode', 'antigravity']) {
      expect(FLEET_AUTH_FILES[agent]?.length).toBeGreaterThan(0);
      // Portable file on disk, but a native OAuth login is never copied between devices.
      expect(isCredentialSafeToPropagate(agent)).toBe(false);
      expect(isPropagatableAgent(agent)).toBe(false);
    }
  });

  it('droid stays documented as single-use rotating, and is unsafe to propagate like every other login', () => {
    expect(FLEET_AUTH_FILES['droid']?.length).toBeGreaterThan(0);
    expect(hasPortableAuthFiles('droid')).toBe(true);
    expect(SINGLE_USE_ROTATING_REFRESH_AGENTS.has('droid')).toBe(true);
    expect(isCredentialSafeToPropagate('droid')).toBe(false);
    expect(isPropagatableAgent('droid')).toBe(false);
  });
});
