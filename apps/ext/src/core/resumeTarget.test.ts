import { describe, it, expect } from 'bun:test';
import { buildHarnessOptions } from './resumeTarget';
import { buildAgentRunLaunchCommand } from './resumeInBest';
import type { AgentInventory } from './agentInventory';

const AGENTS = [
  { key: 'claude', title: 'Claude' },
  { key: 'codex', title: 'Codex' },
  { key: 'grok', title: 'Grok' },
  { key: 'shell', title: 'Shell' },
];

function inventory(over: Partial<AgentInventory> = {}): AgentInventory {
  return {
    agent: 'codex',
    strategy: 'balanced',
    defaultVersion: null,
    defaultAccount: null,
    defaultPlan: null,
    signedInCount: 0,
    healthyCount: 0,
    canRotate: false,
    versions: [],
    ...over,
  };
}

describe('buildHarnessOptions', () => {
  it('excludes the shell and the harness the session already runs in', () => {
    const out = buildHarnessOptions(AGENTS, {}, 'claude');
    expect(out.map(o => o.agent)).toEqual(['codex', 'grok']);
  });

  it('ranks healthy installs first, then signed-in, then name', () => {
    const out = buildHarnessOptions(AGENTS, {
      grok: inventory({ agent: 'grok', signedInCount: 2, healthyCount: 1 }),
      codex: inventory({ agent: 'codex', signedInCount: 1, healthyCount: 0 }),
    }, 'claude');
    expect(out.map(o => o.agent)).toEqual(['grok', 'codex']);
  });

  it('still lists every other harness when the inventory is unknown (offloaded session)', () => {
    const out = buildHarnessOptions(AGENTS, {}, undefined);
    expect(out.map(o => o.agent)).toEqual(['claude', 'codex', 'grok']);
    expect(out.every(o => o.signedInCount === 0 && o.healthyCount === 0)).toBe(true);
  });
});

describe('buildAgentRunLaunchCommand', () => {
  it('runs the target harness unpinned so balanced rotation picks the account', () => {
    expect(buildAgentRunLaunchCommand('codex')).toBe('agents run codex --interactive');
  });

  it('stays on the session device when one is given', () => {
    expect(buildAgentRunLaunchCommand('codex', 'mac-mini')).toBe(
      "agents run codex --interactive --host 'mac-mini'",
    );
  });

  it('pins the new session id only for claude', () => {
    expect(buildAgentRunLaunchCommand('claude', undefined, 'uuid-1')).toBe(
      'agents run claude --interactive --session-id uuid-1',
    );
    expect(buildAgentRunLaunchCommand('codex', undefined, 'uuid-1')).toBe(
      'agents run codex --interactive',
    );
  });
});
