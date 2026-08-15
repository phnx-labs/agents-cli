import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { PERMISSION_TARGETS, readCanonicalPermissions } from './permissions-registry.js';
import { capableAgents } from './capabilities.js';
import { applyPermissionsToVersion, exportPermissionsFromPath } from './permissions.js';
import type { AgentId, PermissionSet } from './types.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-perm-registry-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('PERMISSION_TARGETS completeness', () => {
  // The bug this pins: applyPermissionsToVersion wrote 13 harnesses while the
  // read/export path answered for 3, so `agents permissions list cursor` (and
  // nine others) reported "none" for permissions agents-cli had just written.
  it('has exactly one entry per allowlist-capable agent', () => {
    const capable = [...capableAgents('allowlist')].sort();
    const registered = (Object.keys(PERMISSION_TARGETS) as AgentId[]).sort();
    expect(registered).toEqual(capable);
  });

  it('states what each harness loses on the way back', () => {
    for (const [agent, target] of Object.entries(PERMISSION_TARGETS)) {
      expect(target!.lossyBecause, `${agent} has no lossyBecause`).toBeTruthy();
    }
  });

  it('resolves a distinct config path per harness', () => {
    const seen = new Map<string, string>();
    for (const [agent, target] of Object.entries(PERMISSION_TARGETS)) {
      const p = target!.home('/h');
      expect(seen.has(p), `${agent} collides with ${seen.get(p)} at ${p}`).toBe(false);
      seen.set(p, agent);
    }
  });

  it('returns null for a harness with no permissions written', () => {
    const home = makeTempHome();
    for (const agent of capableAgents('allowlist')) {
      expect(readCanonicalPermissions(agent, 'user', undefined, home), agent).toBeNull();
    }
  });
});

/**
 * The real round trip: write a canonical set into a version home with the SAME
 * function `agents sync` uses, then read it back through the registry. Every
 * harness must report the permissions it was just given — that is exactly what
 * RUSH-2676 says was broken for ten of them. No mocking; real files on disk.
 */
describe('write then read back, per harness', () => {
  const set: PermissionSet = {
    name: 'test',
    allow: ['Bash(git status:*)', 'Read(**)'],
    deny: ['Bash(rm:*)'],
  };

  for (const agent of capableAgents('allowlist')) {
    it(`${agent}: permissions written are read back`, () => {
      const home = makeTempHome();
      const result = applyPermissionsToVersion(agent, set, home, false, process.cwd());
      expect(result.success, `${agent} write failed: ${result.error}`).toBe(true);

      const readBack = readCanonicalPermissions(agent, 'user', undefined, home);
      expect(readBack, `${agent} wrote permissions that read back as absent`).not.toBeNull();
      expect(readBack!.allow.length + (readBack!.deny?.length ?? 0)).toBeGreaterThan(0);
    });
  }
});

describe('round trip preserves the Bash rules a harness can express', () => {
  // Harnesses whose native grammar carries a per-command Bash pattern must round
  // trip `Bash(git status:*)` back to the same canonical rule — the `:*` <-> ` *`
  // translation is the part most likely to rot.
  const set: PermissionSet = { name: 'test', allow: ['Bash(git status:*)'], deny: ['Bash(rm:*)'] };

  for (const agent of ['claude', 'grok', 'droid', 'hermes', 'kimi', 'kiro', 'antigravity'] as AgentId[]) {
    it(`${agent} keeps Bash(git status:*) and Bash(rm:*)`, () => {
      const home = makeTempHome();
      expect(applyPermissionsToVersion(agent, set, home, false, process.cwd()).success).toBe(true);
      const back = readCanonicalPermissions(agent, 'user', undefined, home);
      expect(back).not.toBeNull();
      // Claude records canonical Write as Edit; Bash rules are untouched by that.
      expect(back!.allow).toContain('Bash(git status:*)');
      expect(back!.deny ?? []).toContain('Bash(rm:*)');
    });
  }
});

describe('exportPermissionsFromPath detects every harness by its own path', () => {
  // It used to auto-detect only `.claude` / `.opencode` / `.codex` fragments, so
  // pointing it at a written cursor/kiro/goose config returned null.
  for (const agent of capableAgents('allowlist')) {
    it(`detects ${agent} from the file the writer produced`, () => {
      const home = makeTempHome();
      const set: PermissionSet = { name: 'test', allow: ['Bash(git status:*)', 'Read(**)'] };
      expect(applyPermissionsToVersion(agent, set, home, false, process.cwd()).success).toBe(true);

      const configPath = PERMISSION_TARGETS[agent]!.home(home);
      expect(fs.existsSync(configPath), `${agent} wrote nothing at ${configPath}`).toBe(true);
      expect(exportPermissionsFromPath(configPath), agent).not.toBeNull();
    });
  }

  it('returns null for a path no harness owns', () => {
    const home = makeTempHome();
    const stray = path.join(home, 'not-a-harness.json');
    fs.writeFileSync(stray, '{"permissions":{"allow":["Bash(*)"]}}', 'utf-8');
    expect(exportPermissionsFromPath(stray)).toBeNull();
  });

  it('prefers the most specific path when two suffixes could match', () => {
    // `.kiro/settings/permissions.yaml` must not be claimed by a shorter suffix.
    const home = makeTempHome();
    const set: PermissionSet = { name: 'test', allow: ['Bash(git status:*)'] };
    expect(applyPermissionsToVersion('kiro', set, home, false, process.cwd()).success).toBe(true);
    const kiroPath = PERMISSION_TARGETS.kiro!.home(home);
    const back = exportPermissionsFromPath(kiroPath);
    expect(back).not.toBeNull();
    expect(back!.allow).toContain('Bash(git status:*)');
  });
});
