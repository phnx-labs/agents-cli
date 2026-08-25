import { describe, expect, it } from 'vitest';
import {
  extractBackgroundShells,
  harnessTracksBackgroundShells,
  isSubAgentTool,
} from './highlights.js';
import type { SessionAgentId, SessionEvent } from './types.js';

/**
 * RUSH-3091/3095. Background-shell detection is per-harness, and the shapes are
 * NOT interchangeable — claude/kimi flag it on a `Bash` call, grok on a
 * `run_terminal_command`. Verified against real transcripts on the fleet before
 * this table was written; codex/droid carry no marker in any of their session
 * files and cursor persists no tool calls locally at all.
 */
function toolUse(agent: SessionAgentId, tool: string, args: Record<string, unknown>): SessionEvent {
  return { type: 'tool_use', agent, timestamp: '2026-08-23T00:00:00.000Z', tool, args };
}

describe('extractBackgroundShells — per harness', () => {
  it('detects the claude/kimi shape (Bash + run_in_background)', () => {
    for (const agent of ['claude', 'kimi'] as SessionAgentId[]) {
      const events = [
        toolUse(agent, 'Bash', { command: 'sleep 60', run_in_background: true }),
        toolUse(agent, 'Bash', { command: 'ls', run_in_background: false }),
        toolUse(agent, 'Bash', { command: 'pwd' }),
      ];
      const shells = extractBackgroundShells(events);
      expect(shells).toHaveLength(1);
      expect(shells[0]?.command).toBe('sleep 60');
    }
  });

  it('detects the grok shape (run_terminal_command + background)', () => {
    const events = [
      toolUse('grok', 'run_terminal_command', { command: 'gh pr checks --watch', background: true }),
      toolUse('grok', 'run_terminal_command', { command: 'git status' }),
      // grok's flag on a Bash call is not grok's shape — must not match.
      toolUse('grok', 'Bash', { command: 'sleep 5', run_in_background: true }),
    ];
    const shells = extractBackgroundShells(events);
    expect(shells).toHaveLength(1);
    expect(shells[0]?.command).toBe('gh pr checks --watch');
  });

  it('reports ABSENCE, not zero, for a harness that cannot record it', () => {
    // The distinction the renders depend on: codex has no background concept, so
    // "0 background shells" would assert "none running" where the truth is
    // "unknown". harnessTracksBackgroundShells is what callers gate on.
    expect(harnessTracksBackgroundShells('codex')).toBe(false);
    expect(harnessTracksBackgroundShells('cursor')).toBe(false);
    expect(harnessTracksBackgroundShells('droid')).toBe(false);
    expect(harnessTracksBackgroundShells('claude')).toBe(true);
    expect(harnessTracksBackgroundShells('kimi')).toBe(true);
    expect(harnessTracksBackgroundShells('grok')).toBe(true);

    // A codex transcript carrying a lookalike flag still yields nothing.
    const events = [toolUse('codex', 'exec_command', { cmd: 'sleep 60', run_in_background: true })];
    expect(extractBackgroundShells(events)).toHaveLength(0);
  });

  it('ignores local (`!`-prefix) tool events', () => {
    const e = toolUse('claude', 'Bash', { command: 'sleep 60', run_in_background: true });
    expect(extractBackgroundShells([{ ...e, _local: true }])).toHaveLength(0);
  });
});

describe('isSubAgentTool — counts both fan-out shapes', () => {
  it('counts in-process Agent/Task calls', () => {
    expect(isSubAgentTool('Agent', '')).toBe(true);
    expect(isSubAgentTool('Task', '')).toBe(true);
    expect(isSubAgentTool('Bash', 'ls -la')).toBe(false);
  });

  it('counts shelled-out agent spawns', () => {
    expect(isSubAgentTool('Bash', 'agents run claude "fix it"')).toBe(true);
    expect(isSubAgentTool('Bash', 'agents teams add my-team codex "…"')).toBe(true);
    expect(isSubAgentTool('Bash', 'agents cloud run claude "…"')).toBe(true);
    // Not a spawn: reading about agents, or another agents subcommand.
    expect(isSubAgentTool('Bash', 'agents sessions --active')).toBe(false);
  });
});
