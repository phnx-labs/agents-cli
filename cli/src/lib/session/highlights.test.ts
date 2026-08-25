import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionEvent } from './types.js';
import { classifyFileChanges } from './digest.js';
import {
  extractArtifacts,
  extractHooks,
  extractLinks,
  extractRepos,
  extractSkills,
  extractSlashCommands,
} from './highlights.js';

function tool(name: string, args: Record<string, any> = {}, p?: string, agent: SessionEvent['agent'] = 'claude'): SessionEvent {
  return { type: 'tool_use', agent, timestamp: '2026-08-03T10:00:00Z', tool: name, args, path: p };
}
function msg(role: 'user' | 'assistant', content: string): SessionEvent {
  return { type: 'message', agent: 'claude', timestamp: '2026-08-03T10:00:00Z', role, content };
}

describe('extractSkills', () => {
  it('counts Skill invocations by name, sorted by count', () => {
    const skills = extractSkills([
      tool('Skill', { skill: 'teams', args: 'spin up' }),
      tool('Skill', { skill: 'teams' }),
      tool('Skill', { skill: 'plan-render' }),
      tool('Bash', { command: 'ls' }),
    ]);
    expect(skills).toEqual([
      { name: 'teams', count: 2 },
      { name: 'plan-render', count: 1 },
    ]);
  });

  it('falls back to args.name and skips unnamed calls', () => {
    const skills = extractSkills([
      tool('Skill', { name: 'release-headless' }),
      tool('Skill', {}),
    ]);
    expect(skills).toEqual([{ name: 'release-headless', count: 1 }]);
  });

  it('returns [] when no Skill tool ran', () => {
    expect(extractSkills([tool('Read', {}, 'a.ts')])).toEqual([]);
  });

  it('#12: is harness-aware — kimi matches the same verified "Skill" tool name as claude', () => {
    expect(extractSkills([tool('Skill', { skill: 'teams' }, undefined, 'kimi')])).toEqual([{ name: 'teams', count: 1 }]);
  });

  it('#12: does NOT match a coincidentally-named "Skill" tool_use from an unverified harness', () => {
    // No harness beyond claude/kimi has a confirmed skill-invocation tool
    // name in this codebase — an absent registry entry must stay a real
    // miss, not silently fall through to matching any tool literally
    // named "Skill" regardless of which harness produced it.
    expect(extractSkills([tool('Skill', { skill: 'teams' }, undefined, 'gemini')])).toEqual([]);
  });
});

describe('extractSlashCommands (#12)', () => {
  it('counts slashCommand occurrences, sorted by count then name', () => {
    const events: SessionEvent[] = [
      { ...msg('user', 'x'), slashCommand: '/recap' },
      { ...msg('user', 'x'), slashCommand: '/recap' },
      { ...tool('SlashCommand', { command: '/code:commit fix' }), slashCommand: '/code:commit' },
      msg('assistant', 'no command here'),
    ];
    expect(extractSlashCommands(events)).toEqual([
      { name: '/recap', count: 2 },
      { name: '/code:commit', count: 1 },
    ]);
  });

  it('returns [] when no event carries a slashCommand', () => {
    expect(extractSlashCommands([msg('user', 'plain text'), tool('Bash', { command: 'ls' })])).toEqual([]);
  });
});

describe('extractHooks', () => {
  it('folds hook events into per-name counts with failures', () => {
    const hooks = extractHooks([
      { type: 'hook', agent: 'claude', timestamp: 't', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', success: true },
      { type: 'hook', agent: 'claude', timestamp: 't', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', success: true },
      { type: 'hook', agent: 'claude', timestamp: 't', hookName: 'PreToolUse:git-guard', hookEvent: 'PreToolUse', success: false },
    ]);
    expect(hooks).toEqual([
      { name: 'SessionStart:startup', event: 'SessionStart', count: 2, failed: 0 },
      { name: 'PreToolUse:git-guard', event: 'PreToolUse', count: 1, failed: 1 },
    ]);
  });

  it('returns [] for transcripts with no hook events (non-Claude harnesses)', () => {
    expect(extractHooks([tool('Bash', { command: 'ls' })])).toEqual([]);
  });
});

describe('extractLinks', () => {
  it('classifies Linear, GitHub PR/issue, Jira, GitLab with short labels', () => {
    const links = extractLinks([
      msg('user', 'see https://linear.app/getrush/issue/RUSH-2076/some-slug and https://github.com/phnx-labs/agents-cli/pull/1755'),
      msg('assistant', 'jira: https://acme.atlassian.net/browse/PROJ-42 gitlab: https://gitlab.com/grp/proj/-/merge_requests/7'),
    ]);
    expect(links).toEqual([
      { kind: 'linear', url: 'https://linear.app/getrush/issue/RUSH-2076/some-slug', label: 'RUSH-2076' },
      { kind: 'github', url: 'https://github.com/phnx-labs/agents-cli/pull/1755', label: 'PR#1755' },
      { kind: 'jira', url: 'https://acme.atlassian.net/browse/PROJ-42', label: 'PROJ-42' },
      { kind: 'gitlab', url: 'https://gitlab.com/grp/proj/-/merge_requests/7', label: 'grp/proj!7' },
    ]);
  });

  it('dedupes by URL and by label, first-seen order', () => {
    const links = extractLinks([
      msg('assistant', 'https://github.com/o/r/pull/1 and again https://github.com/o/r/pull/1'),
      msg('assistant', 'same PR via another URL form https://github.com/o/r/pull/1/files'),
    ]);
    expect(links.filter((l) => l.label === 'PR#1')).toHaveLength(1);
  });

  it('strips trailing punctuation and rejects non-routable hosts', () => {
    const links = extractLinks([
      msg('assistant', 'check https://example.com/docs, then http://localhost:8787/x and https://…`'),
    ]);
    expect(links.map((l) => l.url)).toEqual(['https://example.com/docs']);
  });

  it('skips harness-injected synthetic messages', () => {
    const synthetic: SessionEvent = { ...msg('user', '<bash-stdout>see https://noise.example.com/x</bash-stdout>'), _synthetic: true };
    const links = extractLinks([synthetic, msg('assistant', 'real https://real.example.com/y')]);
    expect(links.map((l) => l.label)).toEqual(['real.example.com']);
  });
});

describe('extractArtifacts', () => {
  it('keeps created docs under .agents buckets and other *.md/*.html, skips source churn', () => {
    const changes = classifyFileChanges([
      tool('Write', { file_path: '/repo/.agents/artifacts/report.html' }, '/repo/.agents/artifacts/report.html'),
      tool('Write', { file_path: '/repo/.agents/plans/fix.md' }, '/repo/.agents/plans/fix.md'),
      tool('Write', { file_path: '/repo/.agents/reports/audit.md' }, '/repo/.agents/reports/audit.md'),
      tool('Write', { file_path: '/repo/notes.md' }, '/repo/notes.md'),
      tool('Write', { file_path: '/repo/src/new.ts' }, '/repo/src/new.ts'),
      tool('Edit', { file_path: '/repo/docs/existing.md' }, '/repo/docs/existing.md'),
    ]);
    const artifacts = extractArtifacts(changes);
    expect(artifacts).toEqual([
      { path: '/repo/.agents/artifacts/report.html', basename: 'report.html', bucket: 'artifacts' },
      { path: '/repo/.agents/plans/fix.md', basename: 'fix.md', bucket: 'plans' },
      { path: '/repo/.agents/reports/audit.md', basename: 'audit.md', bucket: 'reports' },
      { path: '/repo/notes.md', basename: 'notes.md', bucket: 'docs' },
    ]);
  });
});

describe('extractRepos', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-test-'));
    fs.mkdirSync(path.join(tmp, 'repo-a', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'repo-a', '.git'));
    fs.mkdirSync(path.join(tmp, 'repo-b'), { recursive: true });
    // repo-b has no .git — a plain directory, not a repo.
    fs.mkdirSync(path.join(tmp, 'wt'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'wt', '.git'), 'gitdir: ../repo-a/.git'); // worktree: .git is a FILE
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('finds repo roots via .git walk-up (dirs and worktree gitfiles)', () => {
    const repos = extractRepos([
      tool('Read', {}, path.join(tmp, 'repo-a', 'src', 'a.ts')),
      tool('Read', {}, path.join(tmp, 'wt', 'b.ts')),
      tool('Read', {}, path.join(tmp, 'repo-b', 'c.ts')),
    ]);
    expect(repos).toEqual(['repo-a', 'wt']);
  });

  it('skips relative paths when the session cwd is unknown (never the viewer cwd)', () => {
    const repos = extractRepos([tool('Read', {}, 'cli/src/a.ts')], undefined);
    expect(repos).toEqual([]);
  });

  it('resolves relative paths against the session cwd when known', () => {
    const repos = extractRepos([tool('Read', {}, 'src/a.ts')], path.join(tmp, 'repo-a'));
    expect(repos).toEqual(['repo-a']);
  });
});
