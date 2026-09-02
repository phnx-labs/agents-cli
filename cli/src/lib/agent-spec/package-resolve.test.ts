import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentPackageError } from './package-types.js';
import { resolveAgentPackage, effectiveResources } from './package-resolve.js';

const FIXTURE = path.join(import.meta.dirname, 'testdata', 'rabbit-hole');

const tempDirs: string[] = [];
function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pkg-resolve-'));
  tempDirs.push(dir);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveAgentPackage', () => {
  it('resolves every declared resource with hashes and portable provenance', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const byKindName = new Map(resolved.portable.map((r) => [`${r.kind}:${r.name}`, r]));
    expect(byKindName.has('instructions:instructions')).toBe(true);
    expect(byKindName.has('skills:web-research')).toBe(true);
    expect(byKindName.has('subagents:source-finder')).toBe(true);
    expect(byKindName.has('mcp:browser')).toBe(true);
    expect(byKindName.has('hooks:capture')).toBe(true);
    for (const r of resolved.portable) {
      expect(r.provenance).toBe('portable');
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('parses the mcp and hook resource definitions', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const mcp = resolved.portable.find((r) => r.kind === 'mcp')!;
    expect(mcp.mcp).toMatchObject({ name: 'browser', transport: 'stdio', command: 'npx' });
    const hook = resolved.portable.find((r) => r.kind === 'hooks')!;
    expect(hook.hook?.def.events).toEqual(['PostToolUse']);
    expect(fs.existsSync(hook.hook!.scriptPath)).toBe(true);
  });

  it('is deterministic — resolving the same package twice yields the same digest', () => {
    const a = resolveAgentPackage(FIXTURE);
    const b = resolveAgentPackage(FIXTURE);
    expect(a.digest).toBe(b.digest);
  });

  it('records an opencode overlay skill and gives it overlay provenance', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const overlay = resolved.overlays.opencode ?? [];
    expect(overlay).toHaveLength(1);
    expect(overlay[0]).toMatchObject({ kind: 'skills', name: 'web-research', provenance: 'overlay' });
  });

  it('fails closed when a declared skill directory does not exist', () => {
    const dir = copyFixture();
    fs.rmSync(path.join(dir, 'skills', 'web-research'), { recursive: true, force: true });
    expect(() => resolveAgentPackage(dir)).toThrow(AgentPackageError);
    expect(() => resolveAgentPackage(dir)).toThrow(/no such directory/);
  });

  it('fails closed on a path that escapes the package directory', () => {
    const dir = copyFixture();
    const manifestPath = path.join(dir, 'agent.yaml');
    const manifest = fs.readFileSync(manifestPath, 'utf-8').replace('instructions: instructions.md', 'instructions: ../../../etc/passwd');
    fs.writeFileSync(manifestPath, manifest);
    expect(() => resolveAgentPackage(dir)).toThrow(/escapes the package directory/);
  });

  it('fails closed on malformed shared mcp config', () => {
    const dir = copyFixture();
    fs.writeFileSync(path.join(dir, 'mcp', 'browser.yaml'), 'name: browser\ntransport: stdio\n# no command, stdio requires one\n');
    expect(() => resolveAgentPackage(dir)).toThrow(/declares transport 'stdio' but no 'command'/);
  });

  it('fails closed on a duplicate resource name within the same scope', () => {
    const dir = copyFixture();
    // Two distinct mcp files declaring the same server name — a (kind, name) collision.
    fs.writeFileSync(path.join(dir, 'mcp', 'browser-2.yaml'), 'name: browser\ntransport: stdio\ncommand: npx\n');
    const manifestPath = path.join(dir, 'agent.yaml');
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf-8').replace('- mcp/browser.yaml', '- mcp/browser.yaml\n    - mcp/browser-2.yaml'));
    expect(() => resolveAgentPackage(dir)).toThrow(AgentPackageError);
    expect(() => resolveAgentPackage(dir)).toThrow(/duplicate mcp 'browser'/);
  });

  it('fails closed when a hook script is missing', () => {
    const dir = copyFixture();
    fs.rmSync(path.join(dir, 'hooks', 'capture.sh'));
    expect(() => resolveAgentPackage(dir)).toThrow(/hook script/);
  });
});

describe('effectiveResources', () => {
  it('claude and codex get the portable web-research skill; opencode gets the overlay instead', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const claudeSkill = effectiveResources(resolved, 'claude').find((r) => r.kind === 'skills' && r.name === 'web-research')!;
    const opencodeSkill = effectiveResources(resolved, 'opencode').find((r) => r.kind === 'skills' && r.name === 'web-research')!;
    expect(claudeSkill.provenance).toBe('portable');
    expect(opencodeSkill.provenance).toBe('overlay');
    expect(opencodeSkill.sourcePath).not.toBe(claudeSkill.sourcePath);
  });

  it('every non-overridden resource still appears for the overlay harness', () => {
    const resolved = resolveAgentPackage(FIXTURE);
    const names = effectiveResources(resolved, 'opencode').map((r) => `${r.kind}:${r.name}`);
    expect(names).toEqual(['hooks:capture', 'instructions:instructions', 'mcp:browser', 'skills:web-research', 'subagents:source-finder']);
  });
});
