import * as fs from 'fs';
import * as path from 'path';
import { describe, test, expect } from 'bun:test';
import {
  BUILT_IN_AGENTS,
  getBuiltInByKey,
  getBuiltInByPrefix,
  getBuiltInDefByTitle,
  pickLatestVersion,
  isAgentRunner,
  usesManagedAgentLaunch,
  modeFlagForAgent,
  buildAgentLaunchCommand,
  wrapNativeAgentCommand,
  extractPlanFromSessionJson,
  planTextToSteps
} from './agents';
import { CLAUDE_TITLE, CODEX_TITLE, GEMINI_TITLE, OPENCODE_TITLE, CURSOR_TITLE, SHELL_TITLE, getIconFilename } from './utils';
import { CLI_AGENT_META, CliAgentId, isCliAgentId } from './agents.cli';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

describe('BUILT_IN_AGENTS', () => {
  test('every non-shell built-in contributes and registers an Auto command', () => {
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8'));
    const contributed = new Set(packageJson.contributes.commands.map((entry: { command: string }) => entry.command));
    const extensionSource = readFileSync(resolve(import.meta.dir, '../vscode/extension.ts'), 'utf8');
    expect(extensionSource).toContain('harnessLaunchRegistrations(');
    for (const agent of BUILT_IN_AGENTS) {
      if (agent.key === 'shell') continue;
      // Gemini is deprecated and no longer gets launch commands in the palette.
      if (agent.key === 'gemini') continue;
      expect(contributed.has(`${agent.commandId}Auto`)).toBe(true);
    }
  });

  test('deprecated Gemini launch and setup commands are not contributed', () => {
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8'));
    const contributed = new Set(packageJson.contributes.commands.map((entry: { command: string }) => entry.command));
    const extensionSource = readFileSync(resolve(import.meta.dir, '../vscode/extension.ts'), 'utf8');
    expect(contributed.has('agents.newGemini')).toBe(false);
    expect(contributed.has('agents.newGeminiPickHost')).toBe(false);
    expect(contributed.has('agents.newGeminiAuto')).toBe(false);
    expect(contributed.has('agents.setupGemini')).toBe(false);
    expect(extensionSource).not.toContain("agents.setupGemini");
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

// Base transport contract: every harness is managed by `agents run`; callers
// explicitly choose either automatic balanced rotation or the account picker.
describe('launch contract — every runner uses the managed launch builder', () => {
  // Every built-in that is an agent runner (i.e. not the Shell terminal).
  const RUNNERS = BUILT_IN_AGENTS.map(a => a.key).filter(k => k !== 'shell');

  test('isAgentRunner is true for every runner and false only for shell', () => {
    for (const key of RUNNERS) expect(isAgentRunner(key)).toBe(true);
    expect(isAgentRunner('shell')).toBe(false);
    // Includes the harnesses that used to launch as raw binaries locally.
    expect(isAgentRunner('grok')).toBe(true);
    expect(isAgentRunner('kimi')).toBe(true);
    expect(isAgentRunner('droid')).toBe(true);
  });

  test('usesManagedAgentLaunch routes every runner through agents run, never shell', () => {
    for (const key of RUNNERS) expect(usesManagedAgentLaunch(key)).toBe(true);
    expect(usesManagedAgentLaunch('shell')).toBe(false);
    // A host target does not make shell an `agents run` agent (it has none).
    expect(usesManagedAgentLaunch('shell', 'yosemite-s1')).toBe(false);
  });

  test('every runner supports balanced selection on local, auto, and explicit-host targets', () => {
    for (const key of RUNNERS) {
      // Automatic account selection, local target.
      expect(buildAgentLaunchCommand(
        key, null, undefined, undefined, undefined, 'balanced', undefined, { local: true },
      )).toBe(`agents run ${key} --interactive --strategy balanced --mode auto`);
      // Automatic account selection and automatic device placement.
      expect(buildAgentLaunchCommand(
        key, null, undefined, undefined, undefined, 'balanced', undefined, {},
      )).toBe(`agents run ${key} --interactive --device auto --strategy balanced --mode auto`);
      // Automatic account selection on an explicit device.
      expect(buildAgentLaunchCommand(
        key, null, undefined, undefined, undefined, 'balanced', undefined, { host: 'yosemite-s1' },
      )).toBe(`agents run ${key} --interactive --device 'yosemite-s1' --strategy balanced --mode auto`);
    }
  });

  test('a pinned @version is the one launch that omits --strategy (CLI ignores it against a pin)', () => {
    expect(buildAgentLaunchCommand(
      'claude', null, undefined, undefined, '1.2.3', 'balanced', undefined, { local: true },
    )).toBe('agents run claude@1.2.3 --interactive --mode auto');
  });

  test('account picker keeps automatic placement but omits balanced account selection', () => {
    expect(buildAgentLaunchCommand(
      'claude', null, undefined, undefined, undefined, undefined, undefined,
      { accountPicker: true },
    )).toBe('agents run claude@ --interactive --device auto --mode auto');
  });

  test('account picker follows an explicitly picked host', () => {
    expect(buildAgentLaunchCommand(
      'claude', null, undefined, undefined, undefined, undefined, undefined,
      { host: 'yosemite-s0', accountPicker: true },
    )).toBe("agents run claude@ --interactive --device 'yosemite-s0' --mode auto");
  });

  test('account picker rejects a version pin or automatic strategy', () => {
    expect(() => buildAgentLaunchCommand(
      'claude', null, undefined, undefined, '2.1.238', undefined, undefined,
      { accountPicker: true },
    )).toThrow('cannot combine an account picker with a pinned version');
    expect(() => buildAgentLaunchCommand(
      'claude', null, undefined, undefined, undefined, 'balanced', undefined,
      { accountPicker: true },
    )).toThrow('cannot combine an account picker with an automatic strategy');
  });

  test('grok (Pick Host) never emits cursor-agent', () => {
    const cmd = buildAgentLaunchCommand(
      'grok', null, undefined, undefined, undefined, 'balanced', undefined, { host: 'yosemite-s1' },
    );
    expect(cmd).toBe("agents run grok --interactive --device 'yosemite-s1' --strategy balanced --mode auto");
    expect(cmd).not.toContain('cursor-agent');
  });
});

describe('buildAgentLaunchCommand', () => {
  // RUSH-2038: interactive AGI EXT launches must default to --mode auto so the
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
    const cmd = buildAgentLaunchCommand('codex', null, undefined, undefined, undefined, undefined, undefined, { host: 'mac-mini' });
    expect(cmd).toContain("--device 'mac-mini'");
  });

  test('ordinary remote launch sends a local Mac workspace as portable --cwd', () => {
    const cmd = buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, undefined, undefined,
      { host: 'linux-box', cwd: '/Users/muqsit/src/agents-cli' },
    );
    expect(cmd).toContain("--device 'linux-box'");
    expect(cmd).toContain("--cwd '/Users/muqsit/src/agents-cli'");
    expect(cmd).not.toContain('--remote-cwd');
  });

  test('picked remote session uses exact --remote-cwd and never portable --cwd', () => {
    const cmd = buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, undefined, undefined,
      { host: 'linux-box', remoteCwd: '/srv/exact repo' },
    );
    expect(cmd).toContain("--remote-cwd '/srv/exact repo'");
    expect(cmd).not.toContain(" --cwd ");
  });

  test('rejects an ambiguous remote target with both cwd forms', () => {
    expect(() => buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, undefined, undefined,
      { host: 'linux-box', cwd: '/Users/muqsit/src', remoteCwd: '/srv/exact' },
    )).toThrow('cannot combine portable cwd with exact remoteCwd');
  });

  // RUSH-2487: a matched project owns the working directory end-to-end — the
  // CLI's resolveRunCwd (exec.ts) hard-exits on --project + --cwd/--remote-cwd,
  // so buildAgentLaunchCommand must never emit that combination either.
  test('a local launch with a matched project emits --project and no cwd flag', () => {
    const cmd = buildAgentLaunchCommand(
      'claude', null, undefined, undefined, undefined, undefined, undefined,
      { local: true, project: 'agents-cli' },
    );
    expect(cmd).toContain("--project 'agents-cli'");
    expect(cmd).not.toContain('--cwd');
    expect(cmd).not.toContain('--device');
  });

  test('a device-auto launch with a matched project emits --device auto and --project together', () => {
    const cmd = buildAgentLaunchCommand(
      'claude', null, undefined, undefined, undefined, undefined, undefined,
      { project: 'agents-cli' },
    );
    expect(cmd).toContain('--device auto');
    expect(cmd).toContain("--project 'agents-cli'");
  });

  test('a picked-host launch with a matched project emits --device and --project, never --cwd', () => {
    const cmd = buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, undefined, undefined,
      { host: 'mac-mini', project: 'agents-cli' },
    );
    expect(cmd).toContain("--device 'mac-mini'");
    expect(cmd).toContain("--project 'agents-cli'");
    expect(cmd).not.toContain('--cwd');
    expect(cmd).not.toContain('--remote-cwd');
  });

  test('rejects a project target combined with portable cwd', () => {
    expect(() => buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, undefined, undefined,
      { host: 'linux-box', cwd: '/Users/muqsit/src', project: 'agents-cli' },
    )).toThrow('cannot combine project with cwd or remoteCwd');
  });

  test('rejects a project target combined with exact remoteCwd', () => {
    expect(() => buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, undefined, undefined,
      { host: 'linux-box', remoteCwd: '/srv/exact', project: 'agents-cli' },
    )).toThrow('cannot combine project with cwd or remoteCwd');
  });

  test('default model is included when provided', () => {
    const cmd = buildAgentLaunchCommand('claude', null, 'claude-haiku-4-5');
    expect(cmd).toContain('--model claude-haiku-4-5');
  });

  // RUSH-2025: Pick Host / Auto Host / New Claude (Auto) launch with BOTH a host
  // and --strategy balanced so the CLI's account rotation routes around a
  // signed-out / throttled version on the chosen device.
  test('balanced strategy + host emit --device and --strategy balanced together', () => {
    const cmd = buildAgentLaunchCommand(
      'claude', 'sess-1', undefined, undefined, undefined, 'balanced', undefined, { host: 'yosemite-s0' },
    );
    expect(cmd).toContain("--device 'yosemite-s0'");
    expect(cmd).toContain('--strategy balanced');
  });

  test('explicit local launch suppresses automatic device selection', () => {
    expect(buildAgentLaunchCommand(
      'codex', null, undefined, undefined, undefined, 'balanced', undefined, { local: true },
    )).toBe('agents run codex --interactive --strategy balanced --mode auto');
  });

  test('a pinned version on a host launch suppresses --strategy (pin overrides balance)', () => {
    // Pick Version & Host: the exact pin wins, so no --strategy is emitted even
    // if a strategy is passed.
    const cmd = buildAgentLaunchCommand(
      'claude', 'sess-2', undefined, undefined, '2.1.170', 'balanced', undefined, { host: 'yosemite-s1' },
    );
    expect(cmd).toContain('claude@2.1.170');
    expect(cmd).toContain("--device 'yosemite-s1'");
    expect(cmd).not.toContain('--strategy');
  });
});

describe('wrapNativeAgentCommand (RUSH-2593)', () => {
  // The wrapped command exits the shell (closing the VS Code tab) on a clean
  // exit, mirroring tmux pane-died behaviour, but leaves the shell running
  // with a readable status line when the launch itself fails — so a bad
  // remote/host launch doesn't close the tab before the error can be read.

  test('agent terminal: command is followed by an exit-code gate, not exec-replaced', () => {
    const cmd = buildAgentLaunchCommand('claude', null);
    const wrapped = wrapNativeAgentCommand(cmd, false);
    expect(wrapped.startsWith('exec ')).toBe(false);
    expect(wrapped).toContain(cmd);
    expect(wrapped).toContain('ec=$?');
    expect(wrapped).toContain('exit 0');
  });

  test('agent terminal with --device: exit-code gate wraps the full --device command', () => {
    const cmd = buildAgentLaunchCommand('claude', null, undefined, undefined, undefined, undefined, undefined, { host: 'yosemite-s0' });
    const wrapped = wrapNativeAgentCommand(cmd, false);
    expect(wrapped.startsWith('exec ')).toBe(false);
    expect(wrapped).toMatch(/^agents run claude --interactive/);
    expect(wrapped).toContain("--device 'yosemite-s0'");
    expect(wrapped).toContain('ec=$?');
  });

  test('shell terminal: command is returned unwrapped', () => {
    const shellCmd = 'zsh';
    expect(wrapNativeAgentCommand(shellCmd, true)).toBe(shellCmd);
    expect(wrapNativeAgentCommand(shellCmd, true)).not.toContain('ec=$?');
  });

  test('empty command returns empty string unchanged', () => {
    expect(wrapNativeAgentCommand('', false)).toBe('');
    expect(wrapNativeAgentCommand('', true)).toBe('');
  });

  // Real-shell contract test (no mocking): run the wrapped command through an
  // actual bash, standing a real exit-0 / exit-nonzero command in for the
  // agent runner, and assert on what bash actually does — not on a guess
  // about shell semantics.
  test('real bash: a clean exit (0) does not print the kept-open message', () => {
    const wrapped = wrapNativeAgentCommand('true', false);
    // execFileSync spawns bash directly with argv — no outer shell to
    // re-interpret the `$?`/`$ec` inside `wrapped` before bash ever sees it.
    const out = execFileSync('bash', ['-c', wrapped], { encoding: 'utf8' });
    expect(out).not.toContain('Agent exited with status');
  });

  test('real bash: a nonzero exit prints a human-readable status line and the shell keeps running past it', () => {
    // A subshell that exits 7, standing in for a failed `agents run …` launch.
    // (A bare `exit 7` would terminate bash -c's own shell instead of just
    // returning a status, which isn't what a failed subprocess launch does.)
    const wrapped = wrapNativeAgentCommand(`bash -c 'exit 7'`, false);
    // The wrapped command never itself invokes an outer `exit` on the failure
    // branch, so appending a marker after it proves the script kept executing
    // instead of the process dying with the agent (RUSH-2593's actual bug).
    const out = execFileSync('bash', ['-c', `${wrapped}; echo MARKER_REACHED`], { encoding: 'utf8' });
    expect(out).toContain('Agent exited with status 7');
    expect(out).toContain('MARKER_REACHED');
  });
});

describe('extension tmux removal — spawn command contract', () => {
  test('a new spawn sends only agents run, with no tmux wrapper', () => {
    for (const key of ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'antigravity', 'grok', 'kimi', 'droid'] as const) {
      const cmd = wrapNativeAgentCommand(
        buildAgentLaunchCommand(key, null, undefined, undefined, undefined, 'balanced', undefined, { local: true }),
        false,
      );
      expect(cmd).toMatch(/^agents run /);
      expect(cmd).toContain('--interactive');
      expect(cmd).not.toContain('tmux');
      expect(cmd).not.toContain('agents tmux');
      expect(cmd).not.toContain('\n');
    }
  });
});

describe('agent tab icons', () => {
  test('every built-in agent resolves an icon that actually ships in assets/', () => {
    const assetsDir = path.join(import.meta.dir, '..', '..', 'assets');
    for (const def of BUILT_IN_AGENTS) {
      const file = getIconFilename(def.title);
      expect(file, `${def.key}: no icon mapped for title '${def.title}'`).toBeTruthy();
      expect(file).toBe(def.icon);
      expect(
        fs.existsSync(path.join(assetsDir, file!)),
        `${def.key}: '${file}' is mapped but missing from assets/`,
      ).toBe(true);
    }
  });

  test('launchAgent resolves an iconPath at createTerminal time', () => {
    // Reproduces the regression from e2bf3f502 (#2534): launchAgent replaced its
    // openSingleAgent delegation with a bare createTerminal that passed no
    // iconPath, so every `New <Agent>` tab showed the generic terminal glyph.
    // iconPath is frozen at createTerminal() time — there is no setter, and shell
    // adoption only rewrites the internal registry — so if it is not set here it
    // can never be recovered.
    const src = readFileSync(resolve(import.meta.dir, '../vscode/extension.ts'), 'utf8');
    const start = src.indexOf('async function launchAgent');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toContain('createTerminal(');
    // Mutation-resistant on purpose: a bare `toContain('iconPath')` passes even
    // for `iconPath: undefined` AND for the buildIconPath(def.prefix, ...) trap
    // below, i.e. it cannot fail on the regression it exists to catch. Pin the
    // resolved value, and forbid the prefix-keyed lookup outright.
    expect(body).toMatch(/iconPath:\s*agentConfig\.iconPath/);
    expect(body).not.toMatch(/buildIconPath\(/);
    // Registration must not be conditional on knowing the agent: an automatic
    // launch (agents.newAgent) has no agentKey and must still be registered.
    expect(body).toMatch(/await registerAgentTerminal\(terminal, context, \{/);
    expect(body).not.toMatch(/if \(agentConfig && terminalId\)/);
  });

  test('the icon table is keyed by TITLE, never by the lowercase prefix', () => {
    // Regression guard. buildIconPath()'s parameter is named `prefix`, but the
    // lookup table is keyed by TITLE ('CC', 'GK') while def.prefix is the
    // lowercase id ('cl', 'gk'). Passing a prefix silently yields null, and a
    // terminal created with a null iconPath keeps the generic glyph forever —
    // iconPath is frozen at createTerminal() time and has no setter.
    for (const def of BUILT_IN_AGENTS) {
      expect(getIconFilename(def.title), `${def.key}: title should resolve`).toBeTruthy();
      expect(getIconFilename(def.prefix), `${def.key}: prefix must NOT resolve`).toBeNull();
    }
  });
});
