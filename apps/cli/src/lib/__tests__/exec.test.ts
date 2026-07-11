import { describe, it, expect } from 'vitest';
import {
  buildExecCommand,
  resolveInteractive,
  buildExecEnv,
  buildFallbackPrompt,
  detectRateLimit,
  AGENT_COMMANDS,
  parseExecEnv,
  normalizeMode,
  resolveMode,
  defaultModeFor,
  headlessPlanStallCommand,
  type ExecOptions,
} from '../exec.js';
import type { AgentId, Mode } from '../types.js';
import { AGENTS } from '../agents.js';
import { buildWorkflowMcpConfig, getMcpServersByName } from '../mcp.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function opts(overrides: Partial<ExecOptions>): ExecOptions {
  return {
    agent: 'claude',
    prompt: 'do the thing',
    mode: 'plan',
    effort: 'auto',
    ...overrides,
  };
}

const ALL_AGENTS = Object.keys(AGENT_COMMANDS) as AgentId[];

// Mirror the source's home resolution (src/lib/state.ts: `process.env.HOME ?? os.homedir()`).
// On Windows process.env.HOME is unset, so a bare `process.env.HOME!` is undefined and
// `path.join(undefined, …)` throws — these assertions must resolve home the same way the
// version-home builder does so the expected path matches on every OS.
const HOME = process.env.HOME ?? os.homedir();

describe('buildExecCommand', () => {
  // --- Mode flags per agent ---

  describe('mode flags', () => {
    it('claude plan produces --permission-mode plan', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', mode: 'plan' }));
      expect(cmd).toContain('--permission-mode');
      expect(cmd[cmd.indexOf('--permission-mode') + 1]).toBe('plan');
    });

    it('claude edit produces --permission-mode acceptEdits', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', mode: 'edit' }));
      expect(cmd).toContain('--permission-mode');
      expect(cmd[cmd.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    });

    it('claude skip produces --dangerously-skip-permissions', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', mode: 'skip' }));
      expect(cmd).toContain('--dangerously-skip-permissions');
      expect(cmd).not.toContain('--permission-mode');
    });

    it("claude 'full' (legacy alias) routes through skip and produces --dangerously-skip-permissions", () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', mode: 'skip' as Mode }));
      expect(cmd).toContain('--dangerously-skip-permissions');
    });

    it('claude auto produces --permission-mode auto (smart classifier)', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', mode: 'auto' }));
      expect(cmd).toContain('--permission-mode');
      expect(cmd[cmd.indexOf('--permission-mode') + 1]).toBe('auto');
    });

    it('codex plan produces --sandbox read-only', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', mode: 'plan' }));
      expect(cmd).toContain('--sandbox');
      expect(cmd[cmd.indexOf('--sandbox') + 1]).toBe('read-only');
      expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    it('codex edit produces --sandbox workspace-write with network on, no approval bypass', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', mode: 'edit' }));
      expect(cmd).toContain('--sandbox');
      expect(cmd[cmd.indexOf('--sandbox') + 1]).toBe('workspace-write');
      expect(cmd).toContain('sandbox_workspace_write.network_access=true');
      expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    it('codex skip produces --dangerously-bypass-approvals-and-sandbox without --sandbox', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', mode: 'skip' }));
      expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(cmd).not.toContain('--sandbox');
    });

    it('gemini plan produces --approval-mode plan', () => {
      const cmd = buildExecCommand(opts({ agent: 'gemini', mode: 'plan' }));
      expect(cmd).toContain('--approval-mode');
      expect(cmd[cmd.indexOf('--approval-mode') + 1]).toBe('plan');
    });

    it('gemini edit produces --approval-mode auto_edit', () => {
      const cmd = buildExecCommand(opts({ agent: 'gemini', mode: 'edit' }));
      expect(cmd).toContain('--approval-mode');
      expect(cmd[cmd.indexOf('--approval-mode') + 1]).toBe('auto_edit');
    });

    it('gemini skip produces --yolo', () => {
      const cmd = buildExecCommand(opts({ agent: 'gemini', mode: 'skip' }));
      expect(cmd).toContain('--yolo');
    });

    it('cursor plan degrades to edit (cursor has no read-only mode)', () => {
      // Same flags as an explicit edit run — no -f (that's skip).
      const cmd = buildExecCommand(opts({ agent: 'cursor', mode: 'plan' }));
      expect(cmd).not.toContain('-f');
      // Command still builds (does not throw).
      expect(cmd[0]).toBe('cursor-agent');
    });

    it('antigravity plan degrades to edit (no read-only mode)', () => {
      // Explicit headless so --print is emitted (printFlags require headless:true).
      const planCmd = buildExecCommand(opts({ agent: 'antigravity', mode: 'plan', headless: true }));
      const editCmd = buildExecCommand(opts({ agent: 'antigravity', mode: 'edit', headless: true }));
      // plan and edit must build the same argv once plan degrades.
      expect(planCmd).toEqual(editCmd);
      expect(planCmd).toEqual(['agy', '--print', 'do the thing']);
      // skip would add --dangerously-skip-permissions — plan must not.
      expect(planCmd).not.toContain('--dangerously-skip-permissions');
    });

    it('cursor edit produces no flags (edit is cursor default)', () => {
      const cmd = buildExecCommand(opts({ agent: 'cursor', mode: 'edit' }));
      expect(cmd).not.toContain('-f');
    });

    it('cursor skip produces -f', () => {
      const cmd = buildExecCommand(opts({ agent: 'cursor', mode: 'skip' }));
      expect(cmd).toContain('-f');
    });

    it('opencode plan produces --agent plan', () => {
      const cmd = buildExecCommand(opts({ agent: 'opencode', mode: 'plan' }));
      expect(cmd).toContain('--agent');
      expect(cmd[cmd.indexOf('--agent') + 1]).toBe('plan');
    });

    it('opencode edit produces --agent build', () => {
      const cmd = buildExecCommand(opts({ agent: 'opencode', mode: 'edit' }));
      expect(cmd[cmd.indexOf('--agent') + 1]).toBe('build');
    });

    it('opencode skip throws (opencode has no skip-permissions flag)', () => {
      expect(() => buildExecCommand(opts({ agent: 'opencode', mode: 'skip' })))
        .toThrow(/opencode does not support 'skip' mode/);
    });

    it('openclaw plan produces --mode plan', () => {
      const cmd = buildExecCommand(opts({ agent: 'openclaw', mode: 'plan' }));
      expect(cmd).toContain('--mode');
      expect(cmd[cmd.indexOf('--mode') + 1]).toBe('plan');
    });

    it('openclaw edit produces --mode edit', () => {
      const cmd = buildExecCommand(opts({ agent: 'openclaw', mode: 'edit' }));
      expect(cmd[cmd.indexOf('--mode') + 1]).toBe('edit');
    });

    it('openclaw skip produces --mode full (openclaw native flag is still "full")', () => {
      const cmd = buildExecCommand(opts({ agent: 'openclaw', mode: 'skip' }));
      expect(cmd[cmd.indexOf('--mode') + 1]).toBe('full');
    });

    it('copilot plan produces --mode plan', () => {
      const cmd = buildExecCommand(opts({ agent: 'copilot', mode: 'plan' }));
      expect(cmd).toContain('--mode');
      expect(cmd[cmd.indexOf('--mode') + 1]).toBe('plan');
      expect(cmd).not.toContain('--allow-all-tools');
      expect(cmd).not.toContain('--allow-all');
    });

    it('copilot edit produces --allow-all-tools (headless tools, scoped paths)', () => {
      const cmd = buildExecCommand(opts({ agent: 'copilot', mode: 'edit' }));
      expect(cmd).toContain('--allow-all-tools');
      expect(cmd).not.toContain('--allow-all');
      expect(cmd).not.toContain('--mode');
    });

    it('copilot skip produces --allow-all (tools + paths + URLs)', () => {
      const cmd = buildExecCommand(opts({ agent: 'copilot', mode: 'skip' }));
      expect(cmd).toContain('--allow-all');
      expect(cmd).not.toContain('--allow-all-tools');
    });

    it('copilot auto produces --autopilot (smart classifier)', () => {
      const cmd = buildExecCommand(opts({ agent: 'copilot', mode: 'auto' }));
      expect(cmd).toContain('--autopilot');
    });

    it('grok plan produces --permission-mode plan', () => {
      const cmd = buildExecCommand(opts({ agent: 'grok', mode: 'plan' }));
      expect(cmd).toContain('--permission-mode');
      expect(cmd[cmd.indexOf('--permission-mode') + 1]).toBe('plan');
      expect(cmd).not.toContain('--mode');
    });

    it('grok skip produces --always-approve', () => {
      const cmd = buildExecCommand(opts({ agent: 'grok', mode: 'skip' }));
      expect(cmd).toContain('--always-approve');
    });

    // kimi's startup-mode flags are valid only for the interactive TUI. In
    // headless (`-p`) runs kimi rejects them (see the "kimi headless" block
    // below), so these interactive assertions pin the TUI flag mapping.
    it('kimi plan (interactive TUI) produces --plan', () => {
      const cmd = buildExecCommand(opts({ agent: 'kimi', mode: 'plan', prompt: undefined, interactive: true }));
      expect(cmd).toContain('--plan');
    });

    it('kimi auto (interactive TUI) produces --auto', () => {
      const cmd = buildExecCommand(opts({ agent: 'kimi', mode: 'auto', prompt: undefined, interactive: true }));
      expect(cmd).toContain('--auto');
    });

    it('kimi skip (interactive TUI) produces --yolo', () => {
      const cmd = buildExecCommand(opts({ agent: 'kimi', mode: 'skip', prompt: undefined, interactive: true }));
      expect(cmd).toContain('--yolo');
    });

    it('kimi edit produces no mode flags', () => {
      const cmd = buildExecCommand(opts({ agent: 'kimi', mode: 'edit', prompt: undefined, interactive: true }));
      expect(cmd).not.toContain('--plan');
      expect(cmd).not.toContain('--auto');
      expect(cmd).not.toContain('--yolo');
    });

    // Regression: `agents teams` launches kimi headless with `-p`. Emitting any
    // startup-mode flag alongside `-p` made kimi abort with
    // "Cannot combine --prompt with --<flag>" — so skip/auto teammates failed at
    // spawn. Headless write-modes must omit the flag; plan must fail closed.
    describe('kimi headless -p cannot carry startup-mode flags', () => {
      it('headless skip omits --yolo (kimi -p already auto-approves)', () => {
        const cmd = buildExecCommand(opts({ agent: 'kimi', mode: 'skip' }));
        expect(cmd).not.toContain('--yolo');
        expect(cmd).toContain('-p');
      });

      it('headless auto omits --auto', () => {
        const cmd = buildExecCommand(opts({ agent: 'kimi', mode: 'auto' }));
        expect(cmd).not.toContain('--auto');
      });

      it('headless edit carries no mode flags', () => {
        const cmd = buildExecCommand(opts({ agent: 'kimi', mode: 'edit' }));
        expect(cmd).not.toContain('--plan');
        expect(cmd).not.toContain('--auto');
        expect(cmd).not.toContain('--yolo');
      });

      it('headless plan throws (kimi has no read-only -p mode)', () => {
        expect(() => buildExecCommand(opts({ agent: 'kimi', mode: 'plan' }))).toThrow(/read-only/);
      });
    });

    it('kimi json adds --output-format stream-json', () => {
      const cmd = buildExecCommand(opts({ agent: 'kimi', prompt: 'do the thing', mode: 'edit', json: true }));
      expect(cmd).toContain('--output-format');
      expect(cmd[cmd.indexOf('--output-format') + 1]).toBe('stream-json');
    });

    it('copilot uses -p (not positional) for the prompt', () => {
      const cmd = buildExecCommand(opts({ agent: 'copilot', prompt: 'do the thing', mode: 'edit' }));
      const idx = cmd.indexOf('-p');
      expect(idx).toBeGreaterThan(-1);
      expect(cmd[idx + 1]).toBe('do the thing');
    });

    it('copilot json adds --output-format json (JSONL)', () => {
      const cmd = buildExecCommand(opts({ agent: 'copilot', json: true, mode: 'edit' }));
      expect(cmd).toContain('--output-format');
      expect(cmd[cmd.indexOf('--output-format') + 1]).toBe('json');
    });

    it('every agent declares at least the edit mode (the universal default)', () => {
      for (const agent of ALL_AGENTS) {
        expect(AGENTS[agent].capabilities.modes).toContain('edit');
      }
    });

    it("AGENT_COMMANDS.modeFlags keys agree with AGENTS.capabilities.modes (no drift)", () => {
      for (const agent of ALL_AGENTS) {
        const cap = [...AGENTS[agent].capabilities.modes].sort();
        const decl = Object.keys(AGENT_COMMANDS[agent].modeFlags).sort();
        expect(decl).toEqual(cap);
      }
    });
  });

  // --- Print / headless ---

  describe('print/headless flags', () => {
    it('claude headless adds --print', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', headless: true }));
      expect(cmd).toContain('--print');
    });

    it('claude headless=false omits --print', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', headless: false }));
      expect(cmd).not.toContain('--print');
    });

    it('codex headless adds nothing (no printFlags)', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', headless: true }));
      expect(cmd).not.toContain('--print');
    });

    it('gemini headless adds nothing', () => {
      const cmd = buildExecCommand(opts({ agent: 'gemini', headless: true }));
      expect(cmd).not.toContain('--print');
    });

    it('antigravity headless prompts use --print before the prompt', () => {
      const cmd = buildExecCommand(opts({ agent: 'antigravity', mode: 'edit', headless: true }));
      expect(cmd).toEqual(['agy', '--print', 'do the thing']);
    });
  });

  // --- Interactive mode ---

  describe('interactive mode', () => {
    it('prompt + interactive: true does not add --print', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', prompt: 'fix auth', interactive: true, headless: true }));
      expect(cmd).not.toContain('--print');
    });

    it('prompt + interactive: true still includes the prompt in the built command', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', prompt: 'fix auth', interactive: true, headless: true }));
      expect(cmd).toContain('fix auth');
    });

    it('no prompt and no flag behaves as interactive by default (no --print)', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', prompt: undefined }));
      expect(cmd).not.toContain('--print');
    });

    it('prompt without interactive behaves as headless (adds --print)', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', prompt: 'fix auth', headless: true }));
      expect(cmd).toContain('--print');
    });

    it('--headless with no prompt forces headless (adds --print, reads stdin)', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', prompt: undefined, headless: true }));
      expect(cmd).toContain('--print');
    });

    it('--headless with no prompt keeps codex in headless exec subcommand', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', mode: 'edit', prompt: undefined, headless: true }));
      expect(cmd.slice(0, 2)).toEqual(['codex', 'exec']);
    });

    it('no flag and no prompt drops the codex exec subcommand (interactive TUI)', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', mode: 'edit', prompt: undefined }));
      expect(cmd[0]).toBe('codex');
      expect(cmd).not.toContain('exec');
    });

    it('no flag and no prompt drops the opencode run subcommand (interactive TUI)', () => {
      const cmd = buildExecCommand(opts({ agent: 'opencode', prompt: undefined }));
      expect(cmd[0]).toBe('opencode');
      expect(cmd).not.toContain('run');
    });

    it('--headless with no prompt keeps opencode in headless run subcommand', () => {
      const cmd = buildExecCommand(opts({ agent: 'opencode', prompt: undefined, headless: true }));
      expect(cmd.slice(0, 2)).toEqual(['opencode', 'run']);
    });

    it('prompt without flags keeps opencode headless with the prompt as a positional', () => {
      const cmd = buildExecCommand(opts({ agent: 'opencode', prompt: 'fix auth' }));
      expect(cmd.slice(0, 2)).toEqual(['opencode', 'run']);
      expect(cmd[cmd.length - 1]).toBe('fix auth');
      expect(cmd).not.toContain('--prompt');
    });

    it('--interactive with a prompt launches the opencode TUI and forwards via --prompt', () => {
      const cmd = buildExecCommand(opts({ agent: 'opencode', prompt: 'fix auth', interactive: true }));
      expect(cmd[0]).toBe('opencode');
      expect(cmd).not.toContain('run');
      const flagIdx = cmd.indexOf('--prompt');
      expect(flagIdx).toBeGreaterThan(-1);
      expect(cmd[flagIdx + 1]).toBe('fix auth');
    });
  });

  // --- Passthrough args (everything after --) ---

  describe('passthrough args', () => {
    it('forwards arbitrary flags after -- for kimi', () => {
      const cmd = buildExecCommand(opts({ agent: 'kimi', prompt: undefined, passthroughArgs: ['--plan', '--some-flag', 'value'] }));
      expect(cmd.slice(-3)).toEqual(['--plan', '--some-flag', 'value']);
    });

    it('forwards flags after -- without breaking the prompt', () => {
      const cmd = buildExecCommand(opts({ agent: 'kimi', mode: 'edit', prompt: 'fix auth', passthroughArgs: ['--custom-flag'] }));
      const promptIdx = cmd.indexOf('fix auth');
      const flagIdx = cmd.indexOf('--custom-flag');
      expect(promptIdx).toBeGreaterThan(-1);
      expect(flagIdx).toBeGreaterThan(promptIdx);
    });

    it('forwards flags in interactive mode', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', prompt: undefined, interactive: true, passthroughArgs: ['--custom-flag'] }));
      expect(cmd).toContain('--custom-flag');
      expect(cmd[cmd.length - 1]).toBe('--custom-flag');
    });

    it('does not include passthrough args when empty', () => {
      const cmd = buildExecCommand(opts({ agent: 'kimi', mode: 'edit' }));
      expect(cmd).not.toContain('--custom-flag');
    });

    it('forwards passthrough args for codex after all generated flags', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', mode: 'edit', prompt: undefined, passthroughArgs: ['--verbose', '--timeout', '10m'] }));
      expect(cmd.slice(-3)).toEqual(['--verbose', '--timeout', '10m']);
    });

    it('combines interactive --mode mapping and passthrough args for kimi', () => {
      // Interactive: the --yolo startup flag is valid alongside passthrough args.
      const cmd = buildExecCommand(opts({ agent: 'kimi', mode: 'skip', prompt: undefined, interactive: true, passthroughArgs: ['--extra'] }));
      expect(cmd).toContain('--yolo');
      expect(cmd[cmd.length - 1]).toBe('--extra');
    });
  });

  // --- resolveInteractive precedence ---

  describe('resolveInteractive precedence', () => {
    it('no flags + no prompt -> interactive', () => {
      expect(resolveInteractive({ prompt: undefined })).toBe(true);
    });

    it('no flags + prompt -> headless', () => {
      expect(resolveInteractive({ prompt: 'do x' })).toBe(false);
    });

    it('--headless + no prompt -> headless (definitive)', () => {
      expect(resolveInteractive({ prompt: undefined, headless: true })).toBe(false);
    });

    it('--headless + prompt -> headless', () => {
      expect(resolveInteractive({ prompt: 'do x', headless: true })).toBe(false);
    });

    it('--interactive + no prompt -> interactive', () => {
      expect(resolveInteractive({ prompt: undefined, interactive: true })).toBe(true);
    });

    it('--interactive + prompt -> interactive (definitive)', () => {
      expect(resolveInteractive({ prompt: 'do x', interactive: true })).toBe(true);
    });

    it('--interactive wins over --headless at the resolver level', () => {
      expect(resolveInteractive({ prompt: 'do x', interactive: true, headless: true })).toBe(true);
    });
  });

  // --- Session ID ---

  describe('session ID', () => {
    it('claude with sessionId adds --session-id', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', sessionId: 'abc-123' }));
      const idx = cmd.indexOf('--session-id');
      expect(idx).toBeGreaterThan(-1);
      expect(cmd[idx + 1]).toBe('abc-123');
    });

    it('codex ignores sessionId', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', sessionId: 'abc-123' }));
      expect(cmd).not.toContain('--session-id');
    });

    it('gemini ignores sessionId', () => {
      const cmd = buildExecCommand(opts({ agent: 'gemini', sessionId: 'abc-123' }));
      expect(cmd).not.toContain('--session-id');
    });

    it('omits --session-id when not provided', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude' }));
      expect(cmd).not.toContain('--session-id');
    });
  });

  // --- Verbose ---

  describe('verbose flag', () => {
    it('claude verbose adds --verbose', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', verbose: true }));
      expect(cmd).toContain('--verbose');
    });

    it('claude verbose + json does not duplicate --verbose', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', verbose: true, json: true }));
      const count = cmd.filter((f) => f === '--verbose').length;
      expect(count).toBe(1);
    });

    it('codex verbose adds nothing (no verboseFlag)', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', verbose: true }));
      expect(cmd).not.toContain('--verbose');
    });

    it('claude json without verbose still includes --verbose from jsonFlags', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', json: true, verbose: false }));
      expect(cmd).toContain('--verbose');
    });
  });

  // --- JSON flags ---

  describe('JSON flags', () => {
    it('claude json adds --output-format stream-json --verbose', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', json: true }));
      expect(cmd).toContain('--output-format');
      expect(cmd).toContain('stream-json');
      expect(cmd).toContain('--verbose');
    });

    it('codex json adds --json', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', json: true }));
      expect(cmd).toContain('--json');
    });

    it('json=false adds no json flags', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', json: false }));
      expect(cmd).not.toContain('--output-format');
      expect(cmd).not.toContain('stream-json');
    });
  });

  // --- Model selection ---

  describe('model selection', () => {
    it('explicit model is forwarded via --model', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', model: 'custom-model' }));
      expect(cmd).toContain('--model');
      expect(cmd[cmd.indexOf('--model') + 1]).toBe('custom-model');
    });

    it('no --model flag when model is not provided (agent uses its default)', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude' }));
      expect(cmd).not.toContain('--model');
    });

    it('no --model flag for codex when neither --model nor a configured model exists', () => {
      // Point config resolution at an empty home so the result is deterministic
      // regardless of the CI box's real ~/.codex/config.toml.
      const prev = process.env.AGENTS_REAL_HOME;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-exec-empty-'));
      try {
        process.env.AGENTS_REAL_HOME = tmp;
        const cmd = buildExecCommand(opts({ agent: 'codex' }));
        expect(cmd).not.toContain('--model');
      } finally {
        if (prev === undefined) delete process.env.AGENTS_REAL_HOME;
        else process.env.AGENTS_REAL_HOME = prev;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('codex forwards the model configured in ~/.codex/config.toml when no explicit --model', () => {
      // Codex runs under a per-version CODEX_HOME that may lack the user's model,
      // so buildExecCommand falls back to the active ~/.codex/config.toml model —
      // otherwise Codex defaults to gpt-5.3-codex and 400s on a ChatGPT account.
      const prev = process.env.AGENTS_REAL_HOME;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-exec-model-'));
      try {
        fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true });
        fs.writeFileSync(path.join(tmp, '.codex', 'config.toml'), 'model = "gpt-5.5"\n');
        process.env.AGENTS_REAL_HOME = tmp;
        const cmd = buildExecCommand(opts({ agent: 'codex' }));
        const idx = cmd.indexOf('--model');
        expect(idx).toBeGreaterThan(-1);
        expect(cmd[idx + 1]).toBe('gpt-5.5');
      } finally {
        if (prev === undefined) delete process.env.AGENTS_REAL_HOME;
        else process.env.AGENTS_REAL_HOME = prev;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  // --- Reasoning effort flags ---

  describe('reasoning effort', () => {
    it('claude effort=high adds --effort high', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', effort: 'high' }));
      const idx = cmd.indexOf('--effort');
      expect(idx).toBeGreaterThan(-1);
      expect(cmd[idx + 1]).toBe('high');
    });

    it('claude effort=auto omits reasoning flags (agent uses its default)', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', effort: 'auto' }));
      expect(cmd).not.toContain('--effort');
    });

    it('codex effort=medium injects -c model_reasoning_effort=medium before exec', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', effort: 'medium' }));
      const cIdx = cmd.indexOf('-c');
      const execIdx = cmd.indexOf('exec');
      expect(cIdx).toBeGreaterThan(-1);
      expect(execIdx).toBeGreaterThan(cIdx);
      expect(cmd[cIdx + 1]).toBe('model_reasoning_effort=medium');
    });

    it('codex effort=xhigh clamps to high', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', effort: 'xhigh' }));
      const cIdx = cmd.indexOf('-c');
      expect(cmd[cIdx + 1]).toBe('model_reasoning_effort=high');
    });

    it('codex effort=auto omits reasoning flags', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', effort: 'auto' }));
      expect(cmd).not.toContain('-c');
    });

    it('gemini ignores effort (no reasoning flags)', () => {
      const cmd = buildExecCommand(opts({ agent: 'gemini', effort: 'high' }));
      expect(cmd).not.toContain('--effort');
      expect(cmd).not.toContain('-c');
    });
  });

  // --- Prompt positioning ---

  describe('prompt positioning', () => {
    it('claude uses -p flag for prompt', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', prompt: 'hello world' }));
      const idx = cmd.indexOf('-p');
      expect(idx).toBeGreaterThan(-1);
      expect(cmd[idx + 1]).toBe('hello world');
    });

    it('codex uses positional prompt', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', prompt: 'hello world' }));
      expect(cmd).not.toContain('-p');
      expect(cmd).toContain('hello world');
    });

    it('gemini uses positional prompt', () => {
      const cmd = buildExecCommand(opts({ agent: 'gemini', prompt: 'hello world' }));
      expect(cmd).not.toContain('-p');
      expect(cmd).toContain('hello world');
    });
  });

  // --- Add dirs ---

  describe('add dirs', () => {
    it('claude addDirs adds --add-dir for each directory', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', addDirs: ['/a', '/b'] }));
      const indices = cmd.reduce<number[]>((acc, v, i) => (v === '--add-dir' ? [...acc, i] : acc), []);
      expect(indices).toHaveLength(2);
      expect(cmd[indices[0] + 1]).toBe('/a');
      expect(cmd[indices[1] + 1]).toBe('/b');
    });

    it('codex addDirs adds --add-dir (widens the workspace-write sandbox)', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', addDirs: ['/a'] }));
      expect(cmd[cmd.indexOf('--add-dir') + 1]).toBe('/a');
    });

    it('codex resume drops addDirs (`codex exec resume` rejects --add-dir)', () => {
      const cmd = buildExecCommand(opts({
        agent: 'codex', addDirs: ['/a'], resume: true, sessionId: 'xyz-9', prompt: 'go',
      }));
      expect(cmd).not.toContain('--add-dir');
    });

    it('gemini ignores addDirs', () => {
      const cmd = buildExecCommand(opts({ agent: 'gemini', addDirs: ['/a'] }));
      expect(cmd).not.toContain('--add-dir');
    });
  });

  // WORKFLOW.md frontmatter tools/mcpServers → Claude headless capability flags
  // (issue #324). buildExecCommand is pure: the command layer resolves the
  // registry / writes the mcp-config file and gates on `allowlist`; here we
  // assert the string-building and the Claude-only guard. These assertions
  // encode the SECURITY-correct flags verified against `claude --help`:
  //   - `--tools <names...>` restricts the AVAILABLE tool set (the boundary);
  //     `--allowedTools` only auto-approves and is emitted alongside.
  //   - `--strict-mcp-config` makes the run use ONLY the named MCP servers.
  //   - `--agents` is NOT emitted (it defines agents, doesn't restrict dispatch).
  describe('workflow capability scoping', () => {
    it('claude toolsRestrict emits --tools as SEPARATE variadic tokens (the restriction)', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', toolsRestrict: ['Read', 'Grep'] }));
      const i = cmd.indexOf('--tools');
      expect(i).toBeGreaterThan(-1);
      // Separate argv tokens, NOT a single "Read Grep" string.
      expect(cmd[i + 1]).toBe('Read');
      expect(cmd[i + 2]).toBe('Grep');
      expect(cmd).not.toContain('Read Grep');
    });

    it('claude toolsRestrict also emits --allowedTools (auto-approve permitted tools in headless)', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', toolsRestrict: ['Read', 'Grep'] }));
      const i = cmd.indexOf('--allowedTools');
      expect(i).toBeGreaterThan(-1);
      expect(cmd[i + 1]).toBe('Read');
      expect(cmd[i + 2]).toBe('Grep');
    });

    it('claude mcpConfigPath emits --mcp-config AND --strict-mcp-config (only named servers)', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', mcpConfigPath: '/tmp/x/mcp-config.json' }));
      expect(cmd).toContain('--mcp-config');
      expect(cmd[cmd.indexOf('--mcp-config') + 1]).toBe('/tmp/x/mcp-config.json');
      expect(cmd).toContain('--strict-mcp-config');
    });

    it('never emits the inert --agents flag', () => {
      const cmd = buildExecCommand(opts({
        agent: 'claude',
        toolsRestrict: ['Read', 'Grep'],
        mcpConfigPath: '/tmp/x/mcp-config.json',
      }));
      expect(cmd).not.toContain('--agents');
    });

    it('empty toolsRestrict does not emit --tools', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', toolsRestrict: [] }));
      expect(cmd).not.toContain('--tools');
      expect(cmd).not.toContain('--allowedTools');
    });

    it('--tools is emitted after the positional prompt so the variadic never swallows it', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', prompt: 'write a file', headless: true, toolsRestrict: ['Read', 'Grep'] }));
      // The prompt is a positional appended before the scoping flags; --tools
      // must come strictly after it (verified against claude --help: a trailing
      // variadic --tools would otherwise consume the positional prompt).
      const promptIdx = cmd.indexOf('write a file');
      const toolsIdx = cmd.indexOf('--tools');
      expect(promptIdx).toBeGreaterThan(-1);
      expect(toolsIdx).toBeGreaterThan(promptIdx);
    });

    it('non-claude agent (codex) ignores all scoping options — the guard', () => {
      const cmd = buildExecCommand(opts({
        agent: 'codex',
        toolsRestrict: ['Read', 'Grep'],
        mcpConfigPath: '/tmp/x/mcp-config.json',
      }));
      expect(cmd).not.toContain('--tools');
      expect(cmd).not.toContain('--allowedTools');
      expect(cmd).not.toContain('--mcp-config');
      expect(cmd).not.toContain('--strict-mcp-config');
      expect(cmd).not.toContain('--agents');
    });

    // Fail-closed mcpServers (issue #324): when a workflow DECLARES `mcpServers:`
    // but none of the names resolve to installed servers, the run must STILL be
    // locked down to an EMPTY config — never fall through to the user's ambient
    // MCP set (which would be MORE access than declared). This composes the real
    // command-layer steps: resolve names -> [], build the empty map, write it,
    // feed the path to buildExecCommand, and assert both scoping flags fire.
    it('declared-but-all-unresolved mcpServers => empty {} map + --mcp-config + --strict-mcp-config (no ambient)', () => {
      // No installed server matches these names, so resolution yields zero.
      const servers = getMcpServersByName(['__definitely_missing_a__', '__definitely_missing_b__']);
      expect(servers).toEqual([]);

      const mcpConfig = buildWorkflowMcpConfig(servers);
      // The locked-down payload: NO servers, not the ambient set.
      expect(JSON.parse(mcpConfig)).toEqual({ mcpServers: {} });

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-failclosed-mcp-'));
      const configPath = path.join(dir, 'mcp-config.json');
      fs.writeFileSync(configPath, mcpConfig, { mode: 0o600 });
      try {
        const cmd = buildExecCommand(opts({ agent: 'claude', mcpConfigPath: configPath }));
        expect(cmd).toContain('--mcp-config');
        expect(cmd[cmd.indexOf('--mcp-config') + 1]).toBe(configPath);
        // --strict-mcp-config is what makes the empty map mean "ONLY these (none)"
        // rather than "these PLUS ambient".
        expect(cmd).toContain('--strict-mcp-config');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('exec env', () => {
    it('parses repeated KEY=VALUE entries', () => {
      expect(parseExecEnv(['ANTHROPIC_BASE_URL=https://ollama.example.com', 'ANTHROPIC_MODEL=qwen3.6:35b'])).toEqual({
        ANTHROPIC_BASE_URL: 'https://ollama.example.com',
        ANTHROPIC_MODEL: 'qwen3.6:35b',
      });
    });

    it('preserves equals signs in values', () => {
      expect(parseExecEnv(['AUTH_HEADER=Bearer abc=123'])).toEqual({
        AUTH_HEADER: 'Bearer abc=123',
      });
    });

    it('rejects malformed entries', () => {
      expect(() => parseExecEnv(['NOT_VALID'])).toThrow('Invalid --env value "NOT_VALID". Use KEY=VALUE.');
    });

    it('merges explicit env over process env', () => {
      const previous = process.env.ANTHROPIC_MODEL;
      process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5';

      try {
        const env = buildExecEnv(opts({ env: { ANTHROPIC_MODEL: 'qwen3.6:35b', ANTHROPIC_BASE_URL: 'https://ollama.example.com' } }));
        expect(env.ANTHROPIC_MODEL).toBe('qwen3.6:35b');
        expect(env.ANTHROPIC_BASE_URL).toBe('https://ollama.example.com');
      } finally {
        if (previous === undefined) {
          delete process.env.ANTHROPIC_MODEL;
        } else {
          process.env.ANTHROPIC_MODEL = previous;
        }
      }
    });

    it('injects Claude config dir for pinned Claude versions', () => {
      const env = buildExecEnv(opts({ agent: 'claude', version: '2.1.98' }));
      // path.join (not a forward-slash template) so the separator matches the
      // source on every OS — buildExecEnv builds this with path.join too.
      expect(env.CLAUDE_CONFIG_DIR).toBe(
        path.join(HOME, '.agents', '.history', 'versions', 'claude', '2.1.98', 'home', '.claude')
      );
    });

    it('lets explicit env override injected Claude config dir', () => {
      const env = buildExecEnv(opts({
        agent: 'claude',
        version: '2.1.98',
        env: { CLAUDE_CONFIG_DIR: '/tmp/custom-claude-config' },
      }));
      expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/custom-claude-config');
    });

    it('does not inject Claude config dir for non-Claude agents', () => {
      const env = buildExecEnv(opts({ agent: 'codex', version: '0.98.0' }));
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    });

    it('injects COPILOT_HOME for pinned Copilot versions', () => {
      const env = buildExecEnv(opts({ agent: 'copilot', version: '1.0.56', mode: 'edit' }));
      expect(env.COPILOT_HOME).toBe(
        path.join(HOME, '.agents', '.history', 'versions', 'copilot', '1.0.56', 'home', '.copilot')
      );
    });

    it('strips COPILOT_HOME for non-Copilot agents', () => {
      process.env.COPILOT_HOME = '/tmp/leaked-copilot-home';
      try {
        const env = buildExecEnv(opts({ agent: 'claude', version: '2.1.98' }));
        expect(env.COPILOT_HOME).toBeUndefined();
      } finally {
        delete process.env.COPILOT_HOME;
      }
    });

    it('injects KIMI_CODE_HOME for pinned Kimi versions', () => {
      const env = buildExecEnv(opts({ agent: 'kimi', version: '0.11.0' }));
      expect(env.KIMI_CODE_HOME).toBe(
        path.join(HOME, '.agents', '.history', 'versions', 'kimi', '0.11.0', 'home', '.kimi-code')
      );
    });

    it('strips KIMI_CODE_HOME for non-Kimi agents', () => {
      process.env.KIMI_CODE_HOME = '/tmp/leaked-kimi-home';
      try {
        const env = buildExecEnv(opts({ agent: 'claude', version: '2.1.98' }));
        expect(env.KIMI_CODE_HOME).toBeUndefined();
      } finally {
        delete process.env.KIMI_CODE_HOME;
      }
    });
  });

  // --- Version pinning ---

  describe('version pinning', () => {
    it('appends @version to base command when version is set', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', version: '2.1.98', mode: 'skip' }));
      expect(cmd[0]).toBe('claude@2.1.98');
    });

    it('does not append @version when version is undefined', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', mode: 'skip' }));
      expect(cmd[0]).toBe('claude');
    });

    it('works for codex with version', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', version: '0.98.0', mode: 'skip' }));
      expect(cmd[0]).toBe('codex@0.98.0');
      expect(cmd[1]).toBe('exec');
    });

    it('resolves to absolute shim path when the shim exists on disk (closes #196)', async () => {
      // Linux installs without ~/.agents/.cache/shims on PATH would otherwise
      // spawn the bare versioned name and fail with ENOENT.
      const fs = await import('fs');
      const path = await import('path');
      const { getShimsDir } = await import('../state.js');
      const shimsDir = getShimsDir();
      fs.mkdirSync(shimsDir, { recursive: true });
      const fakeShim = path.join(shimsDir, 'claude@9.9.9-test');
      const preexisted = fs.existsSync(fakeShim);
      if (!preexisted) fs.writeFileSync(fakeShim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      try {
        const cmd = buildExecCommand(opts({ agent: 'claude', version: '9.9.9-test', mode: 'skip' }));
        expect(cmd[0]).toBe(fakeShim);
        expect(path.isAbsolute(cmd[0])).toBe(true);
      } finally {
        if (!preexisted) fs.rmSync(fakeShim, { force: true });
      }
    });
  });

  // --- Snapshot: agent-runner.sh patterns ---

  describe('agent-runner.sh compatibility', () => {
    it('produces claude command matching agent-runner pattern', () => {
      const cmd = buildExecCommand(opts({
        agent: 'claude',
        mode: 'skip',
        headless: true,
        sessionId: 'sess-123',
        verbose: true,
        prompt: 'fix the bug',
      }));
      expect(cmd).toEqual([
        'claude',
        '--dangerously-skip-permissions',
        '--print',
        '--session-id', 'sess-123',
        '--verbose',
        '-p', 'fix the bug',
      ]);
    });

    it('produces codex command matching agent-runner pattern', () => {
      const cmd = buildExecCommand(opts({
        agent: 'codex',
        mode: 'skip',
        prompt: 'fix the bug',
      }));
      expect(cmd).toEqual([
        'codex', 'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        'fix the bug',
      ]);
    });

    it('claude with effort=high emits --effort high', () => {
      const cmd = buildExecCommand(opts({
        agent: 'claude',
        mode: 'skip',
        effort: 'high',
        prompt: 'fix the bug',
      }));
      expect(cmd).toEqual([
        'claude',
        '--effort', 'high',
        '--dangerously-skip-permissions',
        '-p', 'fix the bug',
      ]);
    });

    it('codex with effort=medium emits -c model_reasoning_effort=medium before exec', () => {
      const cmd = buildExecCommand(opts({
        agent: 'codex',
        mode: 'skip',
        effort: 'medium',
        prompt: 'fix the bug',
      }));
      expect(cmd).toEqual([
        'codex',
        '-c', 'model_reasoning_effort=medium',
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        'fix the bug',
      ]);
    });
  });
});

describe('detectRateLimit', () => {
  it.each([
    ['Anthropic 5-hour limit', 'Your 5-hour limit has been reached. Resets in 2h.'],
    ['generic rate-limit phrasing', 'Error: rate limit exceeded for claude-opus'],
    ['hyphenated rate-limit phrasing', 'rate-limit hit'],
    ['HTTP 429 code in error body', 'Request failed with status 429'],
    ['Google quota exceeded', 'RESOURCE_EXHAUSTED: quota exceeded for requests'],
    ['OpenAI usage limit', 'You have exceeded your usage limit for this month'],
    ['429 too many requests', '429: Too Many Requests'],
    ['Anthropic overloaded', 'API Error: Overloaded'],
    ['api_overloaded snake case', 'error_type: api_overloaded'],
  ])('matches %s', (_label, text) => {
    expect(detectRateLimit(text)).toBe(true);
  });

  it.each([
    ['normal success output', 'Task completed successfully.'],
    ['unrelated error', 'TypeError: Cannot read property foo of undefined'],
    ['auth error', 'Authentication failed: invalid API key'],
    ['file not found', 'ENOENT: no such file or directory'],
    ['empty stderr', ''],
  ])('does not match %s', (_label, text) => {
    expect(detectRateLimit(text)).toBe(false);
  });
});

describe('buildFallbackPrompt', () => {
  const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

  it('returns /continue <id> when next agent is Claude and we have a session ID', () => {
    expect(buildFallbackPrompt('claude', uuid, 'claude', 'original task')).toBe(
      `/continue ${uuid}`
    );
  });

  it('uses plain-text handoff for non-Claude next agent even with session ID', () => {
    const prompt = buildFallbackPrompt('claude', uuid, 'codex', 'refactor auth');
    expect(prompt).toContain('previous claude session was interrupted by a rate limit');
    expect(prompt).toContain(`agents sessions ${uuid}`);
    expect(prompt).toContain('Original request: refactor auth');
  });

  it('falls back to context note without session reference when no session ID is known', () => {
    const prompt = buildFallbackPrompt('codex', undefined, 'gemini', 'write tests');
    expect(prompt).toContain('previous codex session was interrupted by a rate limit');
    expect(prompt).not.toContain('agents sessions');
    expect(prompt).toContain('Original request: write tests');
  });

  it('/continue branch requires a session ID (not just Claude as next)', () => {
    // No session ID + Claude-as-next must fall through to the plain-text form.
    const prompt = buildFallbackPrompt('codex', undefined, 'claude', 'deploy');
    expect(prompt).not.toMatch(/^\/continue/);
    expect(prompt).toContain('Original request: deploy');
  });
});

describe('normalizeMode', () => {
  it.each<[string, Mode]>([
    ['plan', 'plan'],
    ['edit', 'edit'],
    ['auto', 'auto'],
    ['skip', 'skip'],
    ['full', 'skip'],          // canonical alias
    ['FULL', 'skip'],          // case insensitive
    [' Skip ', 'skip'],        // whitespace tolerant
  ])("maps '%s' → %s", (input, expected) => {
    expect(normalizeMode(input)).toBe(expected);
  });

  it.each(['', null, undefined])("throws on empty/nullish input: %s", (input) => {
    expect(() => normalizeMode(input)).toThrow(/Mode is required/);
  });

  it.each(['yolo', 'dangerous', 'ralph', 'foo', 'auto_edit'])("throws on unknown mode '%s'", (input) => {
    expect(() => normalizeMode(input)).toThrow(/Invalid mode/);
  });
});

describe('resolveMode', () => {
  it("returns the requested mode when supported (claude/skip)", () => {
    expect(resolveMode('claude', 'skip')).toBe('skip');
  });

  it("degrades 'auto' to 'edit' for agents without smart-classifier support", () => {
    // codex has no auto in its capabilities.modes — should silently degrade.
    expect(AGENTS.codex.capabilities.modes).not.toContain('auto');
    expect(resolveMode('codex', 'auto')).toBe('edit');
  });

  it("keeps 'auto' for agents that natively support it (claude, copilot)", () => {
    expect(resolveMode('claude', 'auto')).toBe('auto');
    expect(resolveMode('copilot', 'auto')).toBe('auto');
  });

  it("throws on 'skip' for agents without skip support, naming supported modes", () => {
    expect(() => resolveMode('opencode', 'skip'))
      .toThrow(/opencode does not support 'skip' mode\. Supported modes: plan, edit\./);
  });

  it("degrades 'plan' to the agent's safest mode when plan is unsupported", () => {
    // cursor / antigravity / kiro have no read-only mode — modes[0] is edit.
    expect(AGENTS.cursor.capabilities.modes).not.toContain('plan');
    expect(resolveMode('cursor', 'plan')).toBe('edit');
    expect(resolveMode('antigravity', 'plan')).toBe('edit');
    expect(resolveMode('kiro', 'plan')).toBe('edit');
  });

  it("keeps 'plan' for agents that natively support it (claude)", () => {
    expect(resolveMode('claude', 'plan')).toBe('plan');
  });

  it("throws on 'skip' for kiro (edit-only agent)", () => {
    expect(() => resolveMode('kiro', 'skip'))
      .toThrow(/kiro does not support 'skip' mode\. Supported modes: edit\./);
  });
});

describe('defaultModeFor', () => {
  it('returns the first listed mode for each agent', () => {
    // Antigravity: ['edit', 'skip'] — no plan, so default must be edit.
    expect(defaultModeFor('antigravity')).toBe('edit');
    // Cursor: ['edit', 'skip'] — same.
    expect(defaultModeFor('cursor')).toBe('edit');
    // Claude: ['plan', 'edit', 'auto', 'skip'] — plan is safest.
    expect(defaultModeFor('claude')).toBe('plan');
    // Kiro: edit-only.
    expect(defaultModeFor('kiro')).toBe('edit');
  });

  it('agrees with capabilities.modes[0] for every agent (single source of truth)', () => {
    for (const agent of ALL_AGENTS) {
      expect(defaultModeFor(agent)).toBe(AGENTS[agent].capabilities.modes[0]);
    }
  });
});

describe('headlessPlanStallCommand', () => {
  // The footgun: `ag run claude "/code:commit"` with no --mode defaults to
  // read-only plan, then hangs forever at ExitPlanMode in a headless run.
  it('blocks a slash command run headless under implicit-default plan', () => {
    expect(
      headlessPlanStallCommand({ prompt: '/code:commit', interactive: undefined, mode: 'plan', modeIsDefault: true })
    ).toBe('/code:commit');
  });

  it('returns the bare command token, dropping arguments', () => {
    expect(
      headlessPlanStallCommand({ prompt: '/code:loop RUSH-1 RUSH-2', interactive: undefined, mode: 'plan', modeIsDefault: true })
    ).toBe('/code:loop');
  });

  it('does not block an EXPLICIT --mode plan (modeIsDefault false) — read-only command runs are valid', () => {
    expect(
      headlessPlanStallCommand({ prompt: '/code-review', interactive: undefined, mode: 'plan', modeIsDefault: false })
    ).toBeNull();
  });

  it('does not block a natural-language prompt under default plan (valid research run)', () => {
    expect(
      headlessPlanStallCommand({ prompt: 'summarize recent git commits', interactive: undefined, mode: 'plan', modeIsDefault: true })
    ).toBeNull();
  });

  it('does not block interactive runs', () => {
    expect(
      headlessPlanStallCommand({ prompt: '/code:commit', interactive: true, mode: 'plan', modeIsDefault: true })
    ).toBeNull();
  });

  it('does not block when no prompt (interactive TUI)', () => {
    expect(
      headlessPlanStallCommand({ prompt: undefined, interactive: undefined, mode: 'plan', modeIsDefault: true })
    ).toBeNull();
  });

  it.each(['edit', 'auto', 'skip', 'full'])('does not block under non-plan mode %s', (mode) => {
    expect(
      headlessPlanStallCommand({ prompt: '/code:commit', interactive: undefined, mode, modeIsDefault: true })
    ).toBeNull();
  });

  it('tolerates leading whitespace before the slash command', () => {
    expect(
      headlessPlanStallCommand({ prompt: '  /deploy staging', interactive: undefined, mode: 'plan', modeIsDefault: true })
    ).toBe('/deploy');
  });
});
