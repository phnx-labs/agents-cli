import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as state from '../state.js';
import { CommandsHandler } from './commands.js';

let tmpDir = '';
let projectAgentsDir = '';
let userAgentsDir = '';
let systemAgentsDir = '';
let handler: CommandsHandler;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-handler-test-'));
  projectAgentsDir = path.join(tmpDir, 'project', '.agents');
  userAgentsDir = path.join(tmpDir, 'user', '.agents');
  systemAgentsDir = path.join(tmpDir, 'system', '.agents');

  // Create commands directories in all layers
  for (const dir of [projectAgentsDir, userAgentsDir, systemAgentsDir]) {
    fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  }

  vi.spyOn(state, 'getProjectAgentsDir').mockReturnValue(projectAgentsDir);
  vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(userAgentsDir);
  vi.spyOn(state, 'getSystemAgentsDir').mockReturnValue(systemAgentsDir);
  vi.spyOn(state, 'getEnabledExtraRepos').mockReturnValue([]);

  handler = new CommandsHandler();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper to create a markdown command file with frontmatter. */
function writeCommandMd(dir: string, name: string, description: string, body: string): void {
  const content = `---
description: ${description}
---

${body}
`;
  fs.writeFileSync(path.join(dir, 'commands', `${name}.md`), content, 'utf-8');
}

/** Helper to create a TOML command file. */
function writeCommandToml(dir: string, name: string, description: string, prompt: string): void {
  const content = `name = "${name}"
description = "${description}"
prompt = '''
${prompt}
'''
`;
  fs.writeFileSync(path.join(dir, 'commands', `${name}.toml`), content, 'utf-8');
}

describe('CommandsHandler.listAll', () => {
  it('unions non-conflicting resources from all layers', () => {
    writeCommandMd(systemAgentsDir, 'system-only', 'System command', 'system body');
    writeCommandMd(userAgentsDir, 'user-only', 'User command', 'user body');
    writeCommandMd(projectAgentsDir, 'project-only', 'Project command', 'project body');

    const commands = handler.listAll('claude', tmpDir);

    expect(commands).toHaveLength(3);

    const names = commands.map((c) => c.name).sort();
    expect(names).toEqual(['project-only', 'system-only', 'user-only']);

    const projectCmd = commands.find((c) => c.name === 'project-only');
    expect(projectCmd?.layer).toBe('project');
    expect(projectCmd?.item.description).toBe('Project command');

    const userCmd = commands.find((c) => c.name === 'user-only');
    expect(userCmd?.layer).toBe('user');
    expect(userCmd?.item.description).toBe('User command');

    const systemCmd = commands.find((c) => c.name === 'system-only');
    expect(systemCmd?.layer).toBe('system');
    expect(systemCmd?.item.description).toBe('System command');
  });

  it('project beats user on name conflict', () => {
    writeCommandMd(userAgentsDir, 'shared', 'User version', 'user body');
    writeCommandMd(projectAgentsDir, 'shared', 'Project version', 'project body');

    const commands = handler.listAll('claude', tmpDir);

    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('shared');
    expect(commands[0].layer).toBe('project');
    expect(commands[0].item.description).toBe('Project version');
    expect(commands[0].path).toBe(path.join(projectAgentsDir, 'commands', 'shared.md'));
  });

  it('user beats system on name conflict', () => {
    writeCommandMd(systemAgentsDir, 'shared', 'System version', 'system body');
    writeCommandMd(userAgentsDir, 'shared', 'User version', 'user body');

    const commands = handler.listAll('claude', tmpDir);

    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('shared');
    expect(commands[0].layer).toBe('user');
    expect(commands[0].item.description).toBe('User version');
    expect(commands[0].path).toBe(path.join(userAgentsDir, 'commands', 'shared.md'));
  });

  it('project beats user beats system on three-way conflict', () => {
    writeCommandMd(systemAgentsDir, 'shared', 'System version', 'system body');
    writeCommandMd(userAgentsDir, 'shared', 'User version', 'user body');
    writeCommandMd(projectAgentsDir, 'shared', 'Project version', 'project body');

    const commands = handler.listAll('claude', tmpDir);

    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('shared');
    expect(commands[0].layer).toBe('project');
    expect(commands[0].item.description).toBe('Project version');
  });
});

describe('CommandsHandler.resolve', () => {
  it('returns project resource when same name exists in every layer', () => {
    writeCommandMd(systemAgentsDir, 'shared', 'System version', 'system body');
    writeCommandMd(userAgentsDir, 'shared', 'User version', 'user body');
    writeCommandMd(projectAgentsDir, 'shared', 'Project version', 'project body');

    const resolved = handler.resolve('claude', 'shared', tmpDir);

    expect(resolved).not.toBeNull();
    expect(resolved?.name).toBe('shared');
    expect(resolved?.layer).toBe('project');
    expect(resolved?.item.description).toBe('Project version');
    expect(resolved?.path).toBe(path.join(projectAgentsDir, 'commands', 'shared.md'));
  });

  it('falls back through layers and returns null when missing', () => {
    writeCommandMd(systemAgentsDir, 'system-only', 'System version', 'system body');
    writeCommandMd(userAgentsDir, 'user-only', 'User version', 'user body');

    const userCmd = handler.resolve('claude', 'user-only', tmpDir);
    expect(userCmd?.layer).toBe('user');
    expect(userCmd?.item.description).toBe('User version');

    const systemCmd = handler.resolve('claude', 'system-only', tmpDir);
    expect(systemCmd?.layer).toBe('system');
    expect(systemCmd?.item.description).toBe('System version');

    const missing = handler.resolve('claude', 'missing', tmpDir);
    expect(missing).toBeNull();
  });
});

describe('CommandsHandler.sync', () => {
  it('syncs .md format for claude', () => {
    writeCommandMd(userAgentsDir, 'test-cmd', 'Test description', 'Run $ARGUMENTS');

    const versionHome = path.join(tmpDir, 'version-home');
    fs.mkdirSync(versionHome, { recursive: true });

    handler.sync('claude', versionHome, tmpDir);

    const targetPath = path.join(versionHome, '.claude', 'commands', 'test-cmd.md');
    expect(fs.existsSync(targetPath)).toBe(true);

    const content = fs.readFileSync(targetPath, 'utf-8');
    expect(content).toContain('description: Test description');
    expect(content).toContain('$ARGUMENTS');
  });

  it('syncs .toml format for gemini (converts from .md)', () => {
    writeCommandMd(userAgentsDir, 'test-cmd', 'Test description', 'Run $ARGUMENTS');

    const versionHome = path.join(tmpDir, 'version-home');
    fs.mkdirSync(versionHome, { recursive: true });

    handler.sync('gemini', versionHome, tmpDir);

    const targetPath = path.join(versionHome, '.gemini', 'commands', 'test-cmd.toml');
    expect(fs.existsSync(targetPath)).toBe(true);

    const content = fs.readFileSync(targetPath, 'utf-8');
    expect(content).toContain('name = "test-cmd"');
    expect(content).toContain('description = "Test description"');
    // $ARGUMENTS should be converted to {{args}} for Gemini
    expect(content).toContain('{{args}}');
    expect(content).not.toContain('$ARGUMENTS');
  });

  it('syncs commands from all layers respecting precedence', () => {
    writeCommandMd(systemAgentsDir, 'system-only', 'System cmd', 'system body');
    writeCommandMd(userAgentsDir, 'user-only', 'User cmd', 'user body');
    writeCommandMd(projectAgentsDir, 'project-only', 'Project cmd', 'project body');
    // Conflict: project wins
    writeCommandMd(systemAgentsDir, 'shared', 'System shared', 'system shared body');
    writeCommandMd(projectAgentsDir, 'shared', 'Project shared', 'project shared body');

    const versionHome = path.join(tmpDir, 'version-home');
    fs.mkdirSync(versionHome, { recursive: true });

    handler.sync('claude', versionHome, tmpDir);

    const commandsDir = path.join(versionHome, '.claude', 'commands');
    const files = fs.readdirSync(commandsDir).sort();
    expect(files).toEqual(['project-only.md', 'shared.md', 'system-only.md', 'user-only.md']);

    // Verify shared has project content
    const sharedContent = fs.readFileSync(path.join(commandsDir, 'shared.md'), 'utf-8');
    expect(sharedContent).toContain('Project shared');
    expect(sharedContent).not.toContain('System shared');
  });
});

describe('CommandsHandler.format', () => {
  it('returns md for claude', () => {
    expect(handler.format('claude')).toBe('md');
  });

  it('returns md for codex', () => {
    expect(handler.format('codex')).toBe('md');
  });

  it('returns toml for gemini', () => {
    expect(handler.format('gemini')).toBe('toml');
  });

  it('returns md for cursor', () => {
    expect(handler.format('cursor')).toBe('md');
  });

  it('returns md for opencode', () => {
    expect(handler.format('opencode')).toBe('md');
  });
});

describe('CommandsHandler.targetDir', () => {
  it('returns commands for claude', () => {
    expect(handler.targetDir('claude')).toBe('commands');
  });

  it('returns prompts for codex', () => {
    expect(handler.targetDir('codex')).toBe('prompts');
  });

  it('returns commands for gemini', () => {
    expect(handler.targetDir('gemini')).toBe('commands');
  });
});
