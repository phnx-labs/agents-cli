import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentPackageError } from './package-types.js';
import { loadAgentPackageManifest, parseAgentPackageManifest } from './package-schema.js';

const FIXTURE = path.join(import.meta.dirname, 'testdata', 'rabbit-hole');

const tempDirs: string[] = [];
function tempPackageDir(agentYaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pkg-schema-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'agent.yaml'), agentYaml);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const VALID = `
schema_version: 3
name: Rabbit Hole
slug: rabbit-hole
execution:
  mode: cloud
  harnesses:
    default: claude
    supported: [claude, codex]
  instructions: instructions.md
`;

describe('loadAgentPackageManifest', () => {
  it('parses the rabbit-hole fixture', () => {
    const manifest = loadAgentPackageManifest(FIXTURE);
    expect(manifest.slug).toBe('rabbit-hole');
    expect(manifest.execution.harnesses.supported).toEqual(['claude', 'codex', 'opencode']);
    expect(manifest.execution.skills).toEqual(['skills/web-research']);
    expect(manifest.execution.harnessOverlays.opencode?.skills).toEqual(['harness/opencode/skills/web-research']);
  });

  it('fails closed when agent.yaml is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pkg-schema-'));
    tempDirs.push(dir);
    expect(() => loadAgentPackageManifest(dir)).toThrow(AgentPackageError);
  });

  it('fails closed on malformed YAML', () => {
    const dir = tempPackageDir(VALID);
    fs.writeFileSync(path.join(dir, 'agent.yaml'), 'execution: [this is not: a mapping');
    expect(() => loadAgentPackageManifest(dir)).toThrow(/malformed YAML/);
  });
});

describe('parseAgentPackageManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const manifest = parseAgentPackageManifest(
      { schema_version: 3, name: 'X', slug: 'x', execution: { mode: 'cloud', harnesses: { default: 'claude', supported: ['claude'] }, instructions: 'i.md' } },
      'inline',
    );
    expect(manifest.execution.skills).toEqual([]);
  });

  it('rejects a schema version other than 3', () => {
    expect(() => parseAgentPackageManifest({ schema_version: 2, name: 'X', slug: 'x', execution: {} }, 'inline')).toThrow(/schema_version must be 3/);
  });

  it('rejects http_tools at schema v3', () => {
    expect(() =>
      parseAgentPackageManifest(
        { schema_version: 3, name: 'X', slug: 'x', http_tools: [], execution: { mode: 'cloud', harnesses: { default: 'claude', supported: ['claude'] }, instructions: 'i.md' } },
        'inline',
      ),
    ).toThrow(/http_tools' is forbidden/);
  });

  it('rejects an unknown default harness', () => {
    expect(() =>
      parseAgentPackageManifest(
        { schema_version: 3, name: 'X', slug: 'x', execution: { mode: 'cloud', harnesses: { default: 'not-a-real-agent', supported: ['claude'] }, instructions: 'i.md' } },
        'inline',
      ),
    ).toThrow(/must name a known agent id/);
  });

  it('rejects a default harness absent from supported', () => {
    expect(() =>
      parseAgentPackageManifest(
        { schema_version: 3, name: 'X', slug: 'x', execution: { mode: 'cloud', harnesses: { default: 'codex', supported: ['claude'] }, instructions: 'i.md' } },
        'inline',
      ),
    ).toThrow(/must also appear in execution.harnesses.supported/);
  });

  it('rejects a non-mapping harness overlay', () => {
    expect(() =>
      parseAgentPackageManifest(
        {
          schema_version: 3,
          name: 'X',
          slug: 'x',
          execution: {
            mode: 'cloud',
            harnesses: { default: 'claude', supported: ['claude', 'codex'] },
            instructions: 'i.md',
            harness_overlays: { codex: 'not-a-mapping' },
          },
        },
        'inline',
      ),
    ).toThrow(/must be a mapping/);
  });
});
