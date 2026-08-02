import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  ACTIVITY_LOG_HOOK_SCRIPT,
  activityGroupKey,
  appendActivityEvent,
  attachmentName,
  collapseActivity,
  enrichActivityEvents,
  ensureActivityLogHook,
  filterActivityEvents,
  formatEnrichedActivityLine,
  formatProgressUpdate,
  groupActivity,
  mergeActivityEvents,
  parseActivityPayload,
  projectFromCwd,
  readRecentActivity,
  readSessionActivity,
  sanitizeAttachments,
  shortSessionId,
  tierForEvent,
  type ActivityEvent,
  type EnrichedActivityEvent,
} from './activity.js';

/** Minimal well-formed enriched event; override any field per test. */
function ev(partial: Partial<EnrichedActivityEvent>): EnrichedActivityEvent {
  return {
    v: 1,
    ts: partial.ts ?? '2026-08-01T12:00:00.000Z',
    event: partial.event ?? 'file.edited',
    tier: partial.tier ?? 'activity',
    sessionId: partial.sessionId ?? 'sess-1',
    mailboxId: partial.mailboxId ?? partial.sessionId ?? 'sess-1',
    host: partial.host ?? 'yosemite-s0',
    runtime: partial.runtime ?? 'headless',
    ...partial,
  } as EnrichedActivityEvent;
}

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

  it('applies the event filter before the limit so rare posts survive routine churn', () => {
    const dir = tmpActivityDir();
    // A busy box: 40 routine edits newer than the one deliberate progress post.
    appendActivityEvent(
      { ts: '2026-07-29T09:00:00.000Z', event: 'status.posted', sessionId: 's1', mailboxId: 's1', host: 'h', runtime: 'headless', detail: 'PR #1690 open; watching CI' },
      dir,
    );
    for (let i = 0; i < 40; i += 1) {
      appendActivityEvent(
        { ts: `2026-07-29T10:${String(i).padStart(2, '0')}:00.000Z`, event: 'file.edited', sessionId: 's2', mailboxId: 's2', host: 'h', runtime: 'headless' },
        dir,
      );
    }
    // Slicing first and filtering after is what returned an empty updates view.
    expect(readRecentActivity({ root: dir, limit: 30 }).filter((e) => e.event === 'status.posted')).toHaveLength(0);
    // Pushing the filter into the reader makes `limit` count posts, not churn.
    const posts = readRecentActivity({ root: dir, limit: 30, events: ['status.posted'] });
    expect(posts.map((e) => e.detail)).toEqual(['PR #1690 open; watching CI']);
    // Same defect, same fix for the milestone lane under the block view.
    expect(readRecentActivity({ root: dir, limit: 6, tier: 'milestone' }).map((e) => e.event)).toEqual(['status.posted']);
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
    expect(tierForEvent('status.posted')).toBe('milestone');
    expect(tierForEvent('file.edited')).toBe('activity');
    expect(tierForEvent('unknown.thing')).toBe('activity');
  });

  it('round-trips status.posted identity fields through the activity log', () => {
    const dir = tmpActivityDir();
    appendActivityEvent({
      ts: '2026-07-31T12:00:00.000Z',
      event: 'status.posted',
      sessionId: 's-status',
      mailboxId: 's-status',
      host: 'zion',
      runtime: 'teams',
      agent: 'grok',
      tool: 'feed.post',
      detail: 'halfway',
      pid: 99,
      launchId: 'L1',
      tmuxPane: '%2',
    }, dir);
    const events = readSessionActivity('s-status', dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'status.posted',
      tier: 'milestone',
      detail: 'halfway',
      pid: 99,
      launchId: 'L1',
      tmuxPane: '%2',
      agent: 'grok',
    });
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

  it.runIf(hasPython)('emits checklist.created on the first TodoWrite', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-todo-create-'));
    const sessionId = 'sess-todo-create';
    const transcript = path.join(home, `${sessionId}.jsonl`);
    runHook(home, {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ id: '1', content: 'Explore auth', status: 'pending' }] },
      transcript_path: transcript,
    });
    const events = readSessionActivity(sessionId, activityDirFor(home));
    expect(events.map((e) => e.event)).toEqual(['checklist.created']);
    expect(events[0].tier).toBe('milestone');
    expect(events[0].detail).toBe('1 task');
  });

  it.runIf(hasPython)('emits task.completed when a TodoWrite item flips to completed', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-todo-done-'));
    const sessionId = 'sess-todo-done';
    const transcript = path.join(home, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ name: 'TodoWrite', input: { todos: [{ id: '1', content: 'Explore auth', status: 'pending' }] } }),
        JSON.stringify({ name: 'TodoWrite', input: { todos: [{ id: '1', content: 'Explore auth', status: 'completed' }] } }),
      ].join('\n') + '\n',
    );
    runHook(home, {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ id: '1', content: 'Explore auth', status: 'completed' }] },
      transcript_path: transcript,
    });
    const events = readSessionActivity(sessionId, activityDirFor(home));
    expect(events.map((e) => e.event)).toEqual(['task.completed']);
    expect(events[0].tier).toBe('milestone');
    expect(events[0].detail).toBe('Explore auth 1/1 done');
  });

  it.runIf(hasPython)('emits task.completed with N/M detail for a multi-item TodoWrite', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-todo-multi-'));
    const sessionId = 'sess-todo-multi';
    const transcript = path.join(home, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({
          name: 'TodoWrite',
          input: {
            todos: [
              { id: '1', content: 'Explore auth', status: 'completed' },
              { id: '2', content: 'Write tests', status: 'pending' },
              { id: '3', content: 'Open PR', status: 'pending' },
            ],
          },
        }),
        JSON.stringify({
          name: 'TodoWrite',
          input: {
            todos: [
              { id: '1', content: 'Explore auth', status: 'completed' },
              { id: '2', content: 'Write tests', status: 'completed' },
              { id: '3', content: 'Open PR', status: 'pending' },
            ],
          },
        }),
      ].join('\n') + '\n',
    );
    runHook(home, {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
      tool_name: 'TodoWrite',
      tool_input: {
        todos: [
          { id: '1', content: 'Explore auth', status: 'completed' },
          { id: '2', content: 'Write tests', status: 'completed' },
          { id: '3', content: 'Open PR', status: 'pending' },
        ],
      },
      transcript_path: transcript,
    });
    const events = readSessionActivity(sessionId, activityDirFor(home));
    expect(events.map((e) => e.event)).toEqual(['task.completed']);
    expect(events[0].detail).toBe('Write tests 2/3 done');
  });

  it.runIf(hasPython)('emits nothing for a TodoWrite with no new completions', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-todo-noop-'));
    const sessionId = 'sess-todo-noop';
    const transcript = path.join(home, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({
          name: 'TodoWrite',
          input: { todos: [{ id: '1', content: 'Explore auth', status: 'completed' }] },
        }),
        JSON.stringify({
          name: 'TodoWrite',
          input: { todos: [{ id: '1', content: 'Explore auth', status: 'completed' }] },
        }),
      ].join('\n') + '\n',
    );
    runHook(home, {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ id: '1', content: 'Explore auth', status: 'completed' }] },
      transcript_path: transcript,
    });
    expect(readSessionActivity(sessionId, activityDirFor(home))).toHaveLength(0);
  });

  it.runIf(hasPython)('emits task.completed for codex update_plan step completion', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-plan-done-'));
    const sessionId = 'sess-plan-done';
    const transcript = path.join(home, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({
          name: 'update_plan',
          arguments: JSON.stringify({ plan: [{ step: 'Read files', status: 'pending' }] }),
        }),
        JSON.stringify({
          name: 'update_plan',
          arguments: JSON.stringify({ plan: [{ step: 'Read files', status: 'completed' }] }),
        }),
      ].join('\n') + '\n',
    );
    runHook(home, {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
      tool_name: 'update_plan',
      tool_input: { plan: [{ step: 'Read files', status: 'completed' }] },
      transcript_path: transcript,
    });
    const events = readSessionActivity(sessionId, activityDirFor(home));
    expect(events.map((e) => e.event)).toEqual(['task.completed']);
    expect(events[0].detail).toBe('Read files 1/1 done');
  });

  it.runIf(hasPython)('emits task.completed for TaskUpdate by resolving subject from transcript', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-task-update-'));
    const sessionId = 'sess-task-update';
    const transcript = path.join(home, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({
          name: 'TodoWrite',
          input: {
            todos: [
              { id: '1', content: 'Explore auth', status: 'completed' },
              { id: '2', content: 'Write tests', status: 'pending' },
            ],
          },
        }),
        JSON.stringify({ name: 'TaskUpdate', input: { taskId: '2', status: 'completed' } }),
      ].join('\n') + '\n',
    );
    runHook(home, {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
      tool_name: 'TaskUpdate',
      tool_input: { taskId: '2', status: 'completed' },
      transcript_path: transcript,
    });
    const events = readSessionActivity(sessionId, activityDirFor(home));
    expect(events.map((e) => e.event)).toEqual(['task.completed']);
    expect(events[0].detail).toBe('Write tests 2/2 done');
  });

  it.runIf(hasPython)('emits checklist.created on the first TaskCreate and resolves TaskUpdate subject from TaskCreate results', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-task-create-'));
    const sessionId = 'sess-task-create';
    const transcript = path.join(home, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tc-1', name: 'TaskCreate', input: { subject: 'Build the spine', description: 'Core work' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          toolUseResult: { task: { id: '1', subject: 'Build the spine' } },
          tool_use_id: 'tc-1',
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu-1', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          toolUseResult: { success: true, taskId: '1', statusChange: { from: 'pending', to: 'completed' } },
          tool_use_id: 'tu-1',
        }),
      ].join('\n') + '\n',
    );

    runHook(home, {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
      tool_name: 'TaskCreate',
      tool_input: { subject: 'Build the spine', description: 'Core work' },
      tool_response: { task: { id: '1', subject: 'Build the spine' } },
      tool_use_id: 'tc-1',
      transcript_path: transcript,
    });
    const createEvents = readSessionActivity(sessionId, activityDirFor(home));
    expect(createEvents.map((e) => e.event)).toEqual(['checklist.created']);
    expect(createEvents[0].detail).toBe('Build the spine');

    runHook(home, {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
      tool_name: 'TaskUpdate',
      tool_input: { taskId: '1', status: 'completed' },
      tool_response: { success: true, taskId: '1', statusChange: { from: 'pending', to: 'completed' } },
      tool_use_id: 'tu-1',
      transcript_path: transcript,
    });
    const updateEvents = readSessionActivity(sessionId, activityDirFor(home));
    expect(updateEvents.map((e) => e.event)).toEqual(['checklist.created', 'task.completed']);
    expect(updateEvents[1].detail).toBe('Build the spine 1/1 done');
  });

  it.runIf(hasPython)('excludes deleted tasks from the N/M total on a TaskUpdate completion', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-task-deleted-'));
    const sessionId = 'sess-task-deleted';
    const transcript = path.join(home, `${sessionId}.jsonl`);
    const create = (id: string, subject: string) => [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `tc-${id}`, name: 'TaskCreate', input: { subject } }] } }),
      JSON.stringify({ type: 'user', toolUseResult: { task: { id, subject } }, tool_use_id: `tc-${id}` }),
    ];
    const update = (id: string, to: string) => [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu-${id}-${to}`, name: 'TaskUpdate', input: { taskId: id, status: to } }] } }),
      JSON.stringify({ type: 'user', toolUseResult: { success: true, taskId: id, statusChange: { from: 'pending', to } }, tool_use_id: `tu-${id}-${to}` }),
    ];
    fs.writeFileSync(
      transcript,
      [
        ...create('1', 'A1'), ...create('2', 'A2'), ...create('3', 'A3'),
        ...update('1', 'completed'),
        ...update('3', 'deleted'),
        ...update('2', 'completed'),
      ].join('\n') + '\n',
    );
    runHook(home, {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
      tool_name: 'TaskUpdate',
      tool_input: { taskId: '2', status: 'completed' },
      tool_response: { success: true, taskId: '2', statusChange: { from: 'pending', to: 'completed' } },
      tool_use_id: 'tu-2-completed',
      transcript_path: transcript,
    });
    const events = readSessionActivity(sessionId, activityDirFor(home));
    expect(events.map((e) => e.event)).toEqual(['task.completed']);
    // 3 created, 1 deleted -> total is 2 (not 3); this completion is the 2nd of 2.
    expect(events[0].detail).toBe('A2 2/2 done');
  });

  it.runIf(hasPython)('is fail-open when transcript_path is missing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-activity-todo-failopen-'));
    const sessionId = 'sess-todo-failopen';
    runHook(home, {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ id: '1', content: 'Explore auth', status: 'completed' }] },
      transcript_path: path.join(home, 'nonexistent', 'transcript.jsonl'),
    });
    const events = readSessionActivity(sessionId, activityDirFor(home));
    expect(events.map((e) => e.event)).toEqual(['checklist.created', 'task.completed']);
  });
});

// ---------------------------------------------------------------------------
// Fleet fan-out, enrichment, grouping (the "activity bar")
// ---------------------------------------------------------------------------

describe('projectFromCwd', () => {
  it('resolves a worktree cwd to the repo dir name', () => {
    expect(projectFromCwd('/home/me/src/agents-cli/.agents/worktrees/my-slug')).toBe('agents-cli');
  });
  it('resolves a subdir inside a worktree to the repo', () => {
    expect(projectFromCwd('/home/me/src/agents-cli/.agents/worktrees/my-slug/apps/cli')).toBe('agents-cli');
  });
  it('falls back to the basename for a plain path, stripping a trailing slash', () => {
    expect(projectFromCwd('/home/me/src/rush')).toBe('rush');
    expect(projectFromCwd('/home/me/src/rush/')).toBe('rush');
  });
  it('returns undefined for an empty or missing cwd', () => {
    expect(projectFromCwd(undefined)).toBeUndefined();
    expect(projectFromCwd('')).toBeUndefined();
    expect(projectFromCwd(null)).toBeUndefined();
  });
});

describe('enrichActivityEvents', () => {
  it('joins ticket / project / execution host from a session hint by sessionId', () => {
    const [out] = enrichActivityEvents([ev({ sessionId: 'a', cwd: '/home/me/src/agents-cli' })], [
      { sessionId: 'a', ticket: 'RUSH-2100', executionHost: 'yosemite-s1', project: 'agents-cli' },
    ]);
    expect(out.ticket).toBe('RUSH-2100');
    expect(out.executionHost).toBe('yosemite-s1');
    expect(out.project).toBe('agents-cli');
  });

  it('falls back to cwd-derived project and the event host when no hint matches', () => {
    const [out] = enrichActivityEvents([ev({ sessionId: 'x', cwd: '/home/me/src/rush', host: 'mac-mini' })], [
      { sessionId: 'other', ticket: 'RUSH-1' },
    ]);
    expect(out.project).toBe('rush');
    expect(out.executionHost).toBe('mac-mini');
    expect(out.ticket).toBeUndefined();
  });

  it('preserves pre-baked enriched fields from a remote peer (no local hint)', () => {
    const [out] = enrichActivityEvents(
      [ev({ sessionId: 'r', project: 'peer-repo', ticket: 'RUSH-9', executionHost: 'zion' })],
      [],
    );
    expect(out).toMatchObject({ project: 'peer-repo', ticket: 'RUSH-9', executionHost: 'zion' });
  });

  it('does not treat an unknown host as an execution host', () => {
    const [out] = enrichActivityEvents([ev({ host: 'unknown', cwd: undefined })], []);
    expect(out.executionHost).toBeUndefined();
  });
});

describe('parseActivityPayload', () => {
  it('keeps the event host and drops invalid items', () => {
    const payload = JSON.stringify([
      { v: 1, ts: '2026-08-01T00:00:00Z', event: 'pr.opened', tier: 'milestone', sessionId: 's1', host: 'zion' },
      { event: 'file.edited' }, // missing sessionId + ts -> dropped
      42, // not an object -> dropped
    ]);
    const out = parseActivityPayload(payload, 'dialed-peer');
    expect(out).toHaveLength(1);
    expect(out[0].host).toBe('zion');
  });
  it('host-tags with the dialed peer when the item carries no host', () => {
    const [out] = parseActivityPayload(JSON.stringify([{ ts: '2026-08-01T00:00:00Z', event: 'pushed', sessionId: 's2' }]), 'mac-mini');
    expect(out.host).toBe('mac-mini');
  });
  it('returns [] for non-array or invalid JSON', () => {
    expect(parseActivityPayload('not json', 'h')).toEqual([]);
    expect(parseActivityPayload('{"not":"array"}', 'h')).toEqual([]);
  });
});

describe('mergeActivityEvents', () => {
  it('merges host-tagged streams, dedupes by identity, and sorts newest first', () => {
    const local = ev({ sessionId: 's', ts: '2026-08-01T10:00:00.000Z', event: 'commit.created', host: 'yosemite-s0' });
    const dup = ev({ sessionId: 's', ts: '2026-08-01T10:00:00.000Z', event: 'commit.created', host: 'yosemite-s0' });
    const newer = ev({ sessionId: 't', ts: '2026-08-01T11:00:00.000Z', event: 'pr.opened', host: 'zion' });
    const merged = mergeActivityEvents([local], [dup, newer]);
    expect(merged).toHaveLength(2); // dup collapsed
    expect(merged[0].ts).toBe('2026-08-01T11:00:00.000Z'); // newest first
    expect(new Set(merged.map((e) => e.host))).toEqual(new Set(['yosemite-s0', 'zion']));
  });
  it('does not collapse the same session/ts/event across different hosts', () => {
    const a = ev({ sessionId: 's', ts: '2026-08-01T10:00:00.000Z', event: 'pushed', host: 'zion' });
    const b = ev({ sessionId: 's', ts: '2026-08-01T10:00:00.000Z', event: 'pushed', host: 'mac-mini' });
    expect(mergeActivityEvents([a], [b])).toHaveLength(2);
  });
});

describe('filterActivityEvents', () => {
  const events = [
    ev({ sessionId: '1', project: 'agents-cli', agent: 'claude', event: 'pr.opened', ticket: 'RUSH-2100', host: 'zion' }),
    ev({ sessionId: '2', project: 'rush', agent: 'codex', event: 'file.edited', host: 'mac-mini', executionHost: 'mac-mini' }),
  ];
  it('matches on project, ticket, agent, device, and event kind (case-insensitive)', () => {
    expect(filterActivityEvents(events, 'AGENTS-CLI').map((e) => e.sessionId)).toEqual(['1']);
    expect(filterActivityEvents(events, 'rush-2100').map((e) => e.sessionId)).toEqual(['1']);
    expect(filterActivityEvents(events, 'codex').map((e) => e.sessionId)).toEqual(['2']);
    expect(filterActivityEvents(events, 'mac-mini').map((e) => e.sessionId)).toEqual(['2']);
    expect(filterActivityEvents(events, 'pr.opened').map((e) => e.sessionId)).toEqual(['1']);
  });
  it('an empty filter is a no-op', () => {
    expect(filterActivityEvents(events, '   ')).toHaveLength(2);
  });
});

describe('activityGroupKey / groupActivity', () => {
  it('keys by each dimension with sensible fallbacks', () => {
    const e = ev({ project: 'agents-cli', executionHost: 'zion', agent: 'claude' });
    expect(activityGroupKey(e, 'project')).toEqual({ key: 'agents-cli', label: 'agents-cli' });
    expect(activityGroupKey(e, 'device')).toEqual({ key: 'zion', label: 'zion' });
    expect(activityGroupKey(e, 'agent')).toEqual({ key: 'claude', label: 'claude' });
    expect(activityGroupKey(ev({ agent: undefined, host: 'unknown', cwd: undefined }), 'agent'))
      .toEqual({ key: '', label: 'unknown agent' });
  });
  it('buckets by project, orders by count desc, and puts the unknown bucket last', () => {
    const groups = groupActivity([
      ev({ sessionId: '1', project: 'agents-cli' }),
      ev({ sessionId: '2', project: 'agents-cli' }),
      ev({ sessionId: '3', project: 'rush' }),
      ev({ sessionId: '4', host: 'unknown', cwd: undefined }), // unknown project
    ], 'project');
    expect(groups.map((g) => g.label)).toEqual(['agents-cli', 'rush', 'unknown project']);
    expect(groups[0].events).toHaveLength(2);
    expect(groups[2].key).toBe('');
  });
  it('groups by device using the resolved execution host (host fallback)', () => {
    const groups = groupActivity([
      ev({ sessionId: '1', executionHost: 'zion' }),
      ev({ sessionId: '2', host: 'mac-mini' }),
    ], 'device');
    expect(new Set(groups.map((g) => g.label))).toEqual(new Set(['zion', 'mac-mini']));
  });
});

describe('formatEnrichedActivityLine', () => {
  it('appends project and ticket tags when asked', () => {
    const line = formatEnrichedActivityLine(ev({ event: 'pr.opened', project: 'agents-cli', ticket: 'RUSH-2100' }), { showHost: true, showProject: true });
    expect(line).toContain('agents-cli');
    expect(line).toContain('RUSH-2100');
  });
  it('omits the project tag when showProject is false but keeps the ticket', () => {
    const line = formatEnrichedActivityLine(ev({ event: 'pr.opened', project: 'agents-cli', ticket: 'RUSH-2100' }), { showProject: false });
    expect(line).not.toContain('agents-cli');
    expect(line).toContain('RUSH-2100');
  });
});

describe('fleet fan-out MERGE + group (integration over per-host JSON payloads)', () => {
  it('parses each peer payload, merges host-tagged, and groups by project', () => {
    // Two peers each answer `activity --json` for themselves.
    const s0 = JSON.stringify([
      { v: 1, ts: '2026-08-01T10:00:00.000Z', event: 'pr.opened', tier: 'milestone', sessionId: 'a', host: 'yosemite-s0', runtime: 'headless', project: 'agents-cli', ticket: 'RUSH-2100' },
    ]);
    const zion = JSON.stringify([
      { v: 1, ts: '2026-08-01T11:00:00.000Z', event: 'commit.created', tier: 'milestone', sessionId: 'b', host: 'zion', runtime: 'headless', project: 'rush' },
      { v: 1, ts: '2026-08-01T09:00:00.000Z', event: 'plan.created', tier: 'milestone', sessionId: 'c', host: 'zion', runtime: 'headless', project: 'agents-cli' },
    ]);
    const merged = mergeActivityEvents(parseActivityPayload(s0, 'yosemite-s0'), parseActivityPayload(zion, 'zion'));
    // Newest first across the fleet.
    expect(merged.map((e) => e.ts)).toEqual([
      '2026-08-01T11:00:00.000Z',
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T09:00:00.000Z',
    ]);
    // Host tags survive the merge.
    expect(new Set(merged.map((e) => e.host))).toEqual(new Set(['yosemite-s0', 'zion']));

    const groups = groupActivity(merged, 'project');
    expect(groups.map((g) => g.label)).toEqual(['agents-cli', 'rush']); // agents-cli has 2, rush 1
    // The agents-cli bucket carries one event from each machine.
    expect(new Set(groups[0].events.map((e) => e.host))).toEqual(new Set(['yosemite-s0', 'zion']));
    // Grouping by device buckets by the execution host of each event.
    expect(groupActivity(merged, 'device').map((g) => g.label).sort()).toEqual(['yosemite-s0', 'zion']);
  });
});

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('attachments schema (RUSH-2013)', () => {
  it('sanitizeAttachments drops entries without an href and clamps meta', () => {
    const out = sanitizeAttachments([
      { kind: 'image', href: ' cover.png ', name: 'Cover', bytes: 42, meta: { width: 800, junk: {} } },
      { kind: 'link' }, // no href -> dropped
      { href: 'https://x/y' }, // kind defaults to link
      'nope', // not an object -> dropped
    ]);
    expect(out).toEqual([
      { kind: 'image', href: 'cover.png', name: 'Cover', bytes: 42, meta: { width: 800 } },
      { kind: 'link', href: 'https://x/y' },
    ]);
  });

  it('sanitizeAttachments returns undefined for non-arrays / empty', () => {
    expect(sanitizeAttachments(undefined)).toBeUndefined();
    expect(sanitizeAttachments([])).toBeUndefined();
    expect(sanitizeAttachments('x')).toBeUndefined();
  });

  it('appended attachments + project survive a read round-trip', () => {
    const dir = tmpActivityDir();
    appendActivityEvent({
      ts: '2026-07-31T10:00:00.000Z', event: 'status.posted', sessionId: 's1', mailboxId: 's1',
      host: 'zion', runtime: 'headless', project: 'agents-cli', detail: 'shipped',
      attachments: [{ kind: 'audio', href: '/a/draft.wav', name: 'draft.wav', bytes: 10 }],
    }, dir);
    const [event] = readSessionActivity('s1', dir);
    expect(event.project).toBe('agents-cli');
    expect(event.attachments).toEqual([{ kind: 'audio', href: '/a/draft.wav', name: 'draft.wav', bytes: 10 }]);
  });
});

describe('formatProgressUpdate (RUSH-2014)', () => {
  const base: ActivityEvent = {
    v: 1, tier: 'milestone', ts: new Date().toISOString(), event: 'status.posted',
    sessionId: '0108441e-2d15-4d2f-a58b-974a886c9b47', mailboxId: 'm', host: 'yosemite-s1',
    runtime: 'teams', agent: 'grok', project: 'agents', detail: 'CHANGELOG pushed; watching CI',
  };

  it('shows agent, session short id, host, project chips + message', () => {
    const out = stripAnsi(formatProgressUpdate(base));
    expect(out).toContain('▸ update');
    expect(out).toContain('grok · 0108441e · yosemite-s1 · agents');
    expect(out).toContain('"CHANGELOG pushed; watching CI"');
    expect(out).toContain('ag focus 0108441e');
  });

  it('lists attachments by name, basename fallback when name absent', () => {
    const out = stripAnsi(formatProgressUpdate({
      ...base,
      attachments: [
        { kind: 'audio', href: '/x/draft.wav', name: 'draft.wav' },
        { kind: 'image', href: '/x/cover.png' },
      ],
    }));
    expect(out).toContain('draft.wav');
    expect(out).toContain('cover.png');
  });

  it('omits chips that are unknown', () => {
    const out = stripAnsi(formatProgressUpdate({
      ...base, agent: undefined, host: 'unknown', project: undefined,
    }));
    expect(out).not.toContain('unknown');
    expect(out).toContain('0108441e');
  });

  it('joins ticket / label at display time when provided', () => {
    const out = stripAnsi(formatProgressUpdate(base, { joined: { ticketId: 'RUSH-2014', label: 'render' } }));
    expect(out).toContain('RUSH-2014');
    expect(out).toContain('render');
  });
});

describe('shortSessionId / attachmentName', () => {
  it('strips known prefixes and takes 8 chars', () => {
    expect(shortSessionId('0108441e-2d15')).toBe('0108441e');
    expect(shortSessionId('session_abcdef01-x')).toBe('abcdef01');
    expect(shortSessionId('ses_01HZXABCDEF')).toBe('01HZXABC');
  });
  it('falls back to href basename when name absent', () => {
    expect(attachmentName({ kind: 'image', href: '/a/b/cover.png' })).toBe('cover.png');
    expect(attachmentName({ kind: 'link', href: 'https://x/y/z', name: '  ' })).toBe('z');
  });
});
