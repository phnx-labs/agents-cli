import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { buildJobCommand, extractReport } from '../src/lib/runner.js';
import { toPosix } from '../src/lib/platform/index.js';
import type { JobConfig } from '../src/lib/jobs.js';

const TEST_DIR = join(tmpdir(), 'agents-cli-runner-test');

function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'test-job',
    schedule: '0 9 * * *',
    agent: 'claude',
    mode: 'plan',
    effort: 'default',
    timeout: '30m',
    enabled: true,
    prompt: 'do something',
    ...overrides,
  };
}

describe('buildJobCommand', () => {
  describe('claude', () => {
    it('builds basic plan mode command', () => {
      const cmd = buildJobCommand(makeConfig(), 'hello world');
      expect(cmd[0]).toBe('claude');
      expect(cmd).toContain('-p');
      expect(cmd).toContain('hello world');
      expect(cmd).toContain('--permission-mode');
      expect(cmd).toContain('plan');
    });

    it('switches to acceptEdits in edit mode', () => {
      const cmd = buildJobCommand(makeConfig({ mode: 'edit' }), 'hello');
      expect(cmd).toContain('acceptEdits');
      expect(cmd).not.toContain('plan');
    });

    it('adds --add-dir for allowed dirs', () => {
      const config = makeConfig({
        allow: { dirs: ['~/projects/foo', '~/reports'] },
      });
      const cmd = buildJobCommand(config, 'hello');
      const addDirIndices = cmd.reduce<number[]>((acc, v, i) => {
        if (v === '--add-dir') acc.push(i);
        return acc;
      }, []);
      expect(addDirIndices.length).toBe(2);
      // The `~` expansion (os.homedir() + the rest of the entry) yields mixed
      // separators on Windows; compare separator-agnostically.
      expect(toPosix(cmd[addDirIndices[0] + 1])).toBe(toPosix(join(homedir(), 'projects/foo')));
      expect(toPosix(cmd[addDirIndices[1] + 1])).toBe(toPosix(join(homedir(), 'reports')));
    });

    it('adds --model flag when config.model is set', () => {
      const config = makeConfig({ config: { model: 'claude-sonnet-4-5' } });
      const cmd = buildJobCommand(config, 'hello');
      const modelIdx = cmd.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(cmd[modelIdx + 1]).toBe('claude-sonnet-4-5');
    });

    it('does not add --model when not set', () => {
      const cmd = buildJobCommand(makeConfig(), 'hello');
      expect(cmd).not.toContain('--model');
    });
  });

  describe('codex', () => {
    it('builds basic command', () => {
      const cmd = buildJobCommand(makeConfig({ agent: 'codex' }), 'hello');
      expect(cmd[0]).toBe('codex');
      expect(cmd).toContain('exec');
      expect(cmd).toContain('hello');
    });

    it('adds --dangerously-bypass-approvals-and-sandbox in edit mode', () => {
      const cmd = buildJobCommand(makeConfig({ agent: 'codex', mode: 'edit' }), 'hello');
      expect(cmd).toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    it('does not add bypass flag in plan mode', () => {
      const cmd = buildJobCommand(makeConfig({ agent: 'codex', mode: 'plan' }), 'hello');
      expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    it('adds --model flag when config.model is set', () => {
      const config = makeConfig({ agent: 'codex', config: { model: 'gpt-5.2-codex' } });
      const cmd = buildJobCommand(config, 'hello');
      const modelIdx = cmd.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(cmd[modelIdx + 1]).toBe('gpt-5.2-codex');
    });
  });

  describe('gemini', () => {
    it('builds basic command', () => {
      const cmd = buildJobCommand(makeConfig({ agent: 'gemini' }), 'hello');
      expect(cmd[0]).toBe('gemini');
      expect(cmd).toContain('hello');
    });

    it('adds --approval-mode auto_edit in edit mode', () => {
      const cmd = buildJobCommand(makeConfig({ agent: 'gemini', mode: 'edit' }), 'hello');
      expect(cmd).toContain('--approval-mode');
      expect(cmd[cmd.indexOf('--approval-mode') + 1]).toBe('auto_edit');
    });

    it('adds --yolo in skip mode (formerly full)', () => {
      const cmd = buildJobCommand(makeConfig({ agent: 'gemini', mode: 'skip' }), 'hello');
      expect(cmd).toContain('--yolo');
    });

    it("legacy 'full' alias still produces --yolo for gemini", () => {
      const cmd = buildJobCommand(makeConfig({ agent: 'gemini', mode: 'full' as any }), 'hello');
      expect(cmd).toContain('--yolo');
    });

    it('does not add --yolo in plan mode', () => {
      const cmd = buildJobCommand(makeConfig({ agent: 'gemini', mode: 'plan' }), 'hello');
      expect(cmd).not.toContain('--yolo');
    });

    it('adds --model flag when config.model is set', () => {
      const config = makeConfig({ agent: 'gemini', config: { model: 'gemini-2.5-pro' } });
      const cmd = buildJobCommand(config, 'hello');
      const modelIdx = cmd.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(cmd[modelIdx + 1]).toBe('gemini-2.5-pro');
    });
  });

  it('throws for unsupported agent', () => {
    expect(() => buildJobCommand(makeConfig({ agent: 'cursor' }), 'hello')).toThrow(
      'Unsupported agent for daemon jobs: cursor'
    );
  });
});

describe('extractReport', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('extracts last text from claude stream-json', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'First message' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Final report here' }] },
      }),
    ];
    const logPath = join(TEST_DIR, 'claude.log');
    writeFileSync(logPath, lines.join('\n'), 'utf-8');

    expect(extractReport(logPath, 'claude')).toBe('Final report here');
  });

  it('extracts last text from codex output', () => {
    const lines = [
      JSON.stringify({ type: 'message', content: 'First' }),
      JSON.stringify({ type: 'message', content: 'Second report' }),
    ];
    const logPath = join(TEST_DIR, 'codex.log');
    writeFileSync(logPath, lines.join('\n'), 'utf-8');

    expect(extractReport(logPath, 'codex')).toBe('Second report');
  });

  it('extracts last text from gemini output', () => {
    const lines = [
      JSON.stringify({ type: 'text', text: 'First' }),
      JSON.stringify({ type: 'text', text: 'Gemini final report' }),
    ];
    const logPath = join(TEST_DIR, 'gemini.log');
    writeFileSync(logPath, lines.join('\n'), 'utf-8');

    expect(extractReport(logPath, 'gemini')).toBe('Gemini final report');
  });

  it('returns null for nonexistent file', () => {
    expect(extractReport('/tmp/nonexistent-file-xyz.log', 'claude')).toBeNull();
  });

  it('returns null for empty file', () => {
    const logPath = join(TEST_DIR, 'empty.log');
    writeFileSync(logPath, '', 'utf-8');
    expect(extractReport(logPath, 'claude')).toBeNull();
  });

  it('handles non-JSON lines gracefully', () => {
    const lines = [
      'not json',
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'valid' }] },
      }),
      'also not json',
    ];
    const logPath = join(TEST_DIR, 'mixed.log');
    writeFileSync(logPath, lines.join('\n'), 'utf-8');

    expect(extractReport(logPath, 'claude')).toBe('valid');
  });

  it('skips non-text content blocks for claude', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: {} },
            { type: 'text', text: 'The actual report' },
          ],
        },
      }),
    ];
    const logPath = join(TEST_DIR, 'claude-tools.log');
    writeFileSync(logPath, lines.join('\n'), 'utf-8');

    expect(extractReport(logPath, 'claude')).toBe('The actual report');
  });
});
