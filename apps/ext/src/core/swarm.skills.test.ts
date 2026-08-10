import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tempDir: string;
let fakeExtensionPath: string;

function makeTarget(agent: 'claude' | 'codex' | 'gemini' | 'cursor', command: string): string {
  const ext = agent === 'gemini' ? 'toml' : 'md';
  return path.join(tempDir, `${agent}-${command}.${ext}`);
}

// installSkillCommand reads its source asset from
// `<extensionPath>/../prompts/<agent>/<dir>/<asset>`. The prompts/ tree is a
// sibling repo, not bundled with the extension, so a clean check-out won't
// have it. Stage a minimal fake tree inside tempDir and point extensionPath
// at tempDir/ext so the resolved source lands inside our sandbox.
function stagePromptAsset(agent: 'codex' | 'claude' | 'gemini' | 'cursor', assetName: string): void {
  const agentDir = agent === 'codex' ? 'prompts' : 'commands';
  const dir = path.join(tempDir, 'prompts', agent, agentDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, assetName), '# fake skill asset for test');
}

function setupMocks() {
  mock.module('./swarm.detect', () => {
    return {
      getAgentCommandPath: (agent: 'claude' | 'codex' | 'gemini', command = 'swarm') =>
        makeTarget(agent, command),
      getPromptPackCommandPath: (agent: 'claude' | 'codex' | 'gemini' | 'cursor', command = 'swarm') =>
        makeTarget(agent, command),
      isAgentCliAvailable: async () => true,
      isAgentMcpEnabled: async () => true,
      isAgentCommandInstalled: (agent: 'claude' | 'codex' | 'gemini', command = 'swarm') =>
        fs.existsSync(makeTarget(agent, command)),
      isPromptPackTargetAvailable: async () => true,
      isPromptPackInstalled: (agent: 'claude' | 'codex' | 'gemini' | 'cursor', command = 'swarm') =>
        fs.existsSync(makeTarget(agent, command)),
      isAgentsCliAvailable: async () => true,
      getAgentsCliVersion: async () => '0.0.0-test',
    };
  });

  mock.module('vscode', () => ({
    window: {
      showWarningMessage: () => {},
      showErrorMessage: () => {},
      showInformationMessage: () => {},
    },
    env: {},
    commands: { executeCommand: () => {} },
  }));
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-status-'));
  fakeExtensionPath = path.join(tempDir, 'ext');
  fs.mkdirSync(fakeExtensionPath, { recursive: true });
});

afterEach(() => {
  mock.restore();
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('skills status and install', () => {
  test('marks builtin claude skills as installed and others missing', async () => {
    setupMocks();
    const mod = await import('../vscode/swarm.vscode');
    const status = await mod.getSkillsStatus();

    const plan = status.commands.find(c => c.name === 'plan');
    expect(plan).toBeDefined();
    expect(plan?.agents.claude.installed).toBe(true);
    expect(plan?.agents.claude.builtIn).toBe(true);
    expect(plan?.agents.claude.supported).toBe(true);
    expect(plan?.agents.codex.installed).toBe(false);
    expect(plan?.agents.gemini.installed).toBe(false);
    expect(plan?.agents.cursor.installed).toBe(false);
    expect(plan?.agents.cursor.supported).toBe(false);
  });

  test('installSkillCommand writes the file and flips status', async () => {
    setupMocks();
    stagePromptAsset('codex', 'plan.md');
    const mod = await import('../vscode/swarm.vscode');
    const ctx = { extensionPath: fakeExtensionPath } as any;

    const target = makeTarget('codex', 'plan');
    expect(fs.existsSync(target)).toBe(false);

    const ok = await mod.installSkillCommand('plan', 'codex', ctx);
    expect(ok).toBe(true);
    expect(fs.existsSync(target)).toBe(true);

    const status = await mod.getSkillsStatus();
    const plan = status.commands.find(c => c.name === 'plan');
    expect(plan?.agents.codex.installed).toBe(true);
  });
});
