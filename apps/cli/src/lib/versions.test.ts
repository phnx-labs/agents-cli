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
  // Run tsx via `node node_modules/tsx/dist/cli.mjs` (not the .bin/tsx shim): on
  // Windows the shim is tsx.cmd, which spawnSync cannot exec without a shell, and
  // routing the multi-line `-e` script through cmd.exe would mangle it. node is an
  // .exe everywhere, so this is shell-free and cross-platform.
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(process.execPath, [tsxBin, '-e', `
    import { listInstalledVersions, syncResourcesToVersion, buildRepoScopedSelection } from ${JSON.stringify(moduleUrl)};
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
  // Run tsx via `node node_modules/tsx/dist/cli.mjs` (not the .bin/tsx shim): on
  // Windows the shim is tsx.cmd, which spawnSync cannot exec without a shell, and
  // routing the multi-line `-e` script through cmd.exe would mangle it. node is an
  // .exe everywhere, so this is shell-free and cross-platform.
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(process.execPath, [tsxBin, '-e', `
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

// Full path (RUSH-1320): resolve the live CLI version via a real `--version`
// shell-out, then fold the stale `latest` dir onto it. Uses a fake `droid` on
// PATH — no mocking — so getCliVersionFromPath returns a concrete version.
function runReconcileForAgent(home: string, agent: string, fakeBinDir: string): void {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/versions.ts')).href;
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(process.execPath, [tsxBin, '-e', `
    import { reconcileStaleLatestForAgent } from ${JSON.stringify(moduleUrl)};
    (async () => { await reconcileStaleLatestForAgent(${JSON.stringify(agent)}); })();
  `], {
    // Prepend the fake-bin dir so `droid --version` resolves to our stub.
    env: { ...process.env, HOME: home, PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}` },
    encoding: 'utf-8',
  });
  expect(child.status, child.stderr).toBe(0);
}

describe('reconcileStaleLatestForAgent (proactive)', () => {
  it.skipIf(process.platform === 'win32')('folds a stale `latest` onto the live CLI version, preserving home/', () => {
    const home = makeTempHome();
    // Stale latest home with a credential-like file that must survive the fold.
    const latestFactory = path.join(droidVersionDir(home, 'latest'), 'home', '.factory');
    fs.mkdirSync(latestFactory, { recursive: true });
    fs.writeFileSync(path.join(latestFactory, 'auth.v2.file'), 'LOGIN');

    // Fake `droid --version` -> 0.161.0.
    const binDir = path.join(home, 'fakebin');
    fs.mkdirSync(binDir, { recursive: true });
    const droidStub = path.join(binDir, 'droid');
    fs.writeFileSync(droidStub, '#!/bin/sh\necho "droid 0.161.0"\n');
    fs.chmodSync(droidStub, 0o755);

    runReconcileForAgent(home, 'droid', binDir);

    // `latest` is gone; its home (incl. the login file) now lives under 0.161.0.
    expect(fs.existsSync(droidVersionDir(home, 'latest'))).toBe(false);
    expect(fs.readFileSync(path.join(droidVersionDir(home, '0.161.0'), 'home', '.factory', 'auth.v2.file'), 'utf8')).toBe('LOGIN');
  });

  it.skipIf(process.platform === 'win32')('is a no-op when there is no stale `latest` dir', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(droidVersionDir(home, '0.161.0'), 'home'), { recursive: true });
    const binDir = path.join(home, 'fakebin');
    fs.mkdirSync(binDir, { recursive: true });
    const droidStub = path.join(binDir, 'droid');
    fs.writeFileSync(droidStub, '#!/bin/sh\necho "droid 0.161.0"\n');
    fs.chmodSync(droidStub, 0o755);

    runReconcileForAgent(home, 'droid', binDir);

    // 0.161.0 untouched, no `latest` created.
    expect(fs.existsSync(droidVersionDir(home, '0.161.0'))).toBe(true);
    expect(fs.existsSync(droidVersionDir(home, 'latest'))).toBe(false);
  });
});

// RUSH-1321: a self-updating agent (droid) is ONE global binary. Its per-version
// dirs all map to the same executable, so agents-cli must model it as a single
// install — not a set of fictional version-homes. grok is self-updating too but
// stores a real per-version binary copy under each version-home, so it must NOT
// be collapsed.
function droidBin(home: string): string {
  return path.join(home, '.local', 'bin', 'droid');
}

function makeDroidBinary(home: string): void {
  const binDir = path.dirname(droidBin(home));
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(droidBin(home), '#!/bin/sh\necho "droid 0.21.0"\n');
  fs.chmodSync(droidBin(home), 0o755);
}

function grokBinaryDir(home: string, version: string): string {
  return path.join(home, '.agents', '.history', 'versions', 'grok', version, 'home', '.grok', 'downloads');
}

// Predicate check runs in a tsx subprocess (versions.ts pulls in the SQLite
// layer with a top-level await the CJS test process can't statically transform).
function runPredicates(expression: string): unknown {
  const versionsUrl = pathToFileURL(path.resolve('src/lib/versions.ts')).href;
  const agentsUrl = pathToFileURL(path.resolve('src/lib/agents.ts')).href;
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(process.execPath, [tsxBin, '-e', `
    import { isGlobalBinaryAgent } from ${JSON.stringify(versionsUrl)};
    import { isSelfUpdatingAgent } from ${JSON.stringify(agentsUrl)};
    console.log(JSON.stringify(${expression}));
  `], { env: { ...process.env }, encoding: 'utf-8' });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

describe('self-updating single-binary agents (RUSH-1321)', () => {
  it('classifies self-updating vs npm-packaged vs per-version-binary agents', () => {
    const r = runPredicates(`{
      droidSelf: isSelfUpdatingAgent('droid'),
      grokSelf: isSelfUpdatingAgent('grok'),
      antigravitySelf: isSelfUpdatingAgent('antigravity'),
      claudeSelf: isSelfUpdatingAgent('claude'),
      kimiSelf: isSelfUpdatingAgent('kimi'),
      droidGlobal: isGlobalBinaryAgent('droid'),
      grokGlobal: isGlobalBinaryAgent('grok'),
      claudeGlobal: isGlobalBinaryAgent('claude'),
    }`) as Record<string, boolean>;
    expect(r).toEqual({
      droidSelf: true,
      grokSelf: true,
      antigravitySelf: true,
      claudeSelf: false, // npm-packaged — pinnable, genuinely multi-version
      kimiSelf: false,   // npm-packaged
      droidGlobal: true, // one binary at ~/.local/bin/droid regardless of version
      grokGlobal: false, // per-version binary copy under each version-home
      claudeGlobal: false,
    });
  });

  it.skipIf(process.platform === 'win32')('collapses multiple droid version dirs to a single canonical entry', () => {
    const home = makeTempHome();
    makeDroidBinary(home);
    // Two real semver dirs that both resolve to the ONE global binary.
    fs.mkdirSync(path.join(droidVersionDir(home, '0.19.3'), 'home'), { recursive: true });
    fs.mkdirSync(path.join(droidVersionDir(home, '0.21.0'), 'home'), { recursive: true });

    const versions = runVersionSync(home, "listInstalledVersions('droid')") as string[];

    // One entry, not two phantom rows. Newest wins with no symlink/default/live cache.
    expect(versions).toEqual(['0.21.0']);
  });

  it.skipIf(process.platform === 'win32')('does NOT collapse grok — per-version-home binaries stay distinct', () => {
    const home = makeTempHome();
    for (const v of ['0.2.33', '0.2.40']) {
      const dir = grokBinaryDir(home, v);
      fs.mkdirSync(dir, { recursive: true });
      const bin = path.join(dir, `grok-${v}-test`);
      fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(bin, 0o755);
    }

    const versions = runVersionSync(home, "listInstalledVersions('grok')") as string[];

    expect(versions).toEqual(['0.2.33', '0.2.40']);
  });

  it.skipIf(process.platform === 'win32')('reconcile folds every stale droid dir into the live version, preserving home/', () => {
    const home = makeTempHome();
    // Two coexisting real-semver droid dirs; the old one carries a login file.
    const oldFactory = path.join(droidVersionDir(home, '0.19.3'), 'home', '.factory');
    fs.mkdirSync(oldFactory, { recursive: true });
    fs.writeFileSync(path.join(oldFactory, 'auth.v2.file'), 'LOGIN');
    fs.mkdirSync(path.join(droidVersionDir(home, '0.21.0'), 'home'), { recursive: true });

    // Fake `droid --version` -> 0.21.0 so the live version is the survivor.
    const binDir = path.join(home, 'fakebin');
    fs.mkdirSync(binDir, { recursive: true });
    const droidStub = path.join(binDir, 'droid');
    fs.writeFileSync(droidStub, '#!/bin/sh\necho "droid 0.21.0"\n');
    fs.chmodSync(droidStub, 0o755);

    runReconcileForAgent(home, 'droid', binDir);

    // The stale 0.19.3 dir is folded away; only the live 0.21.0 survives on disk.
    expect(fs.existsSync(droidVersionDir(home, '0.19.3'))).toBe(false);
    expect(fs.existsSync(droidVersionDir(home, '0.21.0'))).toBe(true);
    // Soft-deleted (recoverable), not hard-deleted — its home/ (incl. login) is in trash.
    const trashDir = path.join(home, '.agents', '.history', 'trash', 'versions', 'droid', '0.19.3');
    expect(fs.existsSync(trashDir)).toBe(true);
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
function runInstallVersion(home: string, agent: string, version: string, extraPathDir?: string): { ok: boolean; error?: string; result?: { success: boolean; installedVersion?: string; error?: string } } {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/versions.ts')).href;
  // Run tsx via `node node_modules/tsx/dist/cli.mjs` (not the .bin/tsx shim): on
  // Windows the shim is tsx.cmd, which spawnSync cannot exec without a shell, and
  // routing the multi-line `-e` script through cmd.exe would mangle it. node is an
  // .exe everywhere, so this is shell-free and cross-platform.
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(process.execPath, [tsxBin, '-e', `
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
    env: {
      ...process.env,
      HOME: home,
      ...(extraPathDir ? { PATH: `${extraPathDir}${path.delimiter}${process.env.PATH}` } : {}),
    },
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

  it.skipIf(process.platform === 'win32')('gracefully redirects a pinned self-updating install to the current release (RUSH-1321)', () => {
    const home = makeTempHome();
    // A valid version passes VERSION_RE. `kiro` is self-updating (brew, no
    // VERSION token). A `kiro-cli` on PATH makes the single binary read as
    // already-installed, so the pin is a network-free no-op — NOT the old
    // `does not support version-pinned installs` hard error, and NOT a real
    // `brew install`.
    const binDir = path.join(home, 'fakebin');
    fs.mkdirSync(binDir, { recursive: true });
    const stub = path.join(binDir, 'kiro-cli');
    fs.writeFileSync(stub, '#!/bin/sh\necho "kiro-cli 2.12.1"\n');
    fs.chmodSync(stub, 0o755);

    const outcome = runInstallVersion(home, 'kiro', '0.0.0-rc.1', binDir);
    expect(outcome.ok).toBe(true);
    const result = outcome.result;
    expect(result?.success).toBe(true);
    expect(result?.installedVersion).toBe('2.12.1'); // the live version, not the ignored pin
    expect(result?.error ?? '').not.toContain('Invalid version');
    expect(result?.error ?? '').not.toContain('does not support version-pinned installs');
  });
});

// `resolveVersionAlias` is the shared @selector vocabulary (latest / oldest /
// default / pinned / explicit) every `agents <cmd> agent@<token>` reads. droid
// installs a single global binary (~/.local/bin/droid) shared across version
// dirs, so a fixture is just N dirs + one binary — every dir reads as installed.
function runResolveAlias(home: string, agent: string, raw: string | undefined): string | null {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/versions.ts')).href;
  // Run tsx via `node node_modules/tsx/dist/cli.mjs` (not the .bin/tsx shim): on
  // Windows the shim is tsx.cmd, which spawnSync cannot exec without a shell, and
  // routing the multi-line `-e` script through cmd.exe would mangle it. node is an
  // .exe everywhere, so this is shell-free and cross-platform.
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(process.execPath, [tsxBin, '-e', `
    import { resolveVersionAlias } from ${JSON.stringify(moduleUrl)};
    const r = resolveVersionAlias(${JSON.stringify(agent)}, ${JSON.stringify(raw ?? null)});
    console.log(JSON.stringify({ v: r === undefined ? null : r }));
  `], {
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });
  expect(child.status, child.stderr).toBe(0);
  return (JSON.parse(child.stdout.trim()) as { v: string | null }).v;
}

function installDroidVersions(home: string, versions: string[]): void {
  for (const v of versions) {
    fs.mkdirSync(path.join(droidVersionDir(home, v), 'home'), { recursive: true });
  }
  // droid's binary is global and per-host, not per-version (getBinaryPath).
  // Mirror getBinaryPath's platform split so the fixture binary lands where the
  // SUT actually looks: Windows -> ~/bin/droid.exe, macOS/Linux -> ~/.local/bin/droid.
  const bin = process.platform === 'win32'
    ? path.join(home, 'bin', 'droid.exe')
    : path.join(home, '.local', 'bin', 'droid');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', 'utf-8');
  fs.chmodSync(bin, 0o755);
}

// Numeric-vs-lexical ordering must be exercised on a genuinely MULTI-version
// agent. droid is now single-binary (its dirs collapse to one — RUSH-1321), so
// use antigravity (cliCommand `agy`): self-updating but per-version binary at
// `node_modules/.bin/agy`, so its version dirs are NOT collapsed.
function installAntigravityVersions(home: string, versions: string[]): void {
  for (const v of versions) {
    const binDir = path.join(home, '.agents', '.history', 'versions', 'antigravity', v, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, 'agy');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', 'utf-8');
    fs.chmodSync(bin, 0o755);
  }
}

describe('resolveVersionAlias @selectors', () => {
  // Versions chosen so numeric ordering disagrees with lexical ordering:
  // numeric oldest=0.9.0, newest=0.158.0; lexical would put "0.10.0" first.
  const VERSIONS = ['0.9.0', '0.10.0', '0.158.0'];

  it("resolves 'latest' to the highest installed version (numeric, not lexical)", () => {
    const home = makeTempHome();
    installAntigravityVersions(home, VERSIONS);
    expect(runResolveAlias(home, 'antigravity', 'latest')).toBe('0.158.0');
  });

  it("resolves 'oldest' to the lowest installed version (numeric, not lexical)", () => {
    const home = makeTempHome();
    installAntigravityVersions(home, VERSIONS);
    expect(runResolveAlias(home, 'antigravity', 'oldest')).toBe('0.9.0');
  });

  it("treats 'pinned' as a synonym for 'default' — both defer to the caller (undefined)", () => {
    const home = makeTempHome();
    installDroidVersions(home, VERSIONS);
    expect(runResolveAlias(home, 'droid', 'pinned')).toBeNull();
    expect(runResolveAlias(home, 'droid', 'default')).toBeNull();
  });

  it('passes an explicit installed version through unchanged', () => {
    const home = makeTempHome();
    installAntigravityVersions(home, VERSIONS);
    expect(runResolveAlias(home, 'antigravity', '0.10.0')).toBe('0.10.0');
  });

  it("defers an absent/empty token to the caller (undefined)", () => {
    const home = makeTempHome();
    installDroidVersions(home, VERSIONS);
    expect(runResolveAlias(home, 'droid', undefined)).toBeNull();
  });

  it("treats 'any' like default/pinned — no version constraint (undefined)", () => {
    const home = makeTempHome();
    installDroidVersions(home, VERSIONS);
    expect(runResolveAlias(home, 'droid', 'any')).toBeNull();
  });
});

describe('resolveVersionAliasLoose — @any', () => {
  it('treats "any" like "default": no version constraint (undefined)', () => {
    const home = makeTempHome();
    const moduleUrl = pathToFileURL(path.resolve('src/lib/versions.ts')).href;
    const tsxBin = path.resolve('node_modules/.bin/tsx');
    const child = spawnSync(tsxBin, ['-e', `
      import { resolveVersionAlias, resolveVersionAliasLoose } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify({
        strictAny: resolveVersionAlias('claude', 'any') ?? null,
        looseAny: resolveVersionAliasLoose('claude', 'any') ?? null,
        strictDefault: resolveVersionAlias('claude', 'default') ?? null,
      }));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual({ strictAny: null, looseAny: null, strictDefault: null });
  });
});

describe('buildRepoScopedSelection — agents sync <agent> --repo <name>', () => {
  // Scaffold a user skill and a system skill in an isolated HOME, then confirm
  // scoping to one repo returns only that layer's resources. Guards against
  // layer-misattribution — the bug where `--repo system` would sweep in (or
  // drop) the wrong repo's skills.
  function runBuildScoped(home: string, repo: string): { skills?: string[]; memory?: string[] | 'all' } {
    const moduleUrl = pathToFileURL(path.resolve('src/lib/versions.ts')).href;
    const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
    const child = spawnSync(process.execPath, [tsxBin, '-e', `
      import { buildRepoScopedSelection } from ${JSON.stringify(moduleUrl)};
      const home = ${JSON.stringify(home)};
      console.log(JSON.stringify(buildRepoScopedSelection(${JSON.stringify(repo)}, home)));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout.trim());
  }

  function scaffoldSkills(home: string): void {
    const userSkill = path.join(home, '.agents', 'skills', 'user-only', 'SKILL.md');
    const systemSkill = path.join(home, '.agents', '.system', 'skills', 'system-only', 'SKILL.md');
    fs.mkdirSync(path.dirname(userSkill), { recursive: true });
    fs.mkdirSync(path.dirname(systemSkill), { recursive: true });
    fs.writeFileSync(userSkill, 'user skill body', 'utf-8');
    fs.writeFileSync(systemSkill, 'system skill body', 'utf-8');
  }

  it('scopes to the system repo — only system-layer skills, not user', () => {
    const home = makeTempHome();
    scaffoldSkills(home);
    const sel = runBuildScoped(home, 'system');
    expect(sel.skills).toEqual(['system-only']);
  });

  it('scopes to the user repo — only user-layer skills, not system', () => {
    const home = makeTempHome();
    scaffoldSkills(home);
    const sel = runBuildScoped(home, 'user');
    expect(sel.skills).toEqual(['user-only']);
  });

  it('recompiles a STALE memory file through a real repo-scoped sync (RUSH-1354)', () => {
    const home = makeTempHome();
    // The composed rules-memory file is a merge of ALL layers, so a repo-scoped
    // sync must still recompile it — otherwise a rules change followed by a
    // repo-scoped `agents sync <agent> <repo>` silently strands the file at its
    // old content. Same rules fixture the "writes missing grok AGENTS.md" test
    // uses; here we PRE-SEED a stale AGENTS.md and prove the scoped sync
    // overwrites it with the freshly composed content.
    const rulesDir = path.join(home, '.agents', '.system', 'rules');
    fs.mkdirSync(path.join(rulesDir, 'subrules'), { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, 'rules.yaml'),
      'presets:\n  default:\n    subrules:\n      - core\n',
      'utf-8'
    );
    fs.writeFileSync(path.join(rulesDir, 'subrules', 'core.md'), 'fresh scoped memory body\n', 'utf-8');

    // Pre-seed a stale memory file in the version home — this is what a prior
    // sync left behind before the rules changed.
    const agentDir = path.join(home, '.agents', '.history', 'versions', 'grok', '0.2.33', 'home', '.grok');
    const agentsPath = path.join(agentDir, 'AGENTS.md');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(agentsPath, 'STALE memory body — must be overwritten\n', 'utf-8');

    // The scoped selection now recomposes memory from all layers (memory:'all',
    // not the old []-skip sentinel).
    expect(runBuildScoped(home, 'system').memory).toEqual('all');

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('grok', '0.2.33', buildRepoScopedSelection('system', home), { cwd: home })"
    ) as { memory: string[] };

    expect(result.memory).toContain('AGENTS.md');
    expect(fs.existsSync(agentsPath)).toBe(true);
    const written = fs.readFileSync(agentsPath, 'utf-8');
    expect(written).toContain('fresh scoped memory body');
    expect(written).not.toContain('STALE memory body');
  });
});

describe('unionResourceSelections + mergeRepoScopedSelections — interactive multi-repo sync', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function evalExpr(home: string, expr: string): any {
    const moduleUrl = pathToFileURL(path.resolve('src/lib/versions.ts')).href;
    const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
    const child = spawnSync(process.execPath, [tsxBin, '-e', `
      import * as V from ${JSON.stringify(moduleUrl)};
      const home = ${JSON.stringify(home)};
      console.log(JSON.stringify(${expr}));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout.trim());
  }

  it('unions selections and dedupes names per kind', () => {
    const home = makeTempHome();
    const out = evalExpr(home,
      "V.unionResourceSelections([{skills:['a','b']},{skills:['b','c'],commands:['x']}], false)");
    expect(out.skills.sort()).toEqual(['a', 'b', 'c']);
    expect(out.commands).toEqual(['x']);
    expect(out.memory).toEqual([]); // includeMemory=false → skip sentinel
  });

  it('includeMemory=true requests a full memory write', () => {
    const home = makeTempHome();
    const out = evalExpr(home, "V.unionResourceSelections([{skills:['a']}], true)");
    expect(out.memory).toBe('all');
  });

  it('merges system + user skills and writes memory when a memory layer is picked', () => {
    const home = makeTempHome();
    const userSkill = path.join(home, '.agents', 'skills', 'user-only', 'SKILL.md');
    const systemSkill = path.join(home, '.agents', '.system', 'skills', 'system-only', 'SKILL.md');
    fs.mkdirSync(path.dirname(userSkill), { recursive: true });
    fs.mkdirSync(path.dirname(systemSkill), { recursive: true });
    fs.writeFileSync(userSkill, 'user skill body', 'utf-8');
    fs.writeFileSync(systemSkill, 'system skill body', 'utf-8');

    const out = evalExpr(home, "V.mergeRepoScopedSelections(['user','system'], home)");
    expect(out.skills.sort()).toEqual(['system-only', 'user-only']);
    expect(out.memory).toBe('all'); // user/system layer selected → memory written
  });

  it('a project-only pick leaves the memory file untouched', () => {
    const home = makeTempHome();
    const out = evalExpr(home, "V.mergeRepoScopedSelections(['project'], home)");
    expect(out.memory).toEqual([]); // neither user nor system → skip sentinel
  });
});

// ── isVersionInstalled / listInstalledVersions probe the real launch binary ──
//
// Regression for the "gutted install" bug: a vendor auto-updater destroyed the
// real per-version claude binary (node_modules/@anthropic-ai/claude-code/bin/
// claude.exe) while leaving the version dir, its package.json, and the tiny
// node_modules/.bin/claude(+.cmd) wrappers in place. The old check keyed
// "installed" on the wrapper, so `agents add` skipped repair and the picker
// counted the dead install healthy — `agents run` then died at spawn.

function versionDir(home: string, agent: string, version: string): string {
  return path.join(home, '.agents', '.history', 'versions', agent, version);
}

// The name of the real launch binary the package's `bin` entry points at. We
// don't use ".exe" so the fixture is platform-neutral — getPackageBinaryPath
// reads whatever the installed package.json declares, which is exactly the
// point of the fix.
const CLAUDE_BIN_REL = 'bin/claude-launcher';

/**
 * Build a claude version dir. Always writes the version-dir marker package.json
 * and the node_modules/.bin/claude(+.cmd) wrappers npm leaves behind. When
 * `realBinary` is true, also writes the package's actual launch binary — omit
 * it to reproduce a gutted install.
 */
function makeClaudeVersion(home: string, version: string, opts: { realBinary: boolean }): void {
  const dir = versionDir(home, 'claude', version);
  const pkgRoot = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  fs.mkdirSync(path.join(pkgRoot, 'bin'), { recursive: true });

  // Version-dir marker (present even on a gutted install).
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `agents-claude-${version}`, private: true }), 'utf-8');
  // Installed package's package.json — declares the real launch binary.
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version, bin: { claude: CLAUDE_BIN_REL } }), 'utf-8');
  // The node_modules/.bin wrappers npm always leaves behind (getBinaryPath's target).
  fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'claude'), '#!/bin/sh\nexit 0\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'claude.cmd'), '@echo off\r\n', 'utf-8');

  if (opts.realBinary) {
    fs.writeFileSync(path.join(pkgRoot, CLAUDE_BIN_REL), 'REAL BINARY', 'utf-8');
  }
}

function runNamedExport(home: string, importName: string, callExpr: string): unknown {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/versions.ts')).href;
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(process.execPath, [tsxBin, '-e', `
    import { ${importName} } from ${JSON.stringify(moduleUrl)};
    const home = ${JSON.stringify(home)};
    console.log(JSON.stringify(${callExpr}));
  `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

describe('isVersionInstalled — probes the real launch binary', () => {
  it('reports a healthy install (package bin present) as installed', () => {
    const home = makeTempHome();
    makeClaudeVersion(home, '2.1.196', { realBinary: true });
    expect(runNamedExport(home, 'isVersionInstalled', "isVersionInstalled('claude', '2.1.196')")).toBe(true);
  });

  it('reports a gutted install (real bin destroyed, wrappers + package.json left behind) as NOT installed', () => {
    const home = makeTempHome();
    makeClaudeVersion(home, '2.1.196', { realBinary: false });
    // The node_modules/.bin/claude wrapper still exists — the old dir/wrapper
    // check would call this installed. The launch binary is gone, so it isn't.
    expect(fs.existsSync(path.join(versionDir(home, 'claude', '2.1.196'), 'node_modules', '.bin', 'claude'))).toBe(true);
    expect(runNamedExport(home, 'isVersionInstalled', "isVersionInstalled('claude', '2.1.196')")).toBe(false);
  });

  it('reports a dir-only install (package.json marker, no node_modules) as NOT installed', () => {
    const home = makeTempHome();
    const dir = versionDir(home, 'claude', '2.1.196');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agents-claude-2.1.196' }), 'utf-8');
    expect(runNamedExport(home, 'isVersionInstalled', "isVersionInstalled('claude', '2.1.196')")).toBe(false);
  });
});

describe('the add fast-path gate flips a gutted install to the repair branch', () => {
  it('a gutted dir is NOT alreadyInstalled, so `agents add` proceeds to installVersion', () => {
    // `agents add` computes `alreadyInstalled = isVersionInstalled(agent, version)`
    // and only skips install when it is true (src/commands/versions.ts). A gutted
    // dir must return false so add re-runs its install step to repair it rather
    // than printing "already installed".
    const home = makeTempHome();
    makeClaudeVersion(home, '2.1.196', { realBinary: false });
    const alreadyInstalled = runNamedExport(home, 'isVersionInstalled', "isVersionInstalled('claude', '2.1.196')");
    expect(alreadyInstalled).toBe(false);
  });
});

describe('listInstalledVersions — excludes gutted installs from the picker', () => {
  it('returns only versions whose real launch binary exists', () => {
    const home = makeTempHome();
    makeClaudeVersion(home, '2.1.195', { realBinary: true });
    makeClaudeVersion(home, '2.1.196', { realBinary: false }); // gutted
    const versions = runNamedExport(home, 'listInstalledVersions', "listInstalledVersions('claude')");
    expect(versions).toEqual(['2.1.195']);
  });
});

// Regression (RUSH-1420): removing the version that is the current global
// default must never leave a dangling default pointer — every launcher shim
// resolves the default, so a stale pointer breaks `agents run` and the default
// shim outright ("no installed default for claude"). The fix reassigns the
// default to the newest remaining install, or clears it cleanly when the last
// version goes.
describe('removeVersion — default reassignment when removing the pinned default', () => {
  // Lay down a claude version on disk the way listInstalledVersions expects:
  // a real binary file at <versionDir>/node_modules/.bin/claude.
  function installClaudeVersion(home: string, version: string): void {
    const binDir = path.join(home, '.agents', '.history', 'versions', 'claude', version, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\n', 'utf-8');
  }

  // One subprocess so the module-level HOME + version caches stay consistent:
  // set the default, remove a version, then read back the resolved default.
  function runRemoveScenario(home: string, defaultVersion: string, versionToRemove: string): { removed: boolean; defaultAfter: string | null } {
    const moduleUrl = pathToFileURL(path.resolve('src/lib/versions.ts')).href;
    const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
    const child = spawnSync(process.execPath, [tsxBin, '-e', `
      import { setGlobalDefault, getGlobalDefault, removeVersion } from ${JSON.stringify(moduleUrl)};
      setGlobalDefault('claude', ${JSON.stringify(defaultVersion)});
      const removed = removeVersion('claude', ${JSON.stringify(versionToRemove)});
      // removeVersion prints a human notice to stdout; tag the machine-readable
      // result so the parent can pick it out of the surrounding output.
      console.log('__RESULT__' + JSON.stringify({ removed, defaultAfter: getGlobalDefault('claude') }));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
    expect(child.status, child.stderr).toBe(0);
    const line = child.stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
    expect(line, child.stdout).toBeTruthy();
    return JSON.parse(line!.slice('__RESULT__'.length));
  }

  it('reassigns the default to the newest remaining version when siblings exist', () => {
    const home = makeTempHome();
    installClaudeVersion(home, '2.1.185');
    installClaudeVersion(home, '2.1.196');
    installClaudeVersion(home, '2.1.201');

    // 2.1.196 is the default and gets removed; 2.1.185 + 2.1.201 remain.
    const { removed, defaultAfter } = runRemoveScenario(home, '2.1.196', '2.1.196');

    expect(removed).toBe(true);
    // Newest remaining is 2.1.201 — not the newest overall (which was removed).
    expect(defaultAfter).toBe('2.1.201');
    // The removed version's binary is gone (soft-deleted to trash).
    expect(fs.existsSync(path.join(home, '.agents', '.history', 'versions', 'claude', '2.1.196', 'node_modules', '.bin', 'claude'))).toBe(false);
  });

  it('clears the default without a dangling pointer when the last version is removed', () => {
    const home = makeTempHome();
    installClaudeVersion(home, '2.1.196');

    const { removed, defaultAfter } = runRemoveScenario(home, '2.1.196', '2.1.196');

    expect(removed).toBe(true);
    // No versions remain → default cleared cleanly, not left pointing at a ghost.
    expect(defaultAfter).toBe(null);
  });
});

