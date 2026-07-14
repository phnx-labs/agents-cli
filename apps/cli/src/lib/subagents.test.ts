import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installSubagentToAgent,
  listSubagentsForAgent,
  transformSubagentForAntigravity,
  transformSubagentForCopilot,
  transformSubagentForKiro,
} from './subagents.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-subagents-'));
  tempDirs.push(dir);
  return dir;
}

function makeTempHome(): string {
  return makeTempDir();
}

function makeSubagentDir(parent: string, name: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'AGENT.md'),
    `---\nname: ${name}\ndescription: Test ${name} agent\nmodel: gpt-4o\n---\n\nYou are the ${name} agent.\n`,
    'utf-8'
  );
  return dir;
}

function writeAgentMd(dir: string, body: string, extra?: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AGENT.md'), body, 'utf-8');
  if (extra) {
    for (const [name, content] of Object.entries(extra)) {
      fs.writeFileSync(path.join(dir, `${name}.md`), content, 'utf-8');
    }
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('transformSubagentForCopilot', () => {
  it('emits a Copilot CLI custom agent profile (.agent.md)', () => {
    const dir = makeSubagentDir(makeTempDir(), 'security-auditor');
    const output = transformSubagentForCopilot(dir);

    expect(output).toContain('name: security-auditor');
    expect(output).toContain('description: Test security-auditor agent');
    expect(output).toContain('model: gpt-4o');
    expect(output).toContain('You are the security-auditor agent.');
  });

  it('appends additional .md files as sections', () => {
    const parent = makeTempDir();
    const dir = makeSubagentDir(parent, 'reviewer');
    fs.writeFileSync(path.join(dir, 'NOTES.md'), 'Extra notes.', 'utf-8');

    const output = transformSubagentForCopilot(dir);
    expect(output).toContain('## Notes');
    expect(output).toContain('Extra notes.');
  });
});

describe('transformSubagentForKiro', () => {
  it('emits a Kiro custom-agent JSON with name, description, prompt, and tools', () => {
    const home = makeTempHome();
    const dir = path.join(home, 'subagent');
    writeAgentMd(dir, '---\nname: reviewer\ndescription: Reviews code changes\nmodel: claude-sonnet-4\n---\n\nYou are a careful code reviewer.');

    const json = transformSubagentForKiro(dir);
    const config = JSON.parse(json) as { name: string; description: string; prompt: string; tools: string[]; model: string };

    expect(config.name).toBe('reviewer');
    expect(config.description).toBe('Reviews code changes');
    expect(config.model).toBe('claude-sonnet-4');
    expect(config.prompt).toContain('You are a careful code reviewer.');
    expect(config.tools).toEqual(['read', 'write', 'shell', 'web_search', 'web_fetch']);
  });

  it('appends sibling .md files as sections in the prompt', () => {
    const home = makeTempHome();
    const dir = path.join(home, 'subagent');
    writeAgentMd(
      dir,
      '---\nname: writer\ndescription: Writes docs\n---\n\nYou write docs.',
      { style: 'Use short sentences.', examples: 'Example: ...' }
    );

    const json = transformSubagentForKiro(dir);
    const config = JSON.parse(json) as { prompt: string };

    expect(config.prompt).toContain('## Style');
    expect(config.prompt).toContain('Use short sentences.');
    expect(config.prompt).toContain('## Examples');
    expect(config.prompt).toContain('Example: ...');
  });
});

describe('transformSubagentForAntigravity', () => {
  it('emits a markdown custom-agent profile with local kind', () => {
    const home = makeTempHome();
    const dir = path.join(home, 'subagent');
    writeAgentMd(
      dir,
      '---\nname: planner\ndescription: Plans changes\nmodel: gemini-3-pro\n---\n\nYou plan implementation work.',
      { notes: 'Use file evidence.' }
    );

    const output = transformSubagentForAntigravity(dir);
    expect(output).toContain('name: planner');
    expect(output).toContain('description: Plans changes');
    expect(output).toContain('kind: local');
    expect(output).toContain('model: gemini-3-pro');
    expect(output).toContain('You plan implementation work.');
    expect(output).toContain('## Notes');
    expect(output).toContain('Use file evidence.');
  });
});

describe('installSubagentToAgent for Kiro', () => {
  it('writes a JSON custom-agent file to ~/.kiro/agents/', () => {
    const sourceHome = makeTempHome();
    const agentHome = makeTempHome();
    const dir = path.join(sourceHome, 'subagent');
    writeAgentMd(dir, '---\nname: tester\ndescription: Runs tests\n---\n\nYou run tests.');

    const result = installSubagentToAgent(dir, 'tester', 'kiro', agentHome);
    expect(result.success).toBe(true);

    const targetPath = path.join(agentHome, '.kiro', 'agents', 'tester.json');
    expect(fs.existsSync(targetPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as { name: string; prompt: string };
    expect(config.name).toBe('tester');
    expect(config.prompt).toContain('You run tests.');
  });

  it('lists installed Kiro subagents from JSON files', () => {
    const agentHome = makeTempHome();
    const agentsDir = path.join(agentHome, '.kiro', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'docbot.json'),
      JSON.stringify({ name: 'docbot', description: 'Docs bot', prompt: 'hi' }),
      'utf-8'
    );

    const installed = listSubagentsForAgent('kiro', agentHome);
    expect(installed.map(s => s.name)).toContain('docbot');
    expect(installed.find(s => s.name === 'docbot')?.frontmatter.description).toBe('Docs bot');
  });
});

describe('installSubagentToAgent for Antigravity', () => {
  it('writes markdown custom-agent files under ~/.gemini/config/agents/<name>/agent.md', () => {
    const sourceHome = makeTempHome();
    const agentHome = makeTempHome();
    const dir = path.join(sourceHome, 'subagent');
    writeAgentMd(dir, '---\nname: verifier\ndescription: Verifies work\n---\n\nYou verify work.');

    const result = installSubagentToAgent(dir, 'verifier', 'antigravity', agentHome);
    expect(result.success).toBe(true);

    const targetPath = path.join(agentHome, '.gemini', 'config', 'agents', 'verifier', 'agent.md');
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf-8')).toContain('kind: local');

    const installed = listSubagentsForAgent('antigravity', agentHome);
    expect(installed.map(s => s.name)).toEqual(['verifier']);
    expect(installed[0].frontmatter.description).toBe('Verifies work');
  });
});

describe('installSubagentToAgent for Gemini', () => {
  it('writes a markdown subagent file to ~/.gemini/agents/', () => {
    const sourceHome = makeTempHome();
    const agentHome = makeTempHome();
    const dir = path.join(sourceHome, 'subagent');
    writeAgentMd(dir, '---\nname: reviewer\ndescription: Reviews changes\n---\n\nReview the diff.');

    const result = installSubagentToAgent(dir, 'reviewer', 'gemini', agentHome);
    expect(result.success).toBe(true);

    const targetPath = path.join(agentHome, '.gemini', 'agents', 'reviewer.md');
    expect(fs.existsSync(targetPath)).toBe(true);
    const content = fs.readFileSync(targetPath, 'utf-8');
    expect(content).toContain('name: reviewer');
    expect(content).toContain('Review the diff.');

    const installed = listSubagentsForAgent('gemini', agentHome);
    expect(installed.map(s => s.name)).toContain('reviewer');
    expect(installed.find(s => s.name === 'reviewer')?.frontmatter.description).toBe('Reviews changes');
  });
});
