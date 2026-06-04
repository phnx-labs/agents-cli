import { describe, it, expect } from 'vitest';
import {
  buildExecCommand,
  buildExecEnv,
  buildFallbackPrompt,
  detectRateLimit,
  AGENT_COMMANDS,
  parseExecEnv,
  normalizeMode,
  resolveMode,
  type ExecOptions,
} from '../exec.js';
import type { AgentId, Mode } from '../types.js';
import { AGENTS } from '../agents.js';

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

    it('codex plan produces --sandbox workspace-write', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', mode: 'plan' }));
      expect(cmd).toContain('--sandbox');
      expect(cmd[cmd.indexOf('--sandbox') + 1]).toBe('workspace-write');
      expect(cmd).not.toContain('--full-auto');
    });

    it('codex edit produces --sandbox workspace-write --full-auto', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', mode: 'edit' }));
      expect(cmd).toContain('--sandbox');
      expect(cmd).toContain('--full-auto');
    });

    it('codex skip produces --full-auto without --sandbox', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', mode: 'skip' }));
      expect(cmd).toContain('--full-auto');
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

    it('cursor plan throws (cursor has no read-only mode)', () => {
      expect(() => buildExecCommand(opts({ agent: 'cursor', mode: 'plan' })))
        .toThrow(/cursor does not support 'plan' mode/);
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

    it('no prompt behaves as interactive by default (no --print)', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', prompt: undefined, headless: true }));
      expect(cmd).not.toContain('--print');
    });

    it('prompt without interactive behaves as headless (adds --print)', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', prompt: 'fix auth', headless: true }));
      expect(cmd).toContain('--print');
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

    it('no --model flag for codex without explicit model', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex' }));
      expect(cmd).not.toContain('--model');
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

    it('codex ignores addDirs', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', addDirs: ['/a'] }));
      expect(cmd).not.toContain('--add-dir');
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
      expect(env.CLAUDE_CONFIG_DIR).toBe(
        `${process.env.HOME}/.agents/.history/versions/claude/2.1.98/home/.claude`
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
        `${process.env.HOME}/.agents/.history/versions/copilot/1.0.56/home/.copilot`
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
        '--full-auto',
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
        '--full-auto',
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

  it("throws on 'plan' for agents without plan support (cursor)", () => {
    expect(() => resolveMode('cursor', 'plan'))
      .toThrow(/cursor does not support 'plan' mode\. Supported modes: edit, skip\./);
  });

  it("throws on 'skip' for kiro (edit-only agent)", () => {
    expect(() => resolveMode('kiro', 'skip'))
      .toThrow(/kiro does not support 'skip' mode\. Supported modes: edit\./);
  });
});
