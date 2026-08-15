/**
 * The session preview header surfaces the worked-on ticket and the PR the
 * session opened, so a reviewer can jump straight to Linear / GitHub from the
 * browser. Both are rendered by `buildPreview` (via `formatHeader`); we assert
 * the labels appear rather than the OSC 8 escape, which is TTY-gated.
 *
 * RUSH-2045 also surfaces compact checklist progress (✓N/M · step) from
 * SessionMeta.todos even when no transcript is on disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  buildPreview,
  clearPreviewMemoryCacheForTest,
  clearRemoteDigestCacheForTest,
  extractTiming,
  formatTodoCompact,
  githubRepoUrlFromCwd,
  relativizeDir,
  sanitizeRemoteDigest,
  setPeerDigestFetcherForTest,
  setRemotePreviewRepaint,
} from './sessions-picker.js';
import { limitPreviewHeight, pickerPageSize, PREVIEW_MIN_ROWS } from '../lib/picker.js';
import { _resetLinearWorkspaceCache } from '../lib/session/linear.js';
import type { SessionEvent, SessionMeta, TodoProgress } from '../lib/session/types.js';

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

describe('buildPreview — highlight lines (skills, hooks, links, artifacts, errors, repos)', () => {
  it('renders the new sections from a real transcript', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-preview-hl-'));
    try {
      fs.mkdirSync(path.join(dir, '.git')); // a repo, so Repos: names it
      const filePath = path.join(dir, 'session.jsonl');
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: 'user', timestamp: '2026-08-01T14:00:00.000Z', message: { role: 'user', content: 'Fix https://linear.app/acme/issue/RUSH-2076/slug' } }),
        JSON.stringify({ type: 'attachment', timestamp: '2026-08-01T14:00:01.000Z', attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', exitCode: 0 } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T14:00:10.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'teams' } }] } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T14:00:12.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: path.join(dir, '.agents', 'artifacts', 'plan.html') } }] } }),
        JSON.stringify({ type: 'user', timestamp: '2026-08-01T14:00:13.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', is_error: true, content: 'disk full' }] } }),
      ].join('\n') + '\n');

      const preview = stripVTControlCharacters(buildPreview(mk({
        id: 'highlights-session',
        shortId: 'highligh',
        filePath,
        cwd: dir,
      })));
      expect(preview).toContain('Skills:');
      expect(preview).toContain('teams');
      expect(preview).toContain('Hooks:');
      expect(preview).toContain('SessionStart:startup');
      expect(preview).toContain('Links:');
      expect(preview).toContain('RUSH-2076');
      expect(preview).toContain('Artifacts:');
      expect(preview).toContain('plan.html');
      expect(preview).toContain('Errors:');
      expect(preview).toContain('1 failure');
      expect(preview).toContain('Repos:');
      expect(preview).toContain(path.basename(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits highlight lines when the transcript has none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-preview-nohl-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: 'user', timestamp: '2026-08-01T14:00:00.000Z', message: { role: 'user', content: 'plain task' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T14:00:10.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: path.join(dir, 'a.ts') } }] } }),
      ].join('\n') + '\n');
      const preview = stripVTControlCharacters(buildPreview(mk({
        id: 'no-highlights-session',
        shortId: 'nohighl',
        filePath,
        cwd: dir,
      })));
      expect(preview).not.toContain('Skills:');
      expect(preview).not.toContain('Hooks:');
      expect(preview).not.toContain('Links:');
      expect(preview).not.toContain('Artifacts:');
      expect(preview).not.toContain('Errors:');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it('#11: a computed usedBrowser/usedComputer=true wins even when the transcript has no matching tool_use at all', () => {
    // The persisted field comes from a real browser.navigate/computer.action
    // event at scan time — it must not depend on classifySessionTool's
    // transcript-regex heuristic ever having matched anything.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-preview-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: 'user', timestamp: '2026-08-01T14:00:00.000Z', cwd: dir, sessionId: 'persisted-true-session', message: { role: 'user', content: 'Do the thing' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T14:00:10.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: path.join(dir, 'a.ts') } }] } }),
      ].join('\n') + '\n');

      const preview = stripVTControlCharacters(buildPreview(mk({
        id: 'persisted-true-session', shortId: 'persist1', filePath, cwd: dir,
        usedBrowser: true, usedComputer: true,
      })));
      expect(preview).toContain('browser');
      expect(preview).toContain('computer');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#11: a computed usedBrowser/usedComputer=false suppresses the tag even when the transcript regex would have matched', () => {
    // Reading the persisted field FIRST means a definite computed negative is
    // trusted over the fuzzy regex — only session.usedBrowser === undefined
    // (a legacy, never-scanned row) falls back to classifySessionTool.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-preview-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: 'user', timestamp: '2026-08-01T14:00:00.000Z', cwd: dir, sessionId: 'persisted-false-session', message: { role: 'user', content: 'Do the thing' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T14:00:10.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'agents browser list' } }, { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'agents computer screenshot' } }] } }),
      ].join('\n') + '\n');

      const preview = stripVTControlCharacters(buildPreview(mk({
        id: 'persisted-false-session', shortId: 'persist0', filePath, cwd: dir,
        usedBrowser: false, usedComputer: false,
      })));
      expect(preview).not.toContain('browser');
      expect(preview).not.toContain('computer');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('remote preview body — richer, and sanitized', () => {
  // A remote row's meta is peer-supplied JSON that parseRemoteList hands over
  // verbatim, so every field the preview newly renders has to be scrubbed before
  // it reaches the terminal.
  const remote = (over: Partial<SessionMeta>): SessionMeta =>
    mk({ machine: 'zion', _remote: true, ...over } as Partial<SessionMeta>);

  it('renders the directories the scan recorded on the row', () => {
    const out = stripVTControlCharacters(
      buildPreview(remote({ recentDirectoriesTouched: ['apps/cli/src', 'docs'] }))
    );
    expect(out).toContain('apps/cli/src');
    expect(out).toContain('docs');
  });

  it('summarizes the plan instead of pasting the markdown blob', () => {
    const plan = '# Rework the scanner\n\nstep one\nstep two\nstep three';
    const out = stripVTControlCharacters(buildPreview(remote({ plan })));
    expect(out).toContain('Rework the scanner');
    expect(out).toContain('5 lines');
    expect(out).not.toContain('step three');
  });

  it('renders the team lineage for a peer teammate row', () => {
    const out = stripVTControlCharacters(
      buildPreview(remote({ teamOrigin: { handle: 'ui', team: 'redesign', parentSessionId: 'orch1234-aaaa' } }))
    );
    expect(out).toContain('redesign');
    expect(out).toContain('spawned by orch1234');
  });

  it('strips terminal escapes out of a peer-supplied plan and dir list', () => {
    const out = buildPreview(
      remote({
        plan: '\x1b[31mred plan title\x1b[0m',
        recentDirectoriesTouched: ['\x1b]0;pwned\x07apps/cli'],
      })
    );
    expect(out).not.toContain('\x1b[31m');
    expect(out).not.toContain('\x1b]0;');
    expect(stripVTControlCharacters(out)).toContain('red plan title');
  });
});

/**
 * A remote row's pane fetches the peer's already-computed digest over SSH and
 * renders the full compact preview — the metadata-only card is only the
 * pending/failed state, not the destination (the "remote sessions show no real
 * preview" gap).
 */
describe('remote preview — fetched peer digest fills the pane', () => {
  const remote = (over: Partial<SessionMeta>): SessionMeta =>
    mk({ machine: 'peerbox', _remote: true, ...over } as Partial<SessionMeta>);

  const digest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    schemaVersion: 1,
    firstUser: 'Fix the fan-out preview',
    lastAssistant: 'Landed the fix in remote-list.ts and verified the pane.',
    filesRead: 3,
    toolCalls: 7,
    planFile: '',
    subAgentCount: 0,
    toolTags: [],
    changes: { created: 1, modified: 2, deleted: 0 },
    dirs: ['apps/cli/src'],
    repos: ['agents-cli'],
    artifacts: [],
    skills: [{ name: 'review', count: 2 }],
    plugins: [],
    hooks: [],
    links: [],
    errorCount: 0,
    toolHistogram: [{ tool: 'Bash', count: 4 }],
    ...over,
  });

  afterEach(() => {
    setPeerDigestFetcherForTest(undefined);
    setRemotePreviewRepaint(undefined);
    clearRemoteDigestCacheForTest();
    clearPreviewMemoryCacheForTest();
  });

  it('kicks off the fetch on first render and shows the fetching note meanwhile', async () => {
    let resolveFetch!: (v: unknown) => void;
    setPeerDigestFetcherForTest(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const session = remote({ id: 'pend-1', topic: 'Fix the fan-out preview' });

    const first = stripVTControlCharacters(buildPreview(session));
    expect(first).toContain('fetching preview from peerbox over SSH');
    expect(first).toContain('on peerbox');

    resolveFetch(digest());
    await new Promise((r) => setImmediate(r));

    const after = stripVTControlCharacters(buildPreview(session));
    expect(after).not.toContain('fetching preview');
    expect(after).toContain('Fix the fan-out preview');
    expect(after).toContain('Landed the fix in remote-list.ts');
    expect(after).toContain('apps/cli/src');
    expect(after).toContain('review');
  });

  it('repaints the open picker when the digest lands', async () => {
    setPeerDigestFetcherForTest(async () => digest());
    const repaint = vi.fn();
    setRemotePreviewRepaint(repaint);
    buildPreview(remote({ id: 'repaint-1' }));
    await new Promise((r) => setImmediate(r));
    expect(repaint).toHaveBeenCalled();
  });

  it('falls back to the metadata card when the peer cannot answer, without re-fetching per keystroke', async () => {
    const fetcher = vi.fn(async () => undefined);
    setPeerDigestFetcherForTest(fetcher);
    const session = remote({ id: 'fail-1', topic: 'peer is asleep' });

    buildPreview(session);
    await new Promise((r) => setImmediate(r));
    const after = stripVTControlCharacters(buildPreview(session));
    expect(after).toContain('on peerbox');
    expect(after).not.toContain('fetching preview');
    expect(after).toContain('peer is asleep'); // metadata-only Prompt line

    buildPreview(session);
    expect(fetcher).toHaveBeenCalledTimes(1); // failed entry is cached, not retried per render
  });

  it('scrubs terminal escapes from every peer-supplied digest string', async () => {
    setPeerDigestFetcherForTest(async () => digest({
      firstUser: '\x1b[31mred prompt\x1b[0m',
      lastAssistant: '\x1b]0;pwned\x07done',
      dirs: ['\x1b[2Jsrc'],
      skills: [{ name: '\x1b[31mevil\x1b[0m', count: 1 }],
    }));
    const session = remote({ id: 'scrub-1' });
    buildPreview(session);
    await new Promise((r) => setImmediate(r));
    const out = buildPreview(session);
    expect(out).not.toContain('\x1b[31m');
    expect(out).not.toContain('\x1b]0;');
    expect(out).not.toContain('\x1b[2J');
    expect(stripVTControlCharacters(out)).toContain('red prompt');
  });
});

describe('sanitizeRemoteDigest — version-skew and shape defense', () => {
  it('rejects a non-object and a digest with the wrong schemaVersion', () => {
    expect(sanitizeRemoteDigest(undefined)).toBeUndefined();
    expect(sanitizeRemoteDigest('nope')).toBeUndefined();
    expect(sanitizeRemoteDigest([])).toBeUndefined();
    expect(sanitizeRemoteDigest({ schemaVersion: 2 })).toBeUndefined();
  });

  it('coerces malformed fields instead of throwing', () => {
    const d = sanitizeRemoteDigest({
      schemaVersion: 1,
      firstUser: 42,
      toolCalls: 'many',
      dirs: [1, 'src', null],
      todos: { items: [{ content: 'step', status: 'bogus' }, 'junk'], done: '3', total: 5 },
      links: [{ url: 'file:///etc/passwd', label: 'x' }, { url: 'https://github.com/a/b', label: 'a/b' }],
    });
    expect(d).toBeDefined();
    expect(d!.firstUser).toBe('');
    expect(d!.toolCalls).toBe(0);
    expect(d!.dirs).toEqual(['src']);
    expect(d!.todos).toEqual({ items: [{ content: 'step', status: 'pending', activeForm: undefined }], done: 0, total: 5, activeForm: undefined });
    // Non-http(s) URLs never become OSC 8 hyperlinks.
    expect(d!.links).toEqual([{ kind: 'other', url: 'https://github.com/a/b', label: 'a/b' }]);
  });
});

/**
 * The timing line used to come from the parsed transcript alone, so the two
 * sessions you most often browse for — a remote one, and a live one not indexed
 * on this box — showed no timing at all. It reads the indexed SessionMeta as
 * well now, and reports creation and last activity as separate fields.
 */
describe('extractTiming — created / last active / lasted', () => {
  afterEach(() => vi.useRealTimers());

  const message = (timestamp: string): SessionEvent =>
    ({ type: 'message', role: 'user', content: 'hi', timestamp } as SessionEvent);

  const times = (over: Partial<SessionMeta> = {}) =>
    mk({ timestamp: '2026-07-01T12:00:00.000Z', ...over });

  it('reads the transcript when there is one', () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(
      extractTiming(times(), [message('2026-07-04T09:00:00.000Z'), message('2026-07-04T11:00:00.000Z')]),
    ).toEqual({ createdAgo: '3h', lastActiveAgo: '1h', duration: '2h' });
  });

  it('falls back to the indexed metadata when there is no transcript to parse', () => {
    // The remote-session case: this line was blank before.
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(extractTiming(times({ lastActivity: '2026-07-04T10:00:00.000Z' }), [])).toEqual({
      createdAgo: '3d',
      lastActiveAgo: '2h',
      duration: '2d 22h',
    });
  });

  it('prefers the scan-persisted duration over subtracting a possibly-mtime last activity', () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(
      extractTiming(times({ lastActivity: '2026-07-04T10:00:00.000Z', durationMs: 45 * 60_000 }), []).duration,
    ).toBe('45m');
  });

  it('reports creation alone for a session that never spanned a minute', () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    expect(
      extractTiming(times({ timestamp: '2026-07-04T09:00:00.000Z', lastActivity: '2026-07-04T09:00:20.000Z' }), []),
    ).toEqual({ createdAgo: '3h' });
  });

  it('says nothing rather than guessing when the creation time is unparseable', () => {
    expect(extractTiming(times({ timestamp: 'not-a-date' }), [])).toEqual({});
  });
});

describe('buildPreview — timing for a session with no local transcript', () => {
  afterEach(() => vi.useRealTimers());

  it('shows created, last active and lasted from the indexed metadata', () => {
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
    const preview = stripVTControlCharacters(
      buildPreview(mk({
        timestamp: '2026-07-01T12:00:00.000Z',
        lastActivity: '2026-07-04T10:00:00.000Z',
        cwd: '/home/me/repo',
      })),
    );
    expect(preview).toContain('created 3d ago');
    expect(preview).toContain('last active 2h ago');
    expect(preview).toContain('lasted 2d 22h');
  });
});

/**
 * RUSH-2198: the detailed preview collapsed to empty in the picker. This ties the
 * real buildPreview output (parsed from a transcript on disk) to the picker's row
 * budget at the default 24-row height with PICKER_RECENT_COUNT (15) list rows —
 * the exact shape that used to leave the preview slot empty. No mocking: a real
 * jsonl is written and parsed.
 */
describe('buildPreview fits the picker preview slot at default height (RUSH-2198)', () => {
  it('is non-empty in the picker slot with a 15-row list on a 24-row terminal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-preview-budget-'));
    try {
      const filePath = path.join(dir, 'session.jsonl');
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: 'user', timestamp: '2026-08-01T14:00:00.000Z', cwd: dir, sessionId: 'budget-session', version: '2.1.112', message: { role: 'user', content: 'Fix the picker preview pane so it renders' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T14:00:10.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: path.join(dir, 'picker.ts') } }] } }),
      ].join('\n') + '\n');

      const preview = buildPreview(mk({ id: 'budget-session', shortId: 'budget01', filePath, cwd: dir }));
      // The transcript really parsed into a preview with the user's prompt.
      expect(stripVTControlCharacters(preview)).toContain('Fix the picker preview pane');

      // The picker caps the list so the preview keeps its floor; feed that budget
      // through limitPreviewHeight exactly as itemPicker does.
      const width = 80;
      const page = pickerPageSize({ requestedPageSize: 15, terminalRows: 24, chromeRows: 3, previewOpen: true });
      const availablePreviewRows = 24 - (1 /*header*/ + 1 /*subtitle*/ + page + 1 /*separator*/ + 1 /*help*/);
      expect(availablePreviewRows).toBeGreaterThanOrEqual(PREVIEW_MIN_ROWS);

      const slot = limitPreviewHeight(preview, availablePreviewRows, width);
      expect(slot).not.toBe('');
      expect(stripVTControlCharacters(slot)).toContain('Fix the picker preview pane');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
