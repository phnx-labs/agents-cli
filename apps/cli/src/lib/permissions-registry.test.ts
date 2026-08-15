import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { PERMISSION_TARGETS, readCanonicalPermissions } from './permissions-registry.js';
import { capableAgents } from './capabilities.js';
import { applyPermissionsToVersion, detectPermissionAgentFromPath, exportPermissionsFromPath } from './permissions.js';
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
  // pointing it at a written cursor/kiro/hermes config returned null.
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

describe('allow and deny never cross on the way back', () => {
  // The reverse readers rebuild allow/deny from formats that encode polarity
  // very differently — Grok's `action`, Kimi's `decision`, Kiro's `effect`,
  // Hermes' approvals.deny, OpenClaw's alsoAllow/deny. A polarity slip in any of
  // them silently turns a deny into a grant, which is the worst failure this
  // registry could have.

  /**
   * Harnesses whose read path returns nothing for a SUB-COMMAND deny like
   * `Bash(rm:*)`, verified by driving the real writer and reading what it
   * produced. Two distinct reasons — do not conflate them:
   *
   *   openclaw  — CANNOT express it. Tool-level only, so a sub-command rule is
   *               skipped by the serializer (convertToOpenClawFormat).
   *   copilot   — CANNOT express it. Its config records approvals (grants) and
   *               has no deny list at all.
   *   codex     — CAN and DOES express it: the writer emits
   *               `.codex/rules/agents-deny.rules` with
   *               `prefix_rule(pattern=["rm"], decision="forbidden")`. The
   *               READER just never opens that file, hardcoding an empty deny.
   *               That is a fixable read-side gap (RUSH-2703), not a limit of
   *               the format.
   *
   * All three read back `null` today, so asserting non-null would assert a lie.
   */
  const DENY_NOT_READ_BACK = new Set(['codex', 'openclaw', 'copilot']);

  for (const agent of capableAgents('allowlist')) {
    it(`${agent}: an allow-only set never reads back a deny`, () => {
      const home = makeTempHome();
      const set: PermissionSet = { name: 'test', allow: ['Bash(git status:*)', 'Read(**)'] };
      expect(applyPermissionsToVersion(agent, set, home, false, process.cwd()).success).toBe(true);
      const back = readCanonicalPermissions(agent, 'user', undefined, home);
      // not.toBeNull() first — `?.deny ?? []` also passes when the read path
      // returns null, which would make this assert nothing at all. Every
      // harness can express an allow, so absence here is a real failure.
      expect(back, `${agent} wrote an allow-only set that reads back as absent`).not.toBeNull();
      expect(back!.deny ?? []).toEqual([]);
    });

    it(`${agent}: a deny-only set never reads back an allow`, () => {
      const home = makeTempHome();
      const set: PermissionSet = { name: 'test', allow: [], deny: ['Bash(rm:*)'] };
      expect(applyPermissionsToVersion(agent, set, home, false, process.cwd()).success).toBe(true);
      const back = readCanonicalPermissions(agent, 'user', undefined, home);

      if (DENY_NOT_READ_BACK.has(agent)) {
        // Nothing read back is the honest outcome for these three — but it
        // must be NOTHING, not a grant invented out of a deny.
        expect(back?.allow ?? []).toEqual([]);
        return;
      }

      expect(back, `${agent} wrote a deny-only set that reads back as absent`).not.toBeNull();
      expect(back!.allow ?? []).toEqual([]);
      expect(back!.deny ?? []).not.toEqual([]);
    });
  }
});

describe('harness detection does not depend on the working directory', () => {
  // The bug: detection built its match suffixes from `target.home('')`, and
  // OpenCode's resolvers probe the filesystem to choose between the two
  // spellings it accepts. With an empty root that probe resolved against
  // `process.cwd()`, so the SAME file detected differently depending on where
  // the CLI ran. A cwd holding decoy opencode configs reproduces it; a cwd
  // without them does not, which is why one-cwd coverage passed on main.
  function withCwd<T>(dir: string, fn: () => T): T {
    const before = process.cwd();
    process.chdir(dir);
    try {
      return fn();
    } finally {
      process.chdir(before);
    }
  }

  // Table-wide pin: whatever a target's own resolver answers for a real root,
  // detecting that path must not depend on the working directory. Catches a
  // future target whose resolver probes the filesystem without declaring its
  // spellings in `altSuffixes` — the exact shape of this bug.
  it('resolves every harness the same way from any cwd', () => {
    // Seed ONLY the non-preferred spelling. A probing resolver rooted at ''
    // then answers `.json` while the candidate under test is `.jsonc`, which is
    // what makes the mismatch observable. Seeding both would let the probe find
    // the right suffix by luck and the test would pass against the bug.
    const decoy = makeTempHome();
    fs.mkdirSync(path.join(decoy, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(decoy, 'opencode.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(decoy, '.config', 'opencode', 'opencode.json'), '{}', 'utf-8');
    const bare = makeTempHome();

    for (const agent of capableAgents('allowlist')) {
      const root = path.join(makeTempHome(), 'root');
      const candidate = PERMISSION_TARGETS[agent]!.home(root);
      const fromDecoy = withCwd(decoy, () => detectPermissionAgentFromPath(candidate));
      const fromBare = withCwd(bare, () => detectPermissionAgentFromPath(candidate));
      expect(fromDecoy, `${agent}: ${candidate} undetected`).toBe(agent);
      expect(fromBare, `${agent}: detection differs by cwd`).toBe(fromDecoy);
    }
  });

  for (const spelling of ['opencode.jsonc', 'opencode.json']) {
    it(`detects ${spelling} identically from a decoy cwd and a bare one`, () => {
      const home = makeTempHome();
      const configDir = path.join(home, '.config', 'opencode');
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, spelling);
      fs.writeFileSync(configPath, '{"permission":{"bash":{"git *":"allow"}}}', 'utf-8');

      // The decoy cwd must carry ONLY the spelling the file under test is NOT,
      // so an fs probe rooted at '' resolves to the WRONG suffix. Seeding both
      // spellings would let the probe find the right one by luck and the test
      // would pass against the bug.
      const other = spelling === 'opencode.jsonc' ? 'opencode.json' : 'opencode.jsonc';
      const decoy = makeTempHome();
      fs.mkdirSync(path.join(decoy, '.config', 'opencode'), { recursive: true });
      fs.writeFileSync(path.join(decoy, other), '{}', 'utf-8');
      fs.writeFileSync(path.join(decoy, '.config', 'opencode', other), '{}', 'utf-8');
      const bare = makeTempHome();

      const fromDecoy = withCwd(decoy, () => exportPermissionsFromPath(configPath));
      const fromBare = withCwd(bare, () => exportPermissionsFromPath(configPath));

      expect(fromDecoy, `${spelling} undetected from a decoy cwd`).not.toBeNull();
      expect(fromBare, `${spelling} undetected from a bare cwd`).not.toBeNull();
      expect(fromDecoy).toEqual(fromBare);
      expect(fromDecoy!.allow).toContain('Bash(git *)');
    });
  }
});

