import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { getAgentCommandPath, isAgentCommandInstalled, AgentCli } from './swarm.detect';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let tempHome: string;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-detect-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  if (fs.existsSync(tempHome)) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

function ext(agent: AgentCli): string {
  return agent === 'gemini' ? 'toml' : 'md';
}

describe('getAgentCommandPath', () => {
  (['claude', 'codex', 'gemini'] as AgentCli[]).forEach(agent => {
    test(`builds path for ${agent} using current home`, () => {
      const p = getAgentCommandPath(agent, 'plan');
      const expected = path.join(
        os.homedir(),
        agent === 'codex' ? '.codex' : agent === 'claude' ? '.claude' : '.gemini',
        agent === 'codex' ? 'prompts' : 'commands',
        `plan.${ext(agent)}`
      );
      expect(p).toBe(expected);
    });
  });
});

describe('isAgentCommandInstalled', () => {
  test('returns false for non-existent command', () => {
    const missing = `nonexistent-${Date.now()}`;
    expect(isAgentCommandInstalled('codex', missing)).toBe(false);
  });
});
