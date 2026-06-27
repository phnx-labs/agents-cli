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
    import { listInstalledVersions, syncResourcesToVersion } from ${JSON.stringify(moduleUrl)};
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

function runReconcile(home: string, agent: string, installedVersion: string): string {
  // tsx (Node) subprocess with an isolated HOME — exercises the real fs +
  // session-db path that reconcileStaleLatestDir touches, no mocking.
  const moduleUrl = pathToFileURL(path.resolve('src/lib/versions.ts')).href;
  const tsxBin = path.resolve('node_modules/.bin/tsx');
  const child = spawnSync(tsxBin, ['-e', `
    import { reconcileStaleLatestDir } from ${JSON.stringify(moduleUrl)};
    (async () => {
      const result = await reconcileStaleLatestDir(${JSON.stringify(agent)}, ${JSON.stringify(installedVersion)});
      console.log(JSON.stringify(result));
    })();
  `], {
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

function droidVersionDir(home: string, version: string): string {
  return path.join(home, '.agents', '.history', 'versions', 'droid', version);
}

describe('reconcileStaleLatestDir', () => {
  it('renames a stale literal `latest` dir onto the resolved version, preserving home/', () => {
    const home = makeTempHome();
    const latestHome = path.join(droidVersionDir(home, 'latest'), 'home');
    fs.mkdirSync(latestHome, { recursive: true });
    fs.writeFileSync(path.join(latestHome, 'marker.txt'), 'keep me', 'utf-8');

    const action = runReconcile(home, 'droid', '0.158.0');

    expect(action).toBe('renamed');
    expect(fs.existsSync(droidVersionDir(home, 'latest'))).toBe(false);
    expect(fs.readFileSync(path.join(droidVersionDir(home, '0.158.0'), 'home', 'marker.txt'), 'utf-8')).toBe('keep me');
  });

  it('trashes the stale `latest` dir when the resolved version dir already exists', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(droidVersionDir(home, 'latest'), 'home'), { recursive: true });
    fs.mkdirSync(path.join(droidVersionDir(home, '0.158.0'), 'home'), { recursive: true });

    const action = runReconcile(home, 'droid', '0.158.0');

    expect(action).toBe('trashed');
    expect(fs.existsSync(droidVersionDir(home, 'latest'))).toBe(false);
    expect(fs.existsSync(droidVersionDir(home, '0.158.0'))).toBe(true);
    // Soft-deleted, not hard-deleted — recoverable from trash.
    const trashDir = path.join(home, '.agents', '.history', 'trash', 'versions', 'droid', 'latest');
    expect(fs.existsSync(trashDir)).toBe(true);
  });

  it('is a no-op when no stale `latest` dir exists', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(droidVersionDir(home, '0.158.0'), 'home'), { recursive: true });

    const action = runReconcile(home, 'droid', '0.158.0');

    expect(action).toBe('none');
    expect(fs.existsSync(droidVersionDir(home, '0.158.0'))).toBe(true);
  });

  it('is a no-op when the resolved version is itself `latest` (probe failed)', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(droidVersionDir(home, 'latest'), 'home'), { recursive: true });

    const action = runReconcile(home, 'droid', 'latest');

    expect(action).toBe('none');
    expect(fs.existsSync(droidVersionDir(home, 'latest'))).toBe(true);
  });
});

describe('version resource sync path handling', () => {
  it('intersects explicit resource selections with discovered resources before syncing', async () => {
    const home = makeTempHome();

    fs.mkdirSync(path.join(home, '.agents', '.system', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', '.system', 'commands', 'safe.md'), 'safe command', 'utf-8');

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

    fs.mkdirSync(path.join(home, '.agents', '.system', 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.agents', '.system', 'commands', 'recap.md'),
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

  it('keeps grok command-generated skills authoritative over marker-bearing source skills', async () => {
    const home = makeTempHome();
    const commandPath = path.join(home, '.agents', 'commands', 'debug.md');
    const sourceSkillPath = path.join(home, '.agents', 'skills', 'debug', 'SKILL.md');
    const binaryPath = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.33', 'home', '.grok', 'downloads', 'grok-0.2.33-macos-aarch64');

    fs.mkdirSync(path.dirname(commandPath), { recursive: true });
    fs.mkdirSync(path.dirname(sourceSkillPath), { recursive: true });
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(
      commandPath,
      ['---', 'description: Fresh debug command', '---', '', 'fresh command body'].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      sourceSkillPath,
      ['---', 'name: "debug"', 'description: "old generated command"', 'agents_command: "debug"', '---', '', 'old source skill body'].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', 'utf-8');
    fs.chmodSync(binaryPath, 0o755);

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('grok', '0.2.33', { commands: ['debug'], skills: ['debug'] }, { cwd: home })"
    ) as { commands: boolean; skills: boolean };

    const syncedSkillPath = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.33', 'home', '.grok', 'skills', 'debug', 'SKILL.md');
    const syncedSkill = fs.readFileSync(syncedSkillPath, 'utf-8');
    expect(result.commands).toBe(true);
    expect(result.skills).toBe(false);
    expect(syncedSkill).toContain('fresh command body');
    expect(syncedSkill).not.toContain('old source skill body');
    expect(fs.existsSync(binaryPath)).toBe(true);
  });

  it('does not follow symlinks inside copied skill resources', async () => {
    const home = makeTempHome();

    const skillDir = path.join(home, '.agents', '.system', 'skills', 'leaky');
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

    const skillDir = path.join(home, '.agents', '.system', 'skills', 'tiny');
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

  it('writes missing grok AGENTS.md when syncing a partial selection without memory', async () => {
    const home = makeTempHome();
    const rulesDir = path.join(home, '.agents', '.system', 'rules');

    fs.mkdirSync(path.join(rulesDir, 'subrules'), { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, 'rules.yaml'),
      'presets:\n  default:\n    subrules:\n      - core\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(rulesDir, 'subrules', 'core.md'), 'Grok memory body\n', 'utf-8');

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('grok', '0.2.33', { skills: [] }, { cwd: home })"
    ) as { memory: string[] };

    const agentsPath = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.33', 'home', '.grok', 'AGENTS.md');
    expect(result.memory).toContain('AGENTS.md');
    expect(fs.existsSync(agentsPath)).toBe(true);
    expect(fs.readFileSync(agentsPath, 'utf-8')).toContain('Grok memory body');
  });

  it('detects grok binaries from the per-version home, not the host .grok symlink', async () => {
    const home = makeTempHome();
    const installedDownloads = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.33', 'home', '.grok', 'downloads');
    const emptyConfigDir = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.32', 'home', '.grok');
    const hostGrok = path.join(home, '.grok');

    fs.mkdirSync(installedDownloads, { recursive: true });
    fs.mkdirSync(path.join(emptyConfigDir, 'downloads'), { recursive: true });
    fs.writeFileSync(path.join(installedDownloads, 'grok-0.2.33-macos-aarch64'), '#!/bin/sh\nexit 0\n', 'utf-8');
    fs.chmodSync(path.join(installedDownloads, 'grok-0.2.33-macos-aarch64'), 0o755);
    fs.symlinkSync(emptyConfigDir, hostGrok, 'dir');

    const result = runVersionSync(home, "listInstalledVersions('grok')") as string[];

    expect(result).toEqual(['0.2.33']);
  });
});

// `installVersion` derives an `npm install <pkg>@<version>` spec from `version`,
// which originates from the `agents add pkg@<version>` CLI arg or a
// `.agents-version` pin. The argv-form execFile call cannot be reached for a
// tainted version because VERSION_RE rejects it at the source (versions.ts).
// These tests assert the rejection happens before any npm exec, so a malicious
// version can never escape into a shell.
function runInstallVersion(home: string, agent: string, version: string): { ok: boolean; error?: string } {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/versions.ts')).href;
  const tsxBin = path.resolve('node_modules/.bin/tsx');
  const child = spawnSync(tsxBin, ['-e', `
    import { installVersion } from ${JSON.stringify(moduleUrl)};
    (async () => {
      try {
        const r = await installVersion(${JSON.stringify(agent)}, ${JSON.stringify(version)});
        console.log(JSON.stringify({ ok: true, result: r }));
      } catch (err) {
        console.log(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
  `], {
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

describe('installVersion version validation', () => {
  const malicious = [
    'latest; touch /tmp/pwned',
    '1.0.0 && rm -rf ~',
    '$(touch /tmp/pwned)',
    '`touch /tmp/pwned`',
    '1.0.0|cat /etc/passwd',
    '--registry=http://evil.example.com',
  ];

  for (const version of malicious) {
    it(`rejects malicious version before any npm exec: ${JSON.stringify(version)}`, () => {
      const home = makeTempHome();
      const outcome = runInstallVersion(home, 'codex', version);
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain('Invalid version');
      // No version dir was created — rejection happened at the source, before
      // ensureAgentsDir / npm install could run.
      expect(fs.existsSync(path.join(home, '.agents', '.history', 'versions', 'codex'))).toBe(false);
    });
  }

  it('accepts a well-formed semver version through the validation guard', () => {
    const home = makeTempHome();
    // A valid version passes VERSION_RE. `kiro` has no npmPackage and a
    // non-VERSION installScript, so installVersion returns a benign,
    // network-free error AFTER the guard — proving valid input is not rejected.
    const outcome = runInstallVersion(home, 'kiro', '0.0.0-rc.1');
    expect(outcome.ok).toBe(true);
    const result = (outcome as { result?: { success: boolean; error?: string } }).result;
    expect(result?.success).toBe(false);
    expect(result?.error ?? '').not.toContain('Invalid version');
    expect(result?.error ?? '').toContain('does not support version-pinned installs');
  });
});
