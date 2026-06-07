import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-versions-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runVersionSync(home: string, expression: string): unknown {
  // tsx (Node) — not bun. The CLI ships against Node, and `versions.ts`
  // transitively imports the SQLite layer that this test exercises.
  const moduleUrl = pathToFileURL(path.resolve('src/lib/versions.ts')).href;
  const tsxBin = path.resolve('node_modules/.bin/tsx');
  const child = spawnSync(tsxBin, ['-e', `
    import { syncResourcesToVersion } from ${JSON.stringify(moduleUrl)};
    const home = ${JSON.stringify(home)};
    const result = ${expression};
    console.log(JSON.stringify(result));
  `], {
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });

  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

describe('version resource sync path handling', () => {
  it('intersects explicit resource selections with discovered resources before syncing', async () => {
    const home = makeTempHome();

    fs.mkdirSync(path.join(home, '.agents-system', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents-system', 'commands', 'safe.md'), 'safe command', 'utf-8');

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('codex', '0.1.0', { commands: ['../escape', 'safe'] }, { cwd: home })"
    ) as { commands: boolean };

    expect(result.commands).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents', '.history', 'versions', 'codex', '0.1.0', 'home', '.codex', 'prompts', 'safe.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents', '.history', 'versions', 'codex', '0.1.0', 'home', '.codex', 'escape.md'))).toBe(false);
  });

  it('keeps prompts for Codex 0.116.x and converts commands to generated skills for Codex 0.117.0+', async () => {
    const home = makeTempHome();

    fs.mkdirSync(path.join(home, '.agents-system', 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.agents-system', 'commands', 'recap.md'),
      ['---', 'description: Summarize the current session', '---', '', 'Recap the conversation so far.'].join('\n'),
      'utf-8'
    );

    const legacyResult = runVersionSync(
      home,
      "syncResourcesToVersion('codex', '0.116.0', { commands: ['recap'] }, { cwd: home })"
    ) as { commands: boolean };
    const legacyVersionHome = path.join(home, '.agents', '.history', 'versions', 'codex', '0.116.0', 'home', '.codex');

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('codex', '0.117.0', { commands: ['recap'] }, { cwd: home })"
    ) as { commands: boolean };

    const versionHome = path.join(home, '.agents', '.history', 'versions', 'codex', '0.117.0', 'home', '.codex');
    const skillPath = path.join(versionHome, 'skills', 'recap', 'SKILL.md');
    const skill = fs.readFileSync(skillPath, 'utf-8');

    expect(legacyResult.commands).toBe(true);
    expect(fs.existsSync(path.join(legacyVersionHome, 'prompts', 'recap.md'))).toBe(true);
    expect(fs.existsSync(path.join(legacyVersionHome, 'skills', 'recap', 'SKILL.md'))).toBe(false);
    expect(result.commands).toBe(true);
    expect(fs.existsSync(path.join(versionHome, 'prompts', 'recap.md'))).toBe(false);
    expect(skill).toContain('name: "recap"');
    expect(skill).toContain('agents_command: "recap"');
    expect(skill).toContain('When invoked with `$recap`');
    expect(skill).toContain('Recap the conversation so far.');
  });

  it('does not follow symlinks inside copied skill resources', async () => {
    const home = makeTempHome();

    const skillDir = path.join(home, '.agents-system', 'skills', 'leaky');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'skill body', 'utf-8');
    const secretPath = path.join(home, 'secret.txt');
    fs.writeFileSync(secretPath, 'secret', 'utf-8');
    fs.symlinkSync(secretPath, path.join(skillDir, 'secret-link'));

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('codex', '0.1.0', { skills: ['leaky'] }, { cwd: home })"
    ) as { skills: boolean };

    const syncedSkillDir = path.join(home, '.agents', '.history', 'versions', 'codex', '0.1.0', 'home', '.codex', 'skills', 'leaky');
    expect(result.skills).toBe(true);
    expect(fs.existsSync(path.join(syncedSkillDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(syncedSkillDir, 'secret-link'))).toBe(false);
  });

  it('skips a clean full sync after expanding persisted resource patterns', async () => {
    const home = makeTempHome();

    const skillDir = path.join(home, '.agents-system', 'skills', 'tiny');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'skill body', 'utf-8');

    const first = runVersionSync(
      home,
      "syncResourcesToVersion('codex', '0.1.0', undefined, { cwd: home })"
    ) as { skills: boolean };

    const second = runVersionSync(
      home,
      "syncResourcesToVersion('codex', '0.1.0', undefined, { cwd: home })"
    ) as { skills: boolean };

    expect(first.skills).toBe(true);
    expect(second.skills).toBe(false);
  });

  it('does not sync project MCP servers under the default user-only MCP policy', async () => {
    const home = makeTempHome();
    const project = path.join(home, 'repo');

    fs.mkdirSync(path.join(project, '.agents', 'mcp'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', 'mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.agents', 'mcp', 'evil.yaml'),
      'name: evil\ntransport: stdio\ncommand: echo\nargs:\n  - evil\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(home, '.agents', 'mcp', 'safe.yaml'),
      'name: safe\ntransport: stdio\ncommand: echo\nargs:\n  - safe\n',
      'utf-8'
    );

    const result = runVersionSync(
      home,
      `syncResourcesToVersion('gemini', '0.1.0', undefined, { cwd: ${JSON.stringify(project)} })`
    ) as { mcp: string[] };

    const settingsPath = path.join(home, '.agents', '.history', 'versions', 'gemini', '0.1.0', 'home', '.gemini', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { mcpServers?: Record<string, unknown> };

    expect(result.mcp).toEqual(['safe']);
    expect(settings.mcpServers?.safe).toBeDefined();
    expect(settings.mcpServers?.evil).toBeUndefined();
  });
});
