import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { commandAppliesTo, parseCommandMetadata } from './commands.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-commands-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runCommandsExpression(home: string, expression: string): unknown {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/commands.ts')).href;
  const tsxBin = path.resolve('node_modules/.bin/tsx');
  const child = spawnSync(tsxBin, ['-e', `
    import {
      diffVersionCommands,
      installCommandToVersion,
      listCommandsInVersionHome,
      removeCommandFromVersion,
    } from ${JSON.stringify(moduleUrl)};
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

/**
 * Scaffold a fake installed version so listInstalledVersions() recognises it.
 * versions.ts:940-956 checks for a binary at
 * <versionsDir>/<agent>/<version>/node_modules/.bin/<cliCommand>.
 * The CLI command for each agent:
 *   claude -> 'claude'   (agents.ts:171)
 *   gemini -> 'gemini'   (agents.ts:207)
 *   codex  -> 'codex'    (agents.ts:190)
 *
 * HOME is set to `home` in these tests, so:
 *   USER_AGENTS_DIR = home/.agents          (state.ts:30)
 *   VERSIONS_DIR    = home/.agents/versions (state.ts:55)
 */
function scaffoldInstalledVersion(home: string, agent: string, version: string): void {
  const cliCommand = agent; // claude -> 'claude', gemini -> 'gemini', codex -> 'codex'
  const binaryDir = path.join(home, '.agents', '.history', 'versions', agent, version, 'node_modules', '.bin');
  fs.mkdirSync(binaryDir, { recursive: true });
  fs.writeFileSync(path.join(binaryDir, cliCommand), '#!/bin/sh\necho fake', 'utf-8');
  fs.chmodSync(path.join(binaryDir, cliCommand), 0o755);
}

/** Place a command .md in the system commands dir so listCentralCommands() finds it. */
function writeSystemCommand(home: string, name: string, content: string): void {
  const dir = path.join(home, '.agents', '.system', 'commands');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), content, 'utf-8');
}

/** Path to the trash commands dir for a given HOME: home/.agents/.trash/commands */
function trashCommandsDir(home: string): string {
  return path.join(home, '.agents', '.history', 'trash', 'commands');
}

/** Path to the version home for an agent: home/.agents/versions/<agent>/<ver>/home */
function versionHomePath(home: string, agent: string, version: string): string {
  return path.join(home, '.agents', '.history', 'versions', agent, version, 'home');
}

describe('commandAppliesTo()', () => {
  it('excludes agents not listed in frontmatter', () => {
    expect(commandAppliesTo('cursor', '1.0.0', { agents: ['claude'] })).toEqual({
      ok: false,
      reason: 'agent_excluded',
    });
  });

  it('passes when agent is listed', () => {
    expect(commandAppliesTo('claude', '2.0.0', { agents: ['claude', 'codex'] })).toEqual({ ok: true });
  });

  it('gates codex versions with since/until on the command', () => {
    const meta = { agents: ['codex' as const], since: '0.117.0', until: '0.118.0' };
    expect(commandAppliesTo('codex', '0.116.0', meta).ok).toBe(false);
    expect(commandAppliesTo('codex', '0.117.0', meta)).toEqual({ ok: true });
    expect(commandAppliesTo('codex', '0.118.0', meta).ok).toBe(false);
  });
});

describe('command frontmatter install gating', () => {
  it('skips install when agents list excludes the target', () => {
    const home = makeTempHome();
    writeSystemCommand(home, 'version', `---
description: Show versions
agents: [claude]
---
Report versions.`);
    scaffoldInstalledVersion(home, 'codex', '0.116.0');

    const result = runCommandsExpression(
      home,
      "installCommandToVersion('codex', '0.116.0', 'version')"
    ) as { success: boolean; skipped?: boolean };

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    const commandsDir = path.join(versionHomePath(home, 'codex', '0.116.0'), '.codex', 'prompts');
    expect(fs.existsSync(path.join(commandsDir, 'version.md'))).toBe(false);
  });

  it('omits excluded commands from diffVersionCommands toAdd', () => {
    const home = makeTempHome();
    writeSystemCommand(home, 'version', `---
description: Show versions
agents: [claude]
---
Report versions.`);
    scaffoldInstalledVersion(home, 'codex', '0.116.0');

    const diff = runCommandsExpression(home, "diffVersionCommands('codex', '0.116.0')") as {
      toAdd: string[];
    };
    expect(diff.toAdd).not.toContain('version');
  });

  it('flags excluded but installed commands as toRemove', () => {
    const home = makeTempHome();
    writeSystemCommand(home, 'version', `---
description: Show versions
agents: [claude]
---
Report versions.`);
    scaffoldInstalledVersion(home, 'codex', '0.116.0');

    // Simulate a stale install from before frontmatter excluded this agent.
    const commandsDir = path.join(versionHomePath(home, 'codex', '0.116.0'), '.codex', 'prompts');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'version.md'), 'Report versions.', 'utf-8');

    const diff = runCommandsExpression(home, "diffVersionCommands('codex', '0.116.0')") as {
      toRemove: string[];
      toAdd: string[];
    };
    expect(diff.toRemove).toEqual(['version']);
    expect(diff.toAdd).not.toContain('version');
  });
});

describe('version command management', () => {
  it('installs, lists, diffs, and removes generated command skills for Codex 0.117.0+', () => {
    const home = makeTempHome();
    // codex 0.117.0 uses shouldInstallCommandAsSkill (skills path, not prompts file).
    // capabilities: commands: { until: '0.117.0' }, skills: true  (agents.ts:201)
    // So for 0.117.0, supports(codex, 'commands', '0.117.0').ok === false and
    //                    supports(codex, 'skills',   '0.117.0').ok === true
    //                 => shouldInstallCommandAsSkill returns true.
    writeSystemCommand(home, 'recap', 'Summarize this session.');

    const installed = runCommandsExpression(home, "installCommandToVersion('codex', '0.117.0', 'recap')") as { success: boolean };
    const listed = runCommandsExpression(home, "listCommandsInVersionHome('codex', '0.117.0')") as string[];
    const diff = runCommandsExpression(home, "diffVersionCommands('codex', '0.117.0')") as {
      matched: string[];
      toAdd: string[];
      toUpdate: string[];
      orphans: string[];
    };
    const removed = runCommandsExpression(home, "removeCommandFromVersion('codex', '0.117.0', 'recap')") as { success: boolean };

    // Correct version home path: home/.agents/versions/codex/0.117.0/home/.codex
    const versionHome = path.join(versionHomePath(home, 'codex', '0.117.0'), '.codex');
    expect(installed.success).toBe(true);
    expect(listed).toEqual(['recap']);
    expect(diff).toMatchObject({ matched: ['recap'], toAdd: [], toUpdate: [], toRemove: [], orphans: [] });
    expect(removed.success).toBe(true);
    // For the skills path, removeCommandSkillFromVersion does a hard rmSync (command-skills.ts:148).
    // There is NO soft-delete for this path; verify the skill dir is gone.
    expect(fs.existsSync(path.join(versionHome, 'skills', 'recap', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(versionHome, 'prompts', 'recap.md'))).toBe(false);
    // Confirm nothing landed in trash for the skills path (soft-delete is skipped).
    const trashEntries = fs.existsSync(path.join(trashCommandsDir(home), 'codex', '0.117.0'))
      ? fs.readdirSync(path.join(trashCommandsDir(home), 'codex', '0.117.0'))
      : [];
    expect(trashEntries).toHaveLength(0);
  });
});

describe('removeCommandFromVersion soft-delete', () => {
  it('moves a .md command to trash for claude instead of deleting it', () => {
    const home = makeTempHome();
    // Use claude 1.0.0: format=markdown (agents.ts:171,176), not skills path.
    // commands: true => supports commands at all versions for claude.
    writeSystemCommand(home, 'my-cmd', '---\ndescription: Test command\n---\nDo something.');
    scaffoldInstalledVersion(home, 'claude', '1.0.0');

    runCommandsExpression(home, "installCommandToVersion('claude', '1.0.0', 'my-cmd', 'copy')");

    // Verify the file is in the version home before removal.
    // claude commandsSubdir = 'commands' (agents.ts:176), ext = .md
    const commandsDir = path.join(versionHomePath(home, 'claude', '1.0.0'), '.claude', 'commands');
    expect(fs.existsSync(path.join(commandsDir, 'my-cmd.md'))).toBe(true);

    const result = runCommandsExpression(home, "removeCommandFromVersion('claude', '1.0.0', 'my-cmd')") as { success: boolean };
    expect(result.success).toBe(true);

    // The command must NOT be in the version home any more.
    expect(fs.existsSync(path.join(commandsDir, 'my-cmd.md'))).toBe(false);

    // The file MUST have been moved to trash.
    // Trash dir: home/.agents/.trash/commands/claude/1.0.0/my-cmd/ (commands.ts:407-409)
    const trashSubDir = path.join(trashCommandsDir(home), 'claude', '1.0.0', 'my-cmd');
    expect(fs.existsSync(trashSubDir)).toBe(true);
    const trashFiles = fs.readdirSync(trashSubDir);
    expect(trashFiles).toHaveLength(1);
    // File is named <commandName><ext>.<ISO-timestamp> with colons and dots replaced by dashes.
    expect(trashFiles[0]).toMatch(/^my-cmd\.md\.\d{4}-\d{2}-\d{2}T/);
    // The trashed file must contain the original command content.
    const trashedContent = fs.readFileSync(path.join(trashSubDir, trashFiles[0]), 'utf-8');
    expect(trashedContent).toContain('Do something.');
  });

  it('moves a .toml command to trash for gemini (format=toml)', () => {
    const home = makeTempHome();
    // gemini: format=toml (agents.ts:215), commandsSubdir='commands' (agents.ts:211)
    writeSystemCommand(home, 'plan', '---\ndescription: Plan something\n---\nPlan the work.');
    scaffoldInstalledVersion(home, 'gemini', '1.0.0');

    runCommandsExpression(home, "installCommandToVersion('gemini', '1.0.0', 'plan', 'copy')");

    const commandsDir = path.join(versionHomePath(home, 'gemini', '1.0.0'), '.gemini', 'commands');
    expect(fs.existsSync(path.join(commandsDir, 'plan.toml'))).toBe(true);

    const result = runCommandsExpression(home, "removeCommandFromVersion('gemini', '1.0.0', 'plan')") as { success: boolean };
    expect(result.success).toBe(true);

    expect(fs.existsSync(path.join(commandsDir, 'plan.toml'))).toBe(false);

    // Trash must use .toml extension (commands.ts:400: ext = AGENTS[agent].format === 'toml' ? '.toml' : '.md')
    const trashSubDir = path.join(trashCommandsDir(home), 'gemini', '1.0.0', 'plan');
    expect(fs.existsSync(trashSubDir)).toBe(true);
    const trashFiles = fs.readdirSync(trashSubDir);
    expect(trashFiles).toHaveLength(1);
    expect(trashFiles[0]).toMatch(/^plan\.toml\.\d{4}-\d{2}-\d{2}T/);
  });

  it('returns success without touching trash when the command does not exist', () => {
    const home = makeTempHome();
    // No command installed at all.
    scaffoldInstalledVersion(home, 'claude', '1.0.0');

    const result = runCommandsExpression(
      home,
      "removeCommandFromVersion('claude', '1.0.0', 'nonexistent')"
    ) as { success: boolean };
    expect(result.success).toBe(true);

    // Trash dir must not have been created.
    expect(fs.existsSync(path.join(trashCommandsDir(home), 'claude'))).toBe(false);
  });

  it('trash directory structure is <trashCommandsDir>/<agent>/<version>/<commandName>/', () => {
    const home = makeTempHome();
    writeSystemCommand(home, 'scope-test', '---\ndescription: Scope test\n---\nBody.');
    scaffoldInstalledVersion(home, 'claude', '2.0.0');

    runCommandsExpression(home, "installCommandToVersion('claude', '2.0.0', 'scope-test', 'copy')");
    runCommandsExpression(home, "removeCommandFromVersion('claude', '2.0.0', 'scope-test')");

    // Verify each level of the directory hierarchy exists.
    expect(fs.existsSync(trashCommandsDir(home))).toBe(true);
    expect(fs.existsSync(path.join(trashCommandsDir(home), 'claude'))).toBe(true);
    expect(fs.existsSync(path.join(trashCommandsDir(home), 'claude', '2.0.0'))).toBe(true);
    expect(fs.existsSync(path.join(trashCommandsDir(home), 'claude', '2.0.0', 'scope-test'))).toBe(true);
    const files = fs.readdirSync(path.join(trashCommandsDir(home), 'claude', '2.0.0', 'scope-test'));
    expect(files).toHaveLength(1);
  });
});

describe('diffVersionCommands orphan detection', () => {
  it('reports a command in the version home that is absent from central as an orphan', () => {
    const home = makeTempHome();
    // Put a command in central.
    writeSystemCommand(home, 'kept', '---\ndescription: Kept command\n---\nKeep this.');
    scaffoldInstalledVersion(home, 'claude', '1.0.0');
    runCommandsExpression(home, "installCommandToVersion('claude', '1.0.0', 'kept', 'copy')");

    // Manually plant an extra command in the version home (no central source).
    const commandsDir = path.join(versionHomePath(home, 'claude', '1.0.0'), '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'orphan.md'), '# orphan', 'utf-8');

    const diff = runCommandsExpression(home, "diffVersionCommands('claude', '1.0.0')") as {
      matched: string[];
      toAdd: string[];
      toUpdate: string[];
      orphans: string[];
    };
    expect(diff.orphans).toEqual(['orphan']);
    expect(diff.matched).toEqual(['kept']);
    expect(diff.toAdd).toEqual([]);
  });
});
