import { describe, it, expect } from 'vitest';
import {
  formatTmuxKillLabel,
  formatTmuxKillPreview,
  tmuxScreenPreview,
  tmuxScreenSnippet,
} from './tmux.js';
import type { ListedSession } from '../lib/tmux/index.js';

const TRUST_FOLDER = `
 Accessing workspace:

 /tmp/session-tracker-test-fd955907-2345-4e8d-adcf-2a543a08c7b9

 Quick safety check: Is this a project you created or one you trust?

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

const WEEKLY_LIMIT = `
  You hit your weekly limit.

  1 (○) Upgrade tier      Upgrade to a higher tier for more usage
  2 (○) Buy more credits  Purchase credits to keep using Grok Build
`;

function row(over: Partial<ListedSession> = {}): ListedSession {
  return {
    name: 'ag-claude-04a1307c',
    socket: '/tmp/sock',
    createdAtTmux: 1_777_200_000,
    windows: 1,
    attached: false,
    meta: {
      name: 'ag-claude-04a1307c',
      socket: '/tmp/sock',
      createdAt: 1_777_200_000_000,
      source: 'cli',
      cwd: '/tmp/session-tracker-test-fd955907',
      cmd: 'agents run claude --interactive',
      labels: { agent: 'claude' },
    },
    ...over,
  };
}

describe('tmuxScreenSnippet — last useful pane lines', () => {
  it('surfaces the trust-folder prompt, not the chrome', () => {
    const snippet = tmuxScreenSnippet(TRUST_FOLDER);
    expect(snippet).toContain('I trust this folder');
    expect(snippet).not.toMatch(/^ag-claude/);
  });

  it('surfaces a weekly-limit dialog', () => {
    expect(tmuxScreenSnippet(WEEKLY_LIMIT)).toMatch(/weekly limit/i);
  });

  it('collapses padding and truncates', () => {
    const long = 'x'.repeat(200);
    expect(tmuxScreenSnippet(`\n\n  ${long}  \n`).length).toBeLessThanOrEqual(72);
  });
});

describe('tmuxScreenPreview / kill picker copy', () => {
  it('keeps the last non-empty lines of the pane', () => {
    const preview = tmuxScreenPreview(TRUST_FOLDER, 8);
    expect(preview).toContain('Yes, I trust this folder');
    expect(preview).toContain('No, exit');
  });

  it('labels a row with name, age, agent, and snippet', () => {
    const label = formatTmuxKillLabel(row(), tmuxScreenSnippet(TRUST_FOLDER), 1_777_200_000 * 1000 + 60_000);
    expect(label).toContain('ag-claude-04a1307c');
    expect(label).toContain('claude');
    expect(label).toContain('I trust this folder');
  });

  it('preview names the cwd and the live screen so a leaked pane is obvious', () => {
    const preview = formatTmuxKillPreview(row(), TRUST_FOLDER, 1_777_200_000 * 1000 + 60_000);
    expect(preview).toContain('ag-claude-04a1307c');
    expect(preview).toContain('/tmp/session-tracker-test-fd955907');
    expect(preview).toContain('last screen');
    expect(preview).toContain('I trust this folder');
    expect(preview).toContain('detached');
  });
});
