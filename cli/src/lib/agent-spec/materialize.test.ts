import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentId } from '../types.js';
import { AgentPackageError } from './package-types.js';
import { resolveAgentPackage } from './package-resolve.js';
import { materializeAgentPackage } from './materialize.js';

const FIXTURE = path.join(import.meta.dirname, 'testdata', 'rabbit-hole');

const tempDirs: string[] = [];
function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pkg-materialize-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const HARNESS_VERSIONS: Record<string, string> = { claude: '2.1.0', codex: '0.150.0', opencode: '1.2.0' };

describe('materializeAgentPackage — native layouts', () => {
  for (const harness of ['claude', 'codex', 'opencode'] as AgentId[]) {
    it(`materializes the rabbit-hole fixture into a native ${harness} home`, () => {
      const resolved = resolveAgentPackage(FIXTURE);
      const outputHome = tempHome();
      const receipt = materializeAgentPackage(resolved, { harness, harnessVersion: HARNESS_VERSIONS[harness], outputHome });

      expect(receipt.harness).toEqual({ id: harness, version: HARNESS_VERSIONS[harness] });
      expect(receipt.agent.digest).toBe(`sha256:${resolved.digest}`);
      const kinds = receipt.resources.map((r) => r.kind).sort();
      expect(kinds).toEqual(['hooks', 'instructions', 'mcp', 'skills', 'subagents']);

      // Every listed target genuinely exists on disk under the output home.
      for (const entry of receipt.resources) {
        expect(fs.existsSync(path.join(outputHome, entry.target)), `${entry.kind}:${entry.name} -> ${entry.target}`).toBe(true);
      }
    });
  }

  it('opencode gets the overlay skill content, claude gets the portable one', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const claudeHome = tempHome();
    const opencodeHome = tempHome();
    const claudeReceipt = materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome: claudeHome });
    const opencodeReceipt = materializeAgentPackage(resolved, { harness: 'opencode', harnessVersion: '1.2.0', outputHome: opencodeHome });

    const claudeSkillEntry = claudeReceipt.resources.find((r) => r.kind === 'skills')!;
    const opencodeSkillEntry = opencodeReceipt.resources.find((r) => r.kind === 'skills')!;
    expect(claudeSkillEntry.provenance).toBe('portable');
    expect(opencodeSkillEntry.provenance).toBe('overlay');
    expect(claudeSkillEntry.sha256).not.toBe(opencodeSkillEntry.sha256);

    const claudeSkillContent = fs.readFileSync(path.join(claudeHome, claudeSkillEntry.target, 'SKILL.md'), 'utf-8');
    const opencodeSkillContent = fs.readFileSync(path.join(opencodeHome, opencodeSkillEntry.target, 'SKILL.md'), 'utf-8');
    expect(claudeSkillContent).toContain('Search broadly');
    expect(opencodeSkillContent).toContain('native `webfetch` tool');
  });

  it('materializes the mcp server into claude\'s .mcp.json with the declared command', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const outputHome = tempHome();
    const receipt = materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
    const mcpEntry = receipt.resources.find((r) => r.kind === 'mcp')!;
    const config = JSON.parse(fs.readFileSync(path.join(outputHome, mcpEntry.target), 'utf-8'));
    expect(config.mcpServers.browser.command).toBe('npx');
  });

  it('registers the hook script under the harness hooks dir, executable', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const outputHome = tempHome();
    const receipt = materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
    const hookEntry = receipt.resources.find((r) => r.kind === 'hooks')!;
    const scriptPath = path.join(outputHome, hookEntry.target);
    expect(fs.statSync(scriptPath).mode & 0o111).not.toBe(0);
    const settings = JSON.parse(fs.readFileSync(path.join(outputHome, '.claude', 'settings.json'), 'utf-8'));
    expect(JSON.stringify(settings)).toContain('PostToolUse');
  });
});

describe('materializeAgentPackage — determinism', () => {
  it('produces a byte-identical receipt on a second run against the same output home', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const outputHome = tempHome();
    materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
    const firstReceiptBytes = fs.readFileSync(path.join(outputHome, 'materialization-receipt.json'));
    materializeAgentPackage(resolved, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
    const secondReceiptBytes = fs.readFileSync(path.join(outputHome, 'materialization-receipt.json'));
    expect(secondReceiptBytes.equals(firstReceiptBytes)).toBe(true);
  });

  it('produces the same digest from a freshly-resolved package on every run', () => {
    const a = resolveAgentPackage(FIXTURE);
    const outputHomeA = tempHome();
    const receiptA = materializeAgentPackage(a, { harness: 'codex', harnessVersion: '0.150.0', outputHome: outputHomeA });

    const b = resolveAgentPackage(FIXTURE);
    const outputHomeB = tempHome();
    const receiptB = materializeAgentPackage(b, { harness: 'codex', harnessVersion: '0.150.0', outputHome: outputHomeB });

    expect(receiptA.agent.digest).toBe(receiptB.agent.digest);
    expect(receiptA.resources).toEqual(receiptB.resources);
  });
});

describe('materializeAgentPackage — stale pruning', () => {
  it('removes a previously-materialized skill that is no longer declared, without touching unmanaged files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pkg-prune-'));
    tempDirs.push(dir);
    fs.cpSync(FIXTURE, dir, { recursive: true });

    const outputHome = tempHome();
    const resolvedBefore = resolveAgentPackage(dir);
    const receiptBefore = materializeAgentPackage(resolvedBefore, { harness: 'claude', harnessVersion: '2.1.0', outputHome });
    const skillEntry = receiptBefore.resources.find((r) => r.kind === 'skills')!;
    const skillDirOnDisk = path.join(outputHome, skillEntry.target);
    expect(fs.existsSync(skillDirOnDisk)).toBe(true);

    // Plant an unmanaged file the materializer must never touch.
    const unmanagedFile = path.join(outputHome, '.claude', 'unmanaged-note.txt');
    fs.mkdirSync(path.dirname(unmanagedFile), { recursive: true });
    fs.writeFileSync(unmanagedFile, 'do not delete me');

    // Remove the skill from the package and re-materialize into the SAME home.
    const manifestPath = path.join(dir, 'agent.yaml');
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf-8').replace('  skills:\n    - skills/web-research\n', ''));

    const resolvedAfter = resolveAgentPackage(dir);
    const receiptAfter = materializeAgentPackage(resolvedAfter, { harness: 'claude', harnessVersion: '2.1.0', outputHome });

    expect(receiptAfter.resources.some((r) => r.kind === 'skills')).toBe(false);
    expect(fs.existsSync(skillDirOnDisk)).toBe(false);
    expect(fs.existsSync(unmanagedFile)).toBe(true);
    expect(fs.readFileSync(unmanagedFile, 'utf-8')).toBe('do not delete me');
  });
});

describe('materializeAgentPackage — fails closed', () => {
  it('refuses a harness the package does not declare supported', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    expect(() =>
      materializeAgentPackage(resolved, { harness: 'grok', harnessVersion: '1.0.0', outputHome: tempHome() }),
    ).toThrow(/does not declare 'grok' as a supported harness/);
  });

  it('blocks dispatch when the requested harness version lacks a declared capability', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    // Codex hooks require >= 0.116.0 — an older version must fail loud, not silently skip hooks.
    expect(() =>
      materializeAgentPackage(resolved, { harness: 'codex', harnessVersion: '0.100.0', outputHome: tempHome() }),
    ).toThrow(AgentPackageError);
    try {
      materializeAgentPackage(resolved, { harness: 'codex', harnessVersion: '0.100.0', outputHome: tempHome() });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AgentPackageError);
      expect((err as AgentPackageError).code).toBe('unsupported-capability');
      expect((err as AgentPackageError).details?.join(' ')).toMatch(/hooks 'capture'/);
    }
  });

  it('writes nothing when capability validation fails', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const outputHome = tempHome();
    expect(() =>
      materializeAgentPackage(resolved, { harness: 'codex', harnessVersion: '0.100.0', outputHome }),
    ).toThrow();
    expect(fs.existsSync(path.join(outputHome, 'materialization-receipt.json'))).toBe(false);
  });
});
