import { describe, it, expect } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import { renderSummary } from './render.js';
import type { SessionEvent } from './types.js';

const T = '2026-08-03T10:00:00Z';
function tool(name: string, args: Record<string, any> = {}, p?: string): SessionEvent {
  return { type: 'tool_use', agent: 'claude', timestamp: T, tool: name, args, path: p };
}

describe('renderSummary — Plan checklist status markers', () => {
  it('marks completed / in-progress / pending items instead of plain bullets', () => {
    const out = stripVTControlCharacters(renderSummary([
      tool('TodoWrite', {
        todos: [
          { content: 'done step', status: 'completed' },
          { content: 'active step', status: 'in_progress' },
          { content: 'later step', status: 'pending' },
        ],
      }),
    ]));
    expect(out).toContain('[x] done step');
    expect(out).toContain('[>] active step');
    expect(out).toContain('[ ] later step');
    expect(out).not.toContain('· done step');
  });

  it('renders the checklist alongside ExitPlanMode text (not either/or)', () => {
    const out = stripVTControlCharacters(renderSummary([
      tool('ExitPlanMode', { plan: '# The plan\n\n1. do things' }),
      tool('TodoWrite', { todos: [{ content: 'checklist step', status: 'completed' }] }),
    ]));
    expect(out).toContain('# The plan');
    expect(out).toContain('[x] checklist step');
  });
});

describe('renderSummary — Changes worktree collapse', () => {
  it('collapses out-of-cwd worktree prefixes to ⧉ <slug>/…', () => {
    const out = stripVTControlCharacters(renderSummary([
      tool('Write', { file_path: '/home/u/repo/.agents/worktrees/feat-x/apps/cli/a.ts' }, '/home/u/repo/.agents/worktrees/feat-x/apps/cli/a.ts'),
    ], '/home/u/repo'));
    expect(out).toContain('⧉ feat-x/apps/cli/');
    expect(out).not.toContain('.agents/worktrees/feat-x/apps/cli/a.ts');
  });

  it('keeps cwd-relative labels for files inside the cwd', () => {
    const out = stripVTControlCharacters(renderSummary([
      tool('Write', { file_path: '/home/u/repo/apps/cli/a.ts' }, '/home/u/repo/apps/cli/a.ts'),
    ], '/home/u/repo'));
    expect(out).toContain('apps/cli/');
    expect(out).not.toContain('/home/u/repo');
  });
});

describe('renderSummary — highlight sections', () => {
  const events: SessionEvent[] = [
    tool('Skill', { skill: 'teams' }),
    { type: 'hook', agent: 'claude', timestamp: T, hookName: 'SessionStart:startup', hookEvent: 'SessionStart', success: true },
    { type: 'message', agent: 'claude', timestamp: T, role: 'user', content: 'see https://linear.app/ws/issue/RUSH-2076/slug' },
    tool('Write', { file_path: '/repo/.agents/artifacts/plan.html' }, '/repo/.agents/artifacts/plan.html'),
  ];

  it('renders Skills, Hooks, Links, Artifacts sections', () => {
    const out = stripVTControlCharacters(renderSummary(events, '/repo'));
    expect(out).toMatch(/Skills \(1\)\s+teams/);
    expect(out).toMatch(/Hooks \(1\)\s+SessionStart:startup/);
    expect(out).toMatch(/Links \(1\)\s+RUSH-2076/);
    expect(out).toContain('Artifacts (1)');
    expect(out).toContain('plan.html');
  });

  it('omits sections with no data', () => {
    const out = stripVTControlCharacters(renderSummary([tool('Read', {}, '/repo/a.ts')], '/repo'));
    expect(out).not.toContain('Skills');
    expect(out).not.toContain('Hooks');
    expect(out).not.toContain('Links');
    expect(out).not.toContain('Artifacts');
  });
});
