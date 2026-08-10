import { describe, expect, test, beforeEach } from 'bun:test';
import { resolveAgentsBin, runAgents, clearAgentsBinCache, AgentsBinNotFoundError, bootstrapPath } from './agentsBin';

describe('agentsBin', () => {
  beforeEach(() => {
    clearAgentsBinCache();
  });

  test('resolveAgentsBin returns an absolute path that exists', async () => {
    // Slow zshrc files can push shell-based resolution past Bun's default 5s.

    const bin = await resolveAgentsBin();
    expect(bin.startsWith('/')).toBe(true);
    const fs = await import('fs');
    expect(fs.existsSync(bin)).toBe(true);
    expect(fs.statSync(bin).isFile()).toBe(true);
  });

  test('resolveAgentsBin caches across calls (same path)', async () => {
    const a = await resolveAgentsBin();
    const b = await resolveAgentsBin();
    expect(a).toBe(b);
  });

  test('runAgents executes the resolved binary and returns stdout', async () => {
    const { stdout } = await runAgents('--version', { timeout: 5_000 });
    // agents-cli prints something like "1.14.2"
    expect(/\d+\.\d+\.\d+/.test(stdout)).toBe(true);
  });

  test('runAgents passes args to the binary verbatim', async () => {
    const { stdout } = await runAgents('view --json', { timeout: 12_000, maxBuffer: 8 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test('bootstrapPath includes the binary directory and node fallbacks', () => {
    const aug = bootstrapPath('/Users/test/.nvm/versions/node/v22.0.0/bin/agents');
    expect(aug.includes('/Users/test/.nvm/versions/node/v22.0.0/bin')).toBe(true);
    expect(aug.includes('/usr/bin')).toBe(true);
    expect(aug.includes('/bin')).toBe(true);
  });

  test('AgentsBinNotFoundError carries a useful message', () => {
    const err = new AgentsBinNotFoundError();
    expect(err.message.includes('agents CLI not found')).toBe(true);
    expect(err.name).toBe('AgentsBinNotFoundError');
  });
});
