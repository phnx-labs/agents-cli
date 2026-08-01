/**
 * The session preview header surfaces the worked-on ticket and the PR the
 * session opened, so a reviewer can jump straight to Linear / GitHub from the
 * browser. Both are rendered by `buildPreview` (via `formatHeader`); we assert
 * the labels appear rather than the OSC 8 escape, which is TTY-gated.
 *
 * RUSH-2045 also surfaces compact checklist progress (✓N/M · step) from
 * SessionMeta.todos even when no transcript is on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import { buildPreview, formatTodoCompact, githubRepoUrlFromCwd, relativizeDir } from './sessions-picker.js';
import { _resetLinearWorkspaceCache } from '../lib/session/linear.js';
import type { SessionMeta, TodoProgress } from '../lib/session/types.js';

function mk(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: 'link-test-' + Math.random().toString(36).slice(2),
    shortId: 'linktest',
    agent: 'claude',
    // No filePath → buildPreview takes the metadata-only branch, which still
    // renders the header (and thus the ticket/PR line) without parsing a file.
    ...overrides,
  } as SessionMeta;
}

describe('formatTodoCompact (RUSH-2045)', () => {
  it('renders ✓done/total · activeForm', () => {
    expect(formatTodoCompact({ done: 6, total: 8, activeForm: 'A5 wiring runner' })).toBe(
      '✓6/8 · A5 wiring runner',
    );
  });

  it('omits the step when there is no in-progress item', () => {
    expect(formatTodoCompact({ done: 2, total: 2 })).toBe('✓2/2');
  });

  it('returns empty for missing / empty lists', () => {
    expect(formatTodoCompact(undefined)).toBe('');
    expect(formatTodoCompact(null)).toBe('');
    expect(formatTodoCompact({ done: 0, total: 0 })).toBe('');
  });
});

describe('githubRepoUrlFromCwd', () => {
  it('extracts owner/repo from a github.com checkout path', () => {
    expect(
      githubRepoUrlFromCwd('/home/u/src/github.com/phnx-labs/agents-cli/.agents/worktrees/x'),
    ).toBe('https://github.com/phnx-labs/agents-cli');
  });

  it('returns undefined when the path is not under github.com', () => {
    expect(githubRepoUrlFromCwd('/tmp/scratch')).toBeUndefined();
    expect(githubRepoUrlFromCwd(undefined)).toBeUndefined();
  });
});

describe('relativizeDir — readable Dirs line', () => {
  const savedHome = process.env.HOME;
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it('(a) strips the session cwd prefix, leaving the relative remainder', () => {
    expect(
      relativizeDir('/home/me/repo/apps/cli/src/lib/secrets.ts', '/home/me/repo'),
    ).toBe('apps/cli/src/lib');
  });

  it('(a) returns "." when the file sits directly in the cwd', () => {
    expect(relativizeDir('/home/me/repo/index.ts', '/home/me/repo')).toBe('.');
  });

  it('(b) collapses a worktree path to ⧉ <slug>/<remainder>', () => {
    expect(
      relativizeDir(
        '/home/me/repo/.agents/worktrees/fix-crabbox-touchid-storm/apps/cli/src/lib/crabbox/x.ts',
        '/home/me/repo',
      ),
    ).toBe('⧉ fix-crabbox-touchid-storm/apps/cli/src/lib/crabbox');
  });

  it('(b) collapses to bare ⧉ <slug> when nothing follows the worktree root', () => {
    expect(
      relativizeDir('/home/me/repo/.agents/worktrees/my-slug/README.md', '/home/me/repo'),
    ).toBe('⧉ my-slug');
  });

  it('(c) decodes a Claude project-slug instead of rendering the raw -Users- form', () => {
    // Session cwd is unrelated to the decoded path, so the last-3-segment trim applies.
    const out = relativizeDir(
      '-Users-muqsit-src-github-com-muqsitnawaz-agents-cli/abc123/scratchpad/note.md',
      '/home/muqsit/other',
    );
    expect(out).not.toContain('-Users-'); // the ugly raw slug is gone
    expect(out).toBe('cli/abc123/scratchpad');
  });

  it('(c) decodes a -home- slug and relativizes against a matching cwd', () => {
    // Decoded to /home/muqsit/src/app/lib; cwd matches, so only the remainder shows.
    expect(
      relativizeDir('-home-muqsit-src-app-lib/foo.ts', '/home/muqsit/src/app'),
    ).toBe('lib');
  });

  it('(d) collapses the home prefix to ~', () => {
    process.env.HOME = '/home/me';
    // No cwd match; home → ~, and the path is shallow enough to keep in full.
    expect(relativizeDir('/home/me/notes/todo.md')).toBe('~/notes');
  });

  it('(e) skips node_modules paths (undefined)', () => {
    expect(
      relativizeDir('/home/me/repo/node_modules/chalk/index.js', '/home/me/repo'),
    ).toBeUndefined();
  });

  it('(e) skips .git and plans paths (undefined)', () => {
    expect(relativizeDir('/home/me/repo/.git/config', '/home/me/repo')).toBeUndefined();
    expect(relativizeDir('/home/me/repo/plans/x.md', '/home/me/repo')).toBeUndefined();
  });
});

describe('buildPreview — ticket + PR links line', () => {
  const savedEnv = process.env.LINEAR_WORKSPACE;
  beforeEach(() => {
    _resetLinearWorkspaceCache();
    process.env.LINEAR_WORKSPACE = 'acme';
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LINEAR_WORKSPACE;
    else process.env.LINEAR_WORKSPACE = savedEnv;
    _resetLinearWorkspaceCache();
  });

  it('shows the ticket id and PR number in the preview', () => {
    const preview = stripVTControlCharacters(
      buildPreview(mk({ ticketId: 'RUSH-1864', prUrl: 'https://github.com/o/r/pull/42', prNumber: 42 })),
    );
    expect(preview).toContain('RUSH-1864');
    expect(preview).toContain('PR#42');
  });

  it('embeds the canonical Linear + GitHub URLs as OSC 8 hyperlink targets when linkable', () => {
    // The raw preview (escapes intact) should carry the hyperlink targets IF the
    // terminal supports OSC 8. In a non-TTY test env it degrades to plain text, so
    // we only assert the target is present when an escape was actually emitted.
    const raw = buildPreview(
      mk({ ticketId: 'RUSH-1864', prUrl: 'https://github.com/o/r/pull/42', prNumber: 42 }),
    );
    if (raw.includes('\x1b]8;;')) {
      expect(raw).toContain('https://linear.app/acme/issue/RUSH-1864');
      expect(raw).toContain('https://github.com/o/r/pull/42');
    } else {
      expect(stripVTControlCharacters(raw)).toContain('RUSH-1864');
    }
  });

  it('omits the links line entirely when the session has neither', () => {
    const preview = stripVTControlCharacters(buildPreview(mk({})));
    expect(preview).not.toContain('PR#');
    expect(preview).not.toContain('issue/');
  });

  it('surfaces SessionMeta.todos as compact ✓N/M even without a transcript (RUSH-2045)', () => {
    const todos: TodoProgress = {
      items: [
        { content: 'Step one', status: 'completed' },
        { content: 'Step two', status: 'in_progress', activeForm: 'A5 wiring runner' },
      ],
      done: 1,
      total: 2,
      activeForm: 'A5 wiring runner',
    };
    const preview = stripVTControlCharacters(
      buildPreview(mk({ todos, topic: 'Land the checklist views', project: 'agents-cli' })),
    );
    expect(preview).toContain('✓1/2 · A5 wiring runner');
    expect(preview).toContain('Todos:');
    // Originating prompt falls back to topic when there is no transcript.
    expect(preview).toContain('Prompt:');
    expect(preview).toContain('Land the checklist views');
    // Identity: shortId + project still in the header.
    expect(preview).toContain('linktest');
    expect(preview).toContain('agents-cli');
  });

  it('handles empty todos gracefully (no Todos: line)', () => {
    const preview = stripVTControlCharacters(buildPreview(mk({ topic: 'no checklist' })));
    expect(preview).not.toContain('Todos:');
    expect(preview).not.toContain('✓');
  });
});
