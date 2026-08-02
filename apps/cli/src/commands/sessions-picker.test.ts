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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

  it('(b) collapses a worktree path to ⧉ <slug>/<remainder> when NOT under cwd', () => {
    // cwd unrelated to the worktree → collapse applies for disambiguation.
    expect(
      relativizeDir(
        '/home/me/repo/.agents/worktrees/fix-crabbox-touchid-storm/apps/cli/src/lib/crabbox/x.ts',
        '/home/me/other',
      ),
    ).toBe('⧉ fix-crabbox-touchid-storm/apps/cli/src/lib/crabbox');
  });

  it('(b) collapses to bare ⧉ <slug> when nothing follows the worktree root', () => {
    expect(
      relativizeDir('/home/me/repo/.agents/worktrees/my-slug/README.md', '/home/me/other'),
    ).toBe('⧉ my-slug');
  });

  it('(A) cwd INSIDE the worktree, file under cwd → concise cwd-relative, NOT ⧉ (regression)', () => {
    // The dominant case in this repo: the session edits its own worktree. cwd-relative
    // must win so paths stay concise (`src/lib`), never longer `⧉ <slug>/apps/cli/src/lib`.
    const cwd = '/home/me/repo/.agents/worktrees/fix-session-dirs/apps/cli';
    const out = relativizeDir(`${cwd}/src/lib/foo.ts`, cwd);
    expect(out).toBe('src/lib');
    expect(out).not.toContain('⧉');
  });

  it('(B) cwd in worktree X, file in a DIFFERENT worktree Y → ⧉ Y/<remainder>', () => {
    // Touched dir is a genuinely different worktree than the session cwd, so the
    // collapse still applies (it disambiguates the other worktree).
    expect(
      relativizeDir(
        '/home/me/repo/.agents/worktrees/worktree-y/apps/cli/src/lib/bar.ts',
        '/home/me/repo/.agents/worktrees/worktree-x/apps/cli',
      ),
    ).toBe('⧉ worktree-y/apps/cli/src/lib');
  });

  it('(c1) collapses a `--`/dot-dir worktree slug to ⧉ <name> (never a lossy // path)', () => {
    // Real Claude slug: cwd /home/muqsit/.agents/repos/x/.agents/worktrees/rush1506
    // encodes `.` and `/` to `-`, so `/.agents/worktrees/` becomes `--agents-worktrees-`.
    const out = relativizeDir(
      '-home-muqsit--agents-repos-x--agents-worktrees-rush1506/sess-id/scratchpad/n.md',
      '/home/muqsit/other',
    );
    expect(out).not.toContain('//'); // no mangled dot-dir path
    expect(out).toBe('⧉ rush1506'); // worktree name recovered from the encoded marker
  });

  it('(c2) drops a slug that is this session\'s own cwd (internal projects-storage scratch)', () => {
    // slug === encodeClaudeSlug(cwd) → the leaked `<id>/scratchpad` is Claude's
    // internal store, not a code dir, so it is dropped like node_modules.
    expect(
      relativizeDir(
        '-home-muqsit-src-github-com-phnx-labs-agents-cli/sess-id/scratchpad/n.md',
        '/home/muqsit/src/github.com/phnx-labs/agents-cli',
      ),
    ).toBeUndefined();
  });

  it('(c3) leaves a genuine local absolute path with dashes UNTOUCHED (no false slug-decode)', () => {
    // Starts with `/`, not `-`, so the slug branch never fires; normal cwd-relativize.
    expect(
      relativizeDir(
        '/home/me/src/phnx-labs/agents-cli/apps/cli/x.ts',
        '/home/me/src/phnx-labs/agents-cli',
      ),
    ).toBe('apps/cli');
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

describe('buildPreview — usage metadata (RUSH-1994)', () => {
  it('shows browser/computer use and the sub-agent count from a real transcript', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-preview-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: 'user', timestamp: '2026-08-01T14:00:00.000Z', cwd: dir, sessionId: 'rich-meta-session', version: '2.1.112', message: { role: 'user', content: 'Inspect the UI' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T14:00:10.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { prompt: 'Explore' } }] } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T14:00:12.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'agents browser list' } }, { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'agents computer screenshot' } }] } }),
      ].join('\n') + '\n');

      const preview = stripVTControlCharacters(buildPreview(mk({
        id: 'rich-meta-session',
        shortId: 'richmeta',
        filePath,
        cwd: dir,
      })));
      expect(preview).toContain('sonnet-4');
      expect(preview).toContain('browser');
      expect(preview).toContain('computer');
      expect(preview).toContain('1 sub-agent');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
