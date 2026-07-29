import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  ACTIVITY_LOG_HOOK_SCRIPT,
  appendActivityEvent,
  collapseActivity,
  ensureActivityLogHook,
  readRecentActivity,
  readSessionActivity,
  tierForEvent,
} from './activity.js';

const hasPython = spawnSync('python3', ['--version']).status === 0;

function tmpActivityDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-test-'));
}

/** Run the real embedded Python hook against one payload; return the log dir. */
function runHook(home: string, payload: Record<string, unknown>, env: Record<string, string> = {}) {
  return spawnSync('python3', ['-c', ACTIVITY_LOG_HOOK_SCRIPT], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, ...env },
    encoding: 'utf-8',
  });
}
function activityDirFor(home: string): string {
  return path.join(home, '.agents', '.history', 'activity');
}

describe('activity log store (TS)', () => {
  it('appends and reads back events for a session, newest-first across sessions', () => {
    const dir = tmpActivityDir();
    appendActivityEvent({ ts: '2026-07-29T10:00:00.000Z', event: 'plan.created', sessionId: 's1', mailboxId: 's1', host: 'zion', runtime: 'headless', detail: 'Build the spine' }, dir);
    appendActivityEvent({ ts: '2026-07-29T10:05:00.000Z', event: 'pr.opened', sessionId: 's1', mailboxId: 's1', host: 'zion', runtime: 'headless', url: 'https://x/pull/1' }, dir);
    appendActivityEvent({ ts: '2026-07-29T10:03:00.000Z', event: 'commit.created', sessionId: 's2', mailboxId: 's2', host: 'yos', runtime: 'tmux' }, dir);

    const s1 = readSessionActivity('s1', dir);
    expect(s1.map((e) => e.event)).toEqual(['plan.created', 'pr.opened']);
    expect(s1[0].tier).toBe('milestone'); // stamped by tierForEvent

    const recent = readRecentActivity({ root: dir });
    expect(recent.map((e) => e.event)).toEqual(['pr.opened', 'commit.created', 'plan.created']);
  });

  it('respects the sinceMs window and limit', () => {
    const dir = tmpActivityDir();
    appendActivityEvent({ ts: '2026-07-29T09:00:00.000Z', event: 'pushed', sessionId: 's1', mailboxId: 's1', host: 'h', runtime: 'headless' }, dir);
    appendActivityEvent({ ts: '2026-07-29T11:00:00.000Z', event: 'pr.merged', sessionId: 's1', mailboxId: 's1', host: 'h', runtime: 'headless' }, dir);
    const since = Date.parse('2026-07-29T10:00:00.000Z');
    const recent = readRecentActivity({ root: dir, sinceMs: since });
    expect(recent.map((e) => e.event)).toEqual(['pr.merged']);
    expect(readRecentActivity({ root: dir, limit: 1 })).toHaveLength(1);
  });

  it('skips corrupt / partial lines without throwing', () => {
    const dir = tmpActivityDir();
    fs.writeFileSync(path.join(dir, 's1.jsonl'), '{not json\n{"ts":"2026-07-29T10:00:00.000Z","event":"pr.opened","sessionId":"s1"}\n\n');
    const events = readSessionActivity('s1', dir);
    expect(events.map((e) => e.event)).toEqual(['pr.opened']);
  });

  it('collapses routine events to counts and preserves milestones', () => {
    const events = [
      { v: 1, ts: '2026-07-29T10:00:00.000Z', event: 'file.edited', tier: 'activity', sessionId: 's', mailboxId: 's', host: 'h', runtime: 'r' },
      { v: 1, ts: '2026-07-29T10:01:00.000Z', event: 'file.edited', tier: 'activity', sessionId: 's', mailboxId: 's', host: 'h', runtime: 'r' },
      { v: 1, ts: '2026-07-29T10:02:00.000Z', event: 'pr.opened', tier: 'milestone', sessionId: 's', mailboxId: 's', host: 'h', runtime: 'r' },
      { v: 1, ts: '2026-07-29T10:03:00.000Z', event: 'subagent.spawned', tier: 'milestone', sessionId: 's', mailboxId: 's', host: 'h', runtime: 'r' },
      { v: 1, ts: '2026-07-29T10:04:00.000Z', event: 'subagent.spawned', tier: 'milestone', sessionId: 's', mailboxId: 's', host: 'h', runtime: 'r' },
    ] as const;
    const c = collapseActivity([...events]);
    expect(c.counts).toEqual({ 'file.edited': 2 });
    expect(c.milestones.map((m) => m.event)).toEqual(['pr.opened', 'subagent.spawned', 'subagent.spawned']);
    expect(c.subagentCount).toBe(2);
  });

  it('classifies tiers correctly', () => {
    expect(tierForEvent('pr.opened')).toBe('milestone');
    expect(tierForEvent('subagent.spawned')).toBe('milestone');
    expect(tierForEvent('file.edited')).toBe('activity');
    expect(tierForEvent('unknown.thing')).toBe('activity');
  });
});

describe('ensureActivityLogHook', () => {
  it('installs the script + manifest idempotently', () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-hook-'));
    expect(ensureActivityLogHook(userDir)).toEqual({ installed: true });
    expect(ensureActivityLogHook(userDir)).toEqual({ installed: false });
    expect(fs.readFileSync(path.join(userDir, 'hooks', '11-activity-log.py'), 'utf-8')).toBe(ACTIVITY_LOG_HOOK_SCRIPT);
    const yaml = fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8');
    expect(yaml).toContain('activity-log-intent');
    expect(yaml).toContain('activity-log-result');
    expect(yaml).toContain('ExitPlanMode|Task');
  });
});

describe('real activity-log hook (Python)', () => {
  it.runIf(hasPython)('logs plan.created from a PreToolUse ExitPlanMode', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-plan-'));
    const r = runHook(home, {
      session_id: 'sess-1',
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '# Build the event spine\nStep one...' },
      cwd: '/home/muqsit/src/x',
    }, { AGENTS_RUNTIME: 'tmux', AGENTS_SYNC_MACHINE_ID: 'zion' });
    expect(r.status).toBe(0);
    const events = readSessionActivity('sess-1', activityDirFor(home));
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('plan.created');
    expect(events[0].tier).toBe('milestone');
    expect(events[0].detail).toBe('Build the event spine');
    expect(events[0].runtime).toBe('tmux');
    expect(events[0].host).toBe('zion');
    expect(events[0].cwd).toBe('/home/muqsit/src/x');
  });

  it.runIf(hasPython)('logs subagent.spawned from a PreToolUse Task', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-task-'));
    runHook(home, {
      session_id: 'sess-2',
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_input: { subagent_type: 'Explore', description: 'Investigate feed perf' },
    });
    const events = readSessionActivity('sess-2', activityDirFor(home));
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('subagent.spawned');
    expect(events[0].detail).toContain('Explore');
  });

  it.runIf(hasPython)('logs pr.opened with the URL from a PostToolUse Bash gh pr create', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-pr-'));
    runHook(home, {
      session_id: 'sess-3',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title x --body y' },
      tool_response: { stdout: 'https://github.com/muqsitnawaz/agents/pull/413\n' },
    });
    const events = readSessionActivity('sess-3', activityDirFor(home));
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('pr.opened');
    expect(events[0].url).toBe('https://github.com/muqsitnawaz/agents/pull/413');
  });

  it.runIf(hasPython)('logs worktree.created from a PostToolUse Bash git worktree add', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-wt-'));
    runHook(home, {
      session_id: 'sess-4',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git -C /repo worktree add -b feat /repo/.agents/worktrees/feat origin/main' },
      tool_response: { stdout: '' },
    });
    const events = readSessionActivity('sess-4', activityDirFor(home));
    expect(events.map((e) => e.event)).toEqual(['worktree.created']);
  });

  it.runIf(hasPython)('logs file.edited (activity tier) from a PostToolUse Write', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-edit-'));
    runHook(home, {
      session_id: 'sess-5',
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/home/muqsit/src/x/foo.ts' },
      tool_response: {},
    });
    const events = readSessionActivity('sess-5', activityDirFor(home));
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('file.edited');
    expect(events[0].tier).toBe('activity');
    expect(events[0].detail).toBe('foo.ts');
  });

  it.runIf(hasPython)('logs artifact.created (milestone) for a Write to an HTML/tmp artifact', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-artifact-'));
    runHook(home, {
      session_id: 'sess-art',
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/plan-preview.html' },
      tool_response: {},
    });
    const events = readSessionActivity('sess-art', activityDirFor(home));
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('artifact.created');
    expect(events[0].tier).toBe('milestone');
    expect(events[0].detail).toBe('plan-preview.html');

    // A code Write stays a routine file.edited (collapses, not a milestone).
    runHook(home, {
      session_id: 'sess-art',
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/home/muqsit/src/x/parser.ts' },
      tool_response: {},
    });
    const after = readSessionActivity('sess-art', activityDirFor(home));
    expect(after.map((e) => e.event)).toEqual(['artifact.created', 'file.edited']);
  });

  it.runIf(hasPython)('writes NOTHING for a non-milestone Bash command', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-noop-'));
    runHook(home, {
      session_id: 'sess-6',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la /tmp' },
      tool_response: { stdout: 'foo\n' },
    });
    expect(readSessionActivity('sess-6', activityDirFor(home))).toHaveLength(0);
  });

  it.runIf(hasPython)('does not mistake a path for a git subcommand (tokenized classify)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-fp-'));
    // A path containing "commit"/"push" must NOT trigger commit.created/pushed.
    runHook(home, {
      session_id: 'fp', hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'git diff -- src/commit.ts src/push.ts' }, tool_response: {},
    });
    expect(readSessionActivity('fp', activityDirFor(home))).toHaveLength(0);
    // But a real `git -C <path> commit` (leading flags) is still detected.
    runHook(home, {
      session_id: 'fp', hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'git -C /repo commit -m "fix"' }, tool_response: {},
    });
    expect(readSessionActivity('fp', activityDirFor(home)).map((e) => e.event)).toEqual(['commit.created']);
  });

  it.runIf(hasPython)('skips sub-agent tool calls (agent_type gate)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-subagent-'));
    runHook(home, {
      session_id: 'sess-7',
      agent_type: 'general-purpose',
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'nope' },
    });
    expect(readSessionActivity('sess-7', activityDirFor(home))).toHaveLength(0);
  });
});
