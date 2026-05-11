import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let testHome: string;
let systemDir: string;
let userDir: string;
let projectDir: string;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-diff-test-'));
  systemDir = path.join(testHome, '.agents-system');
  userDir = path.join(testHome, '.agents');
  projectDir = path.join(testHome, 'work');
  fs.mkdirSync(systemDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  // Avoid the migrator running and failing on a missing legacy state.
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

interface RunReport {
  agent: string;
  version: string;
  cwd: string;
  layers: { project: string | null; user: string; system: string; extras: unknown[] };
  kinds: Record<string, Array<{ name: string; status: string; source?: string }>>;
  summary: { ok: number; diff: number; missing: number; extra: number };
}

function runDiff(cwd: string, agent: string, version: string, kinds?: string[]): RunReport {
  const modulePath = path.resolve(process.cwd(), 'src/lib/doctor-diff.ts');
  const script = `
    import { diffVersionResources } from ${JSON.stringify(modulePath)};
    const r = diffVersionResources(${JSON.stringify(agent)}, ${JSON.stringify(version)}, {
      cwd: ${JSON.stringify(cwd)},
      kinds: ${kinds ? JSON.stringify(kinds) : 'undefined'},
    });
    console.log(JSON.stringify(r));
  `;
  const out = execFileSync('bun', ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: testHome },
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString('utf-8');
  return JSON.parse(out);
}

function makeVersionHome(agent: string, version: string): string {
  const home = path.join(userDir, '.history', 'versions', agent, version, 'home');
  const configDir = path.join(home, `.${agent}`);
  fs.mkdirSync(path.join(configDir, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(configDir, 'hooks'), { recursive: true });
  return home;
}

describe('diffVersionResources — commands', () => {
  it('reports ok / diff / missing / extra against the resolved source', () => {
    const home = makeVersionHome('claude', '2.0.0');
    const cmdsHome = path.join(home, '.claude', 'commands');

    fs.mkdirSync(path.join(userDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'commands', 'recap.md'), 'recap body\n');
    fs.writeFileSync(path.join(userDir, 'commands', 'plan.md'), 'plan body\n');
    fs.writeFileSync(path.join(userDir, 'commands', 'design.md'), 'fresh design\n');

    fs.writeFileSync(path.join(cmdsHome, 'recap.md'), 'recap body\n'); // ok
    fs.writeFileSync(path.join(cmdsHome, 'design.md'), 'stale design\n'); // diff
    fs.writeFileSync(path.join(cmdsHome, 'orphan.md'), 'no source\n'); // extra
    // plan.md missing in home

    const report = runDiff(projectDir, 'claude', '2.0.0', ['commands']);
    const byName = Object.fromEntries(report.kinds.commands.map((r) => [r.name, r]));

    expect(byName.recap).toMatchObject({ status: 'ok', source: 'user' });
    expect(byName.design).toMatchObject({ status: 'diff', source: 'user' });
    expect(byName.plan).toMatchObject({ status: 'missing', source: 'user' });
    expect(byName.orphan).toMatchObject({ status: 'extra' });
    expect(byName.orphan.source).toBeUndefined();
  });

  it('project-layer source overrides user-layer for the same name', () => {
    const home = makeVersionHome('claude', '2.0.0');
    const cmdsHome = path.join(home, '.claude', 'commands');

    fs.mkdirSync(path.join(userDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'commands', 'recap.md'), 'user body\n');
    fs.mkdirSync(path.join(projectDir, '.agents', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.agents', 'commands', 'recap.md'), 'project body\n');
    fs.writeFileSync(path.join(cmdsHome, 'recap.md'), 'project body\n');

    const report = runDiff(projectDir, 'claude', '2.0.0', ['commands']);
    const recap = report.kinds.commands.find((r) => r.name === 'recap');
    expect(recap).toMatchObject({ status: 'ok', source: 'project' });
  });
});

describe('diffVersionResources — hooks ignore project layer', () => {
  it('does not consider project/.agents/hooks as a source (mirrors sync)', () => {
    const home = makeVersionHome('claude', '2.0.0');
    fs.mkdirSync(path.join(projectDir, '.agents', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.agents', 'hooks', 'evil.sh'), '#!/bin/sh\necho boom\n');

    const report = runDiff(projectDir, 'claude', '2.0.0', ['hooks']);
    // 'evil' should not appear as a missing-source from the project layer.
    const evil = report.kinds.hooks.find((r) => r.name === 'evil');
    expect(evil).toBeUndefined();
  });
});

describe('diffVersionResources — rules', () => {
  it('compares AGENTS.md byte-for-byte for import-capable agents (claude)', () => {
    const home = makeVersionHome('claude', '2.0.0');
    const configDir = path.join(home, '.claude');
    fs.mkdirSync(path.join(userDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'rules', 'AGENTS.md'), 'rules body\n');
    fs.writeFileSync(path.join(configDir, 'CLAUDE.md'), 'rules body\n');

    const report = runDiff(projectDir, 'claude', '2.0.0', ['rules']);
    const agents = report.kinds.rules.find((r) => r.name === 'AGENTS');
    expect(agents).toMatchObject({ status: 'ok', source: 'user' });
  });

  it('compares AGENTS.md against compiled (header-prefixed) content for non-import agents (codex)', () => {
    const home = makeVersionHome('codex', '0.100.0');
    const configDir = path.join(home, '.codex');
    fs.mkdirSync(path.join(userDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'rules', 'AGENTS.md'), 'plain rules\n');

    // A raw byte copy of the source would be wrong — codex needs the compiled
    // header. Simulate the bad state to confirm doctor flags it as DIFF.
    fs.writeFileSync(path.join(configDir, 'AGENTS.md'), 'plain rules\n');

    const report = runDiff(projectDir, 'codex', '0.100.0', ['rules']);
    const agents = report.kinds.rules.find((r) => r.name === 'AGENTS');
    expect(agents?.status).toBe('diff');

    // With the compiled header in place, status flips to ok.
    const COMPILED_HEADER =
      '<!-- Auto-compiled by agents-cli from ~/.agents/rules/AGENTS.md + imports.\n' +
      '     Edit the source files under ~/.agents/rules/ — edits to this file will be overwritten on next sync. -->\n\n';
    fs.writeFileSync(path.join(configDir, 'AGENTS.md'), COMPILED_HEADER + 'plain rules\n');
    const report2 = runDiff(projectDir, 'codex', '0.100.0', ['rules']);
    const agents2 = report2.kinds.rules.find((r) => r.name === 'AGENTS');
    expect(agents2?.status).toBe('ok');
  });
});
