import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCommandSkillContent, commandSkillName } from '../command-skills.js';

let testHome: string;
let systemDir: string;
let userDir: string;
let projectDir: string;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-diff-test-'));
  userDir = path.join(testHome, '.agents');
  systemDir = path.join(userDir, '.system');
  projectDir = path.join(testHome, 'work');
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(systemDir, { recursive: true });
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

describe('diffVersionResources — command-as-skill agents', () => {
  // Kimi (and Codex >= 0.117, Grok) install commands as SKILL wrappers, not
  // native command files. The diff must compare against the wrapper or it
  // false-reports every command as drifted forever.
  function installKimiCommandSkill(version: string, name: string, srcPath: string): void {
    const agentDir = path.join(userDir, '.history', 'versions', 'kimi', version, 'home', '.kimi-code');
    const skillDir = path.join(agentDir, 'skills', commandSkillName(name));
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), buildCommandSkillContent(name, srcPath));
  }

  it('reports ok when the installed command-skill matches source (not a false diff)', () => {
    const srcCmds = path.join(userDir, 'commands');
    fs.mkdirSync(srcCmds, { recursive: true });
    const srcPath = path.join(srcCmds, 'foo.md');
    fs.writeFileSync(srcPath, '# Foo\nrun foo\n');
    installKimiCommandSkill('0.19.0', 'foo', srcPath);

    const report = runDiff(projectDir, 'kimi', '0.19.0', ['commands']);
    expect(report.kinds.commands.find((c) => c.name === 'foo')?.status).toBe('ok');
  });

  it('reports diff when the source changes after the command-skill was installed', () => {
    const srcCmds = path.join(userDir, 'commands');
    fs.mkdirSync(srcCmds, { recursive: true });
    const srcPath = path.join(srcCmds, 'foo.md');
    fs.writeFileSync(srcPath, '# Foo\nrun foo\n');
    installKimiCommandSkill('0.19.0', 'foo', srcPath);
    // Source changed after install — the wrapper no longer matches.
    fs.writeFileSync(srcPath, '# Foo v2\nrun foo differently\n');

    const report = runDiff(projectDir, 'kimi', '0.19.0', ['commands']);
    expect(report.kinds.commands.find((c) => c.name === 'foo')?.status).toBe('diff');
  });

  it('reports a source command as missing for goose (now a recipe-backed command agent)', () => {
    // Goose gained commands support (RUSH-1572): a slash command is a recipe YAML
    // registered in config.yaml. With commands:true a source command that is not
    // yet installed reports as missing (previously goose held commands neither
    // natively nor as skills, so nothing was reported).
    fs.mkdirSync(path.join(userDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'commands', 'foo.md'), '# Foo\n');
    fs.mkdirSync(path.join(userDir, '.history', 'versions', 'goose', '1.0.0', 'home'), { recursive: true });

    const report = runDiff(projectDir, 'goose', '1.0.0', ['commands']);
    expect(report.kinds.commands.find((c) => c.name === 'foo')?.status).toBe('missing');
  });
});
