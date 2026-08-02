import { describe, it, expect } from 'vitest';
import { buildRunFinishNotification } from './run-notify.js';
import { buildMenubarNotifyArgs } from './menubar/notify-desktop.js';

describe('run finish notification', () => {
  it('names the run by its --name slug and reports success', () => {
    const n = buildRunFinishNotification(
      {
        agent: 'claude',
        name: 'it-seems-like-the-to',
        prompt: 'Fix the Kimi to-do parsing in the session preview',
        cwd: '/Users/muqsit/src/github.com/muqsitnawaz/agents-cli',
      },
      0,
    );
    expect(n.title).toBe('it-seems-like-the-to finished');
    expect(n.body).toBe('Fix the Kimi to-do parsing in the session preview');
    expect(n.subtitle).toBe('agents-cli');
  });

  it('reports a non-zero exit as failed and falls back to the agent name', () => {
    const n = buildRunFinishNotification({ agent: 'codex', prompt: 'ship it' }, 1);
    expect(n.title).toBe('codex failed');
    expect(n.body).toBe('ship it');
    expect(n.subtitle).toBeUndefined();
  });

  it('names the box for an off-box dispatch', () => {
    const n = buildRunFinishNotification(
      { agent: 'claude', prompt: 'p', cwd: '/repos/agents-cli', host: 'yosemite-s0' },
      0,
    );
    expect(n.subtitle).toBe('agents-cli · yosemite-s0');
  });

  it('collapses a multi-line prompt and caps the body', () => {
    const n = buildRunFinishNotification(
      { agent: 'claude', prompt: `line one\n  line two\n\n${'x'.repeat(300)}` },
      0,
    );
    expect(n.body).not.toContain('\n');
    expect(n.body.length).toBeLessThanOrEqual(120);
    expect(n.body.endsWith('…')).toBe(true);
  });

  it('carries a clickable URL through to the helper argv', () => {
    const n = buildRunFinishNotification(
      { agent: 'claude', name: 'kimi-todo', prompt: 'p', url: 'https://github.com/phnx-labs/agents-cli/pull/1690' },
      0,
    );
    expect(n.action).toBe('url:https://github.com/phnx-labs/agents-cli/pull/1690');
    expect(buildMenubarNotifyArgs(n)).toEqual([
      '--notify',
      '--title', 'kimi-todo finished',
      '--body', 'p',
      '--action', 'url:https://github.com/phnx-labs/agents-cli/pull/1690',
    ]);
  });
});
