import { describe, test, expect } from 'bun:test';
import {
  BUILT_IN_AGENTS,
  getBuiltInByKey,
  getBuiltInByPrefix,
  getBuiltInDefByTitle,
  pickLatestVersion,
  STRATEGY_LAUNCH_AGENTS,
  modeFlagForAgent,
  buildAgentLaunchCommand,
  wrapNativeAgentCommand,
  extractPlanFromSessionJson,
  planTextToSteps
} from './agents';
import { CLAUDE_TITLE, CODEX_TITLE, GEMINI_TITLE, OPENCODE_TITLE, CURSOR_TITLE, SHELL_TITLE } from './utils';
import { CLI_AGENT_META, CliAgentId, isCliAgentId } from './agents.cli';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('BUILT_IN_AGENTS', () => {
  test('every non-shell built-in contributes and registers an Auto command', () => {
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8'));
    const contributed = new Set(packageJson.contributes.commands.map((entry: { command: string }) => entry.command));
    const extensionSource = readFileSync(resolve(import.meta.dir, '../vscode/extension.ts'), 'utf8');
    expect(extensionSource).toContain('`${def.commandId}Auto`');
    for (const agent of BUILT_IN_AGENTS) {
      if (agent.key === 'shell') continue;
      // Gemini is deprecated and no longer gets launch commands in the palette.
      if (agent.key === 'gemini') continue;
      expect(contributed.has(`${agent.commandId}Auto`)).toBe(true);
    }
  });

  test('every non-shell agent is a CLI agent and launches its CLI binary', () => {
    for (const agent of BUILT_IN_AGENTS) {
      if (agent.key === 'shell') continue;
      expect(isCliAgentId(agent.key)).toBe(true);
      expect(agent.command).toBe(CLI_AGENT_META[agent.key as CliAgentId].cliCommand);
    }
  });

  test('antigravity launches the CLI-canonical agy binary, not a phantom "antigravity"', () => {
    const ag = BUILT_IN_AGENTS.find(a => a.key === 'antigravity');
    expect(ag).toBeDefined();
    expect(ag!.command).toBe('agy');
  });

  test('kimi is presented with the KM chip and launches the kimi binary', () => {
    const kimi = BUILT_IN_AGENTS.find(a => a.key === 'kimi');
    expect(kimi).toBeDefined();
    expect(kimi!.title).toBe('KM');
    expect(kimi!.prefix).toBe('km');
    expect(kimi!.icon).toBe('kimi.png');
    expect(kimi!.command).toBe(CLI_AGENT_META['kimi'].cliCommand);
    expect(kimi!.commandId).toBe('agents.newKimi');
  });

  test('droid is presented with the DR chip and launches the droid binary', () => {
    const droid = BUILT_IN_AGENTS.find(a => a.key === 'droid');
    expect(droid).toBeDefined();
    expect(droid!.title).toBe('DR');
    expect(droid!.prefix).toBe('dr');
    expect(droid!.icon).toBe('droid.png');
    expect(droid!.command).toBe(CLI_AGENT_META['droid'].cliCommand);
    expect(droid!.commandId).toBe('agents.newDroid');
  });

  test('claude agent has correct properties', () => {
    const claude = BUILT_IN_AGENTS.find(a => a.key === 'claude');
    expect(claude).toBeDefined();
    expect(claude!.title).toBe(CLAUDE_TITLE);
    expect(claude!.command).toBe('claude');
    expect(claude!.prefix).toBe('cl');
    expect(claude!.commandId).toBe('agents.newClaude');
  });

  test('shell agent has correct properties', () => {
    const shell = BUILT_IN_AGENTS.find(a => a.key === 'shell');
    expect(shell).toBeDefined();
    expect(shell!.title).toBe(SHELL_TITLE);
    expect(shell!.command).toBe(''); // Shell has no command
    expect(shell!.prefix).toBe('sh');
    expect(shell!.commandId).toBe('agents.newShell');
  });

  test('all agents have required fields', () => {
    for (const agent of BUILT_IN_AGENTS) {
      expect(agent.key).toBeTruthy();
      expect(agent.title).toBeTruthy();
      // command can be empty for shell
      expect(agent.command).toBeDefined();
      expect(agent.icon).toMatch(/\.png$/);
      expect(agent.prefix).toBeTruthy();
      expect(agent.commandId).toMatch(/^agents\.new/);
    }
  });
});

describe('getBuiltInByKey', () => {
  test('returns claude agent', () => {
    const agent = getBuiltInByKey('claude');
    expect(agent).toBeDefined();
    expect(agent!.title).toBe(CLAUDE_TITLE);
  });

  test('returns codex agent', () => {
    const agent = getBuiltInByKey('codex');
    expect(agent).toBeDefined();
    expect(agent!.title).toBe(CODEX_TITLE);
  });

  test('returns gemini agent', () => {
    const agent = getBuiltInByKey('gemini');
    expect(agent).toBeDefined();
    expect(agent!.title).toBe(GEMINI_TITLE);
  });

  test('returns cursor agent', () => {
    const agent = getBuiltInByKey('cursor');
    expect(agent).toBeDefined();
    expect(agent!.title).toBe(CURSOR_TITLE);
  });

  test('returns opencode agent', () => {
    const agent = getBuiltInByKey('opencode');
    expect(agent).toBeDefined();
    expect(agent!.title).toBe(OPENCODE_TITLE);
  });

  test('returns undefined for unknown key', () => {
    const agent = getBuiltInByKey('unknown');
    expect(agent).toBeUndefined();
  });
});

describe('getBuiltInByPrefix', () => {
  test('returns claude for cc prefix', () => {
    const agent = getBuiltInByPrefix('cl');
    expect(agent).toBeDefined();
    expect(agent!.key).toBe('claude');
  });

  test('returns codex for cx prefix', () => {
    const agent = getBuiltInByPrefix('cx');
    expect(agent).toBeDefined();
    expect(agent!.key).toBe('codex');
  });

  test('returns gemini for gm prefix', () => {
    const agent = getBuiltInByPrefix('gm');
    expect(agent).toBeDefined();
    expect(agent!.key).toBe('gemini');
  });

  test('returns cursor for cr prefix', () => {
    const agent = getBuiltInByPrefix('cr');
    expect(agent).toBeDefined();
    expect(agent!.key).toBe('cursor');
  });

  test('returns opencode for oc prefix', () => {
    const agent = getBuiltInByPrefix('oc');
    expect(agent).toBeDefined();
    expect(agent!.key).toBe('opencode');
  });

  test('returns undefined for unknown prefix', () => {
    const agent = getBuiltInByPrefix('xx');
    expect(agent).toBeUndefined();
  });
});

describe('getBuiltInDefByTitle', () => {
  test('returns claude for CC title', () => {
    const agent = getBuiltInDefByTitle(CLAUDE_TITLE);
    expect(agent).toBeDefined();
    expect(agent!.key).toBe('claude');
  });

  test('returns codex for CX title', () => {
    const agent = getBuiltInDefByTitle(CODEX_TITLE);
    expect(agent).toBeDefined();
    expect(agent!.key).toBe('codex');
  });

  test('returns opencode for OC title', () => {
    const agent = getBuiltInDefByTitle(OPENCODE_TITLE);
    expect(agent).toBeDefined();
    expect(agent!.key).toBe('opencode');
  });

  test('returns undefined for unknown title', () => {
    const agent = getBuiltInDefByTitle('Unknown');
    expect(agent).toBeUndefined();
  });
});

describe('pickLatestVersion', () => {
  test('picks the highest semver regardless of input order', () => {
    expect(pickLatestVersion(['2.1.168', '2.1.170', '2.1.142'])).toBe('2.1.170');
  });

  test('compares segments numerically, not lexically', () => {
    // Lexical sort would wrongly pick "2.1.9" over "2.1.42".
    expect(pickLatestVersion(['2.1.9', '2.1.42'])).toBe('2.1.42');
    expect(pickLatestVersion(['0.43.0', '0.45.2', '0.42.0'])).toBe('0.45.2');
  });

  test('ignores non-semver profile names like yosemite/test-proxy', () => {
    expect(pickLatestVersion(['2.1.170', 'yosemite', 'test-proxy'])).toBe('2.1.170');
  });

  test('returns undefined when no semver-shaped entry exists', () => {
    expect(pickLatestVersion([])).toBeUndefined();
    expect(pickLatestVersion(['yosemite', 'proxy missing'])).toBeUndefined();
  });

  test('handles single-entry lists', () => {
    expect(pickLatestVersion(['1.0.6'])).toBe('1.0.6');
  });
});

describe('modeFlagForAgent', () => {
  // We launch via `agents run <agent>`, which owns `--mode plan|auto|edit` and
  // translates it per CLI. So the flag is agent-agnostic — NOT the raw
  // `--permission-mode`, which agents run would not forward.
  test('maps every mode to agents run --mode, for any agent', () => {
    expect(modeFlagForAgent('claude', 'plan')).toBe('--mode plan');
    expect(modeFlagForAgent('claude', 'auto')).toBe('--mode auto');
    expect(modeFlagForAgent('claude', 'edit')).toBe('--mode edit');
    // agent-agnostic: codex/gemini/unknown get the same universal flag.
    expect(modeFlagForAgent('codex', 'plan')).toBe('--mode plan');
    expect(modeFlagForAgent('gemini', 'edit')).toBe('--mode edit');
    expect(modeFlagForAgent('unknown', 'auto')).toBe('--mode auto');
  });
});

describe('extractPlanFromSessionJson', () => {
  test('extracts plan from CLI JSON output', () => {
    const json = JSON.stringify({
      session: { id: 'abc', plan: '1. First\n2. Second' },
      events: [],
    });
    expect(extractPlanFromSessionJson(json)).toBe('1. First\n2. Second');
  });

  test('returns null when session has no plan', () => {
    const json = JSON.stringify({
      session: { id: 'abc' },
      events: [],
    });
    expect(extractPlanFromSessionJson(json)).toBeNull();
  });

  test('returns null for empty/whitespace plan', () => {
    const json = JSON.stringify({
      session: { id: 'abc', plan: '   ' },
      events: [],
    });
    expect(extractPlanFromSessionJson(json)).toBeNull();
  });

  test('returns null for unparseable JSON', () => {
    expect(extractPlanFromSessionJson('not json')).toBeNull();
  });

  test('returns null for legacy bare-array format (no session wrapper)', () => {
    const json = JSON.stringify([{ type: 'message', content: 'hi' }]);
    expect(extractPlanFromSessionJson(json)).toBeNull();
  });
});

describe('planTextToSteps', () => {
  test('parses a numbered list, stripping markers and bold', () => {
    const steps = planTextToSteps('1. **Read** the file\n2. Edit it\n3. Test');
    expect(steps).toEqual([
      { n: 1, text: 'Read the file' },
      { n: 2, text: 'Edit it' },
      { n: 3, text: 'Test' },
    ]);
  });

  test('parses a bulleted list', () => {
    const steps = planTextToSteps('- do A\n- do B');
    expect(steps).toEqual([
      { n: 1, text: 'do A' },
      { n: 2, text: 'do B' },
    ]);
  });

  test('falls back to non-heading prose lines when no list markers exist', () => {
    const steps = planTextToSteps('# Plan\nFirst do this.\nThen do that.');
    expect(steps).toEqual([
      { n: 1, text: 'First do this.' },
      { n: 2, text: 'Then do that.' },
    ]);
  });
});

describe('STRATEGY_LAUNCH_AGENTS', () => {
  test('covers every auto-host harness with account/version health', () => {
    expect([...STRATEGY_LAUNCH_AGENTS]).toEqual([
      'claude', 'codex', 'gemini', 'opencode', 'cursor', 'antigravity', 'grok', 'kimi',
    ]);
  });

  test('every strategy-launch agent is a known built-in', () => {
    for (const key of STRATEGY_LAUNCH_AGENTS) {
      expect(getBuiltInByKey(key)).toBeDefined();
    }
  });
});

describe('buildAgentLaunchCommand', () => {
  // RUSH-2038: interactive Factory launches must default to --mode auto so the
  // agent starts in a writable posture instead of stalling in read-only plan mode.

  test('no mode supplied -> defaults to --mode auto', () => {
    const cmd = buildAgentLaunchCommand('codex', null);
    expect(cmd).toContain('--mode auto');
    expect(cmd).not.toContain('--mode plan');
  });

  test('no mode supplied for claude -> --mode auto', () => {
    const cmd = buildAgentLaunchCommand('claude', 'session-abc');
    expect(cmd).toContain('--mode auto');
    expect(cmd).toContain('--session-id session-abc');
  });

  test('explicit mode plan is preserved when the caller requests it', () => {
    const cmd = buildAgentLaunchCommand('codex', null, undefined, undefined, undefined, undefined, 'plan');
    expect(cmd).toContain('--mode plan');
    expect(cmd).not.toContain('--mode auto');
  });

  test('explicit mode edit is preserved', () => {
    const cmd = buildAgentLaunchCommand('gemini', null, undefined, undefined, undefined, undefined, 'edit');
    expect(cmd).toContain('--mode edit');
  });

  test('additionalFlags already containing --mode suppresses the default', () => {
    // Caller has injected --mode plan via additionalFlags; the function must not
    // double-emit another --mode flag.
    const cmd = buildAgentLaunchCommand('codex', null, undefined, '--mode plan');
    expect(cmd.match(/--mode/g)?.length).toBe(1);
    expect(cmd).toContain('--mode plan');
  });

  test('includes --interactive and the agent key in the base command', () => {
    const cmd = buildAgentLaunchCommand('codex', null);
    expect(cmd).toMatch(/^agents run codex --interactive/);
  });

  test('pinned version is appended as agent@version', () => {
    const cmd = buildAgentLaunchCommand('claude', null, undefined, undefined, '2.1.170');
    expect(cmd).toContain('claude@2.1.170');
  });

  test('host flag is shell-quoted and included', () => {
    const cmd = buildAgentLaunchCommand('codex', null, undefined, undefined, undefined, undefined, undefined, 'mac-mini');
    expect(cmd).toContain("--host 'mac-mini'");
  });

  test('remote host launch forwards the workspace cwd for CLI portability rewriting', () => {
    const cmd = buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, undefined, undefined, 'mac-mini', false, '/Users/muqsit/src/agents-cli',
    );
    expect(cmd).toContain("--host 'mac-mini'");
    expect(cmd).toContain("--cwd '/Users/muqsit/src/agents-cli'");
  });

  test('local launch does not emit an explicit cwd', () => {
    const cmd = buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, undefined, undefined, undefined, false, '/Users/muqsit/src/agents-cli',
    );
    expect(cmd).not.toContain('--cwd');
  });

  test('default model is included when provided', () => {
    const cmd = buildAgentLaunchCommand('claude', null, 'claude-haiku-4-5');
    expect(cmd).toContain('--model claude-haiku-4-5');
  });

  // RUSH-2025: Pick Host / Auto Host / New Claude (Auto) launch with BOTH a host
  // and --strategy balanced so the CLI's account rotation routes around a
  // signed-out / throttled version on the chosen device.
  test('balanced strategy + host emit --host and --strategy balanced together', () => {
    const cmd = buildAgentLaunchCommand(
      'claude', 'sess-1', undefined, undefined, undefined, 'balanced', undefined, 'yosemite-s0',
    );
    expect(cmd).toContain("--host 'yosemite-s0'");
    expect(cmd).toContain('--strategy balanced');
  });

  test('explicit local launch suppresses automatic device selection', () => {
    expect(buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, 'balanced', undefined, undefined, true,
    )).toBe('agents run codex --interactive --strategy balanced --mode auto');
  });

  test('a pinned version on a host launch suppresses --strategy (pin overrides balance)', () => {
    // Pick Version & Host: the exact pin wins, so no --strategy is emitted even
    // if a strategy is passed.
    const cmd = buildAgentLaunchCommand(
      'claude', 'sess-2', undefined, undefined, '2.1.170', 'balanced', undefined, 'yosemite-s1',
    );
    expect(cmd).toContain('claude@2.1.170');
    expect(cmd).toContain("--host 'yosemite-s1'");
    expect(cmd).not.toContain('--strategy');
  });
});

describe('wrapNativeAgentCommand (RUSH-2026)', () => {
  // The exec prefix makes the shell replace itself with the agent runner so VS
  // Code closes the tab automatically when the agent exits — mirroring tmux
  // pane-died behaviour.

  test('agent terminal: command is exec-prefixed', () => {
    const cmd = buildAgentLaunchCommand('claude', null);
    expect(wrapNativeAgentCommand(cmd, false)).toBe(`exec ${cmd}`);
  });

  test('agent terminal with --host: exec prefix is preserved', () => {
    const cmd = buildAgentLaunchCommand('claude', null, undefined, undefined, undefined, undefined, undefined, 'yosemite-s0');
    const wrapped = wrapNativeAgentCommand(cmd, false);
    expect(wrapped).toMatch(/^exec agents run claude --interactive/);
    expect(wrapped).toContain("--host 'yosemite-s0'");
  });

  test('shell terminal: command is NOT exec-prefixed', () => {
    const shellCmd = 'zsh';
    expect(wrapNativeAgentCommand(shellCmd, true)).toBe(shellCmd);
    expect(wrapNativeAgentCommand(shellCmd, true)).not.toMatch(/^exec /);
  });

  test('empty command returns empty string unchanged', () => {
    expect(wrapNativeAgentCommand('', false)).toBe('');
    expect(wrapNativeAgentCommand('', true)).toBe('');
  });
});
