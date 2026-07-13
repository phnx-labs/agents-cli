import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  FEED_PUBLISH_HOOK_SCRIPT,
  ensureFeedPublishHook,
  publishBlock,
  listBlocks,
  readBlock,
  removeBlock,
  blockIdForSession,
  recordAnswer,
  recordMessageReceipt,
  recordContinued,
  getAnswerRecord,
  isBlockAnswered,
  type OpenBlock,
} from './feed.js';

const hasPython = spawnSync('python3', ['--version']).status === 0;

function tmpFeedDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-test-'));
}

function makeBlock(sessionId: string, text: string, opts?: Partial<OpenBlock>): OpenBlock {
  return {
    blockId: blockIdForSession(sessionId),
    sessionId,
    mailboxId: sessionId,
    host: 'test-host',
    runtime: 'claude',
    ts: new Date().toISOString(),
    questions: [{ text }],
    ...opts,
  };
}

describe('feed store', () => {
  it('publishes a block and reads it back', () => {
    const dir = tmpFeedDir();
    const block = makeBlock('sess-1', 'Which approach?', {
      questions: [{
        text: 'Which approach?',
        header: 'Approach',
        options: [
          { label: 'A', description: 'Option A' },
          { label: 'B', description: 'Option B' },
        ],
        multiSelect: false,
      }],
    });
    publishBlock(block, dir);

    const blocks = listBlocks(dir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].blockId).toBe('block-sess-1');
    expect(blocks[0].sessionId).toBe('sess-1');
    expect(blocks[0].questions[0].text).toBe('Which approach?');
    expect(blocks[0].questions[0].options).toHaveLength(2);
    expect(blocks[0].questions[0].options![0].label).toBe('A');
  });

  it('replaces a block when the same session publishes again', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('sess-2', 'first question'), dir);
    publishBlock(makeBlock('sess-2', 'second question'), dir);

    const blocks = listBlocks(dir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].questions[0].text).toBe('second question');
  });

  it('lists multiple blocks from different sessions', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('aaa', 'question A'), dir);
    publishBlock(makeBlock('bbb', 'question B'), dir);
    publishBlock(makeBlock('ccc', 'question C'), dir);

    const blocks = listBlocks(dir);
    expect(blocks).toHaveLength(3);
    expect(blocks.map(b => b.sessionId)).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('removes a block by id', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('to-remove', 'remove me'), dir);
    expect(listBlocks(dir)).toHaveLength(1);

    const removed = removeBlock(blockIdForSession('to-remove'), dir);
    expect(removed).toBe(true);
    expect(listBlocks(dir)).toHaveLength(0);
  });

  it('removeBlock returns false for a missing block', () => {
    const dir = tmpFeedDir();
    expect(removeBlock('no-such-block', dir)).toBe(false);
  });

  it('listBlocks returns empty for a missing directory', () => {
    expect(listBlocks('/tmp/nonexistent-feed-dir-' + Date.now())).toEqual([]);
  });

  it('skips corrupt JSON files', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('valid', 'a real question'), dir);
    fs.writeFileSync(path.join(dir, 'corrupt.json'), '{not valid json', 'utf-8');
    fs.writeFileSync(path.join(dir, 'empty.json'), '{}', 'utf-8');

    const blocks = listBlocks(dir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].sessionId).toBe('valid');
  });

  it('publish is atomic (no partial reads)', () => {
    const dir = tmpFeedDir();
    const block = makeBlock('atomic', 'atomic write test');
    publishBlock(block, dir);

    const files = fs.readdirSync(dir);
    expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
    expect(files.filter(f => f.endsWith('.json'))).toHaveLength(1);
  });

  it('blockIdForSession produces a deterministic id', () => {
    expect(blockIdForSession('abc-123')).toBe('block-abc-123');
    expect(blockIdForSession('abc-123')).toBe(blockIdForSession('abc-123'));
  });

  it('sanitizes session ids before using them as filenames', () => {
    expect(blockIdForSession('../../outside/session')).toBe('block-..-..-outside-session');
    const dir = tmpFeedDir();
    expect(() => publishBlock(makeBlock('safe', 'question', { blockId: '../escape' }), dir)).toThrow('Invalid feed block id');
  });

  it('preserves ticket and PR fields', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('with-meta', 'question', {
      ticket: 'RUSH-1473',
      pr: 'https://github.com/phnx-labs/agents-cli/pull/999',
    }), dir);

    const blocks = listBlocks(dir);
    expect(blocks[0].ticket).toBe('RUSH-1473');
    expect(blocks[0].pr).toBe('https://github.com/phnx-labs/agents-cli/pull/999');
  });

  it('preserves every question in one AskUserQuestion block', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('multi-question', 'first', {
      questions: [
        { text: 'First?', header: 'One', options: [{ label: 'A' }] },
        { text: 'Second?', header: 'Two', options: [{ label: 'B' }], multiSelect: true },
      ],
    }), dir);

    const blocks = listBlocks(dir);
    expect(blocks[0].questions.map((q) => q.text)).toEqual(['First?', 'Second?']);
    expect(blocks[0].questions[1].multiSelect).toBe(true);
  });

  it.runIf(hasPython)('real hook publishes every question and runtime into the shared feed', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-hook-'));
    const mailbox = path.join(home, '.agents', '.history', 'mailbox', 'session-123');
    const result = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-123',
        tool_input: {
          questions: [
            { question: 'First?', header: 'One', options: [{ label: 'A', description: 'alpha' }], multiSelect: false },
            { question: 'Second?', header: 'Two', options: [{ label: 'B', description: 'beta' }], multiSelect: true },
          ],
        },
      }),
      env: { ...process.env, HOME: home, AGENTS_MAILBOX_DIR: mailbox, AGENTS_RUNTIME: 'teams' },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    const blocks = listBlocks(path.join(home, '.agents', '.history', 'feed'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].mailboxId).toBe('session-123');
    expect(blocks[0].runtime).toBe('teams');
    expect(blocks[0].kind).toBe('question');
    expect(blocks[0].questions.map((q) => q.text)).toEqual(['First?', 'Second?']);

    const replace = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-123',
        tool_input: { questions: [{ question: 'Replacement?', header: 'New' }] },
      }),
      env: { ...process.env, HOME: home, AGENTS_MAILBOX_DIR: mailbox, AGENTS_RUNTIME: 'teams' },
      encoding: 'utf-8',
    });
    expect(replace.status).toBe(0);
    expect(listBlocks(path.join(home, '.agents', '.history', 'feed'))).toMatchObject([
      { questions: [{ text: 'Replacement?' }] },
    ]);
  });

  it.runIf(hasPython)('real hook publishes waiting notifications with routing identity', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-notification-'));
    const mailbox = path.join(home, '.agents', '.history', 'mailbox', 'session-notify');
    const result = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-notify',
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        title: 'Permission needed',
        message: 'Claude needs permission to use Bash',
      }),
      env: { ...process.env, HOME: home, AGENTS_MAILBOX_DIR: mailbox, AGENTS_RUNTIME: 'headless' },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    const blocks = listBlocks(path.join(home, '.agents', '.history', 'feed'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      mailboxId: 'session-notify',
      runtime: 'headless',
      kind: 'notification',
      notificationType: 'permission_prompt',
    });
    expect(blocks[0].questions).toEqual([{
      text: 'Claude needs permission to use Bash',
      header: 'Permission needed',
      multiSelect: false,
    }]);
  });

  it.runIf(hasPython)('real hook keeps AskUserQuestion details when Claude emits its permission notification', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-question-notification-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const question = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-question-notify',
        hook_event_name: 'PreToolUse',
        tool_input: {
          questions: [{
            question: 'Which environment?',
            header: 'Deploy',
            options: [
              { label: 'Staging', description: 'Deploy to staging' },
              { label: 'Production', description: 'Deploy to production' },
            ],
          }],
        },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(question.status).toBe(0);

    const notification = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-question-notify',
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        title: 'Permission Prompt',
        message: 'Claude needs your permission',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(notification.status).toBe(0);
    expect(listBlocks(feedDir)).toMatchObject([{
      kind: 'question',
      questions: [{
        text: 'Which environment?',
        header: 'Deploy',
        options: [
          { label: 'Staging', description: 'Deploy to staging' },
          { label: 'Production', description: 'Deploy to production' },
        ],
      }],
    }]);
  });

  it.runIf(hasPython)('real hook ignores notifications that do not represent a wait', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-notification-ignore-'));
    const result = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-auth',
        hook_event_name: 'Notification',
        notification_type: 'auth_success',
        message: 'Authentication succeeded',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(listBlocks(path.join(home, '.agents', '.history', 'feed'))).toEqual([]);
  });

  it.runIf(hasPython)('real hook clears a question after AskUserQuestion completes', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-answer-clear-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const publish = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-answer',
        hook_event_name: 'PreToolUse',
        tool_input: { questions: [{ question: 'Choose?', options: [{ label: 'A' }] }] },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(publish.status).toBe(0);
    expect(listBlocks(feedDir)).toHaveLength(1);

    const clear = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-answer',
        hook_event_name: 'PostToolUse',
        tool_name: 'AskUserQuestion',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(clear.status).toBe(0);
    expect(listBlocks(feedDir)).toEqual([]);
  });

  it.runIf(hasPython)('real hook clears an idle notification when the user resumes', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-resume-clear-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const publish = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-idle',
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        message: 'Claude is waiting for your next prompt',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(publish.status).toBe(0);
    expect(listBlocks(feedDir)).toHaveLength(1);

    const clear = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({ session_id: 'session-idle', hook_event_name: 'UserPromptSubmit' }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(clear.status).toBe(0);
    expect(listBlocks(feedDir)).toEqual([]);
  });

  it.runIf(hasPython)('real hook gates Task subagents out', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-subagent-'));
    const result = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-subagent',
        agent_type: 'Explore',
        tool_input: { questions: [{ question: 'Should not publish?' }] },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(listBlocks(path.join(home, '.agents', '.history', 'feed'))).toEqual([]);
  });

  it('installs the hook without discarding existing YAML comments', () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-install-'));
    fs.mkdirSync(userDir, { recursive: true });
    const agentsYaml = path.join(userDir, 'agents.yaml');
    fs.writeFileSync(agentsYaml, 'hooks:\n  # keep this comment\n  existing:\n    agents: [claude]\n    events: [Stop]\n    script: existing.sh\n');
    expect(ensureFeedPublishHook(userDir)).toEqual({ installed: true });
    expect(ensureFeedPublishHook(userDir)).toEqual({ installed: false });
    const updated = fs.readFileSync(agentsYaml, 'utf-8');
    expect(updated).toContain('# keep this comment');
    expect(updated).toContain('feed-publish:');
    expect(updated).toContain('feed-publish-notification:');
    expect(updated).toContain('feed-clear-answered:');
    expect(updated).toContain('feed-clear-lifecycle:');
    expect(fs.readFileSync(path.join(userDir, 'hooks', '10-feed-publish.py'), 'utf-8')).toBe(FEED_PUBLISH_HOOK_SCRIPT);
  });

  it('recordAnswer claims the first answer and rejects later ones', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('sess-answer', 'Which one?'), dir);
    const blockId = blockIdForSession('sess-answer');

    const first = recordAnswer(blockId, { answeredBy: 'operator-a', answeredFrom: 'feed' }, dir);
    expect(first).toEqual({ ok: true });
    expect(isBlockAnswered(blockId, dir)).toBe(true);
    expect(getAnswerRecord(blockId, dir)).toMatchObject({ answeredFrom: 'feed', answeredBy: 'operator-a' });
    expect(readBlock(blockId, dir)?.answer).toMatchObject({ answeredFrom: 'feed', answeredBy: 'operator-a' });

    const second = recordAnswer(blockId, { answeredBy: 'operator-b', answeredFrom: 'feed' }, dir);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.existing.answeredBy).toBe('operator-a');
    }
  });

  it('recordMessageReceipt tracks queued → consumed → continued lifecycle', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('sess-receipt', 'Confirm?'), dir);
    const blockId = blockIdForSession('sess-receipt');

    recordMessageReceipt(blockId, { msgId: 'msg-1', status: 'queued', at: '2026-01-01T00:00:00.000Z' }, dir);
    recordMessageReceipt(blockId, { msgId: 'msg-1', status: 'consumed', at: '2026-01-01T00:00:01.000Z' }, dir);
    recordMessageReceipt(blockId, { msgId: 'msg-1', status: 'continued', at: '2026-01-01T00:00:02.000Z' }, dir);
    recordContinued(blockId, dir);

    const block = readBlock(blockId, dir)!;
    expect(block.receipts).toHaveLength(1);
    expect(block.receipts![0]).toMatchObject({ msgId: 'msg-1', status: 'continued' });
    expect(block.continuedAt).toBeTruthy();
  });

  it('removeBlock clears answered markers and receipts', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('sess-cleanup', 'Clean me?'), dir);
    const blockId = blockIdForSession('sess-cleanup');
    recordAnswer(blockId, { answeredFrom: 'feed' }, dir);
    recordMessageReceipt(blockId, { msgId: 'm', status: 'queued', at: new Date().toISOString() }, dir);

    expect(removeBlock(blockId, dir)).toBe(true);
    expect(listBlocks(dir)).toHaveLength(0);
    expect(isBlockAnswered(blockId, dir)).toBe(false);
  });

  it.runIf(hasPython)('real hook records terminal answers and removes the visible block', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-terminal-answer-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const publish = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-terminal',
        hook_event_name: 'PreToolUse',
        tool_input: { questions: [{ question: 'Choose?', options: [{ label: 'A' }] }] },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(publish.status).toBe(0);
    expect(listBlocks(feedDir)).toHaveLength(1);

    const answer = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({ session_id: 'session-terminal', hook_event_name: 'UserPromptSubmit' }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(answer.status).toBe(0);
    expect(listBlocks(feedDir)).toEqual([]);
    expect(isBlockAnswered('block-session-terminal', feedDir)).toBe(true);
    expect(getAnswerRecord('block-session-terminal', feedDir)).toMatchObject({ answeredFrom: 'terminal' });
  });

  it.runIf(hasPython)('real hook clears stale answered marker when a new question is published', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-new-question-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const sessionId = 'session-new-q';
    const blockId = blockIdForSession(sessionId);

    const publish = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_input: { questions: [{ question: 'First?' }] },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(publish.status).toBe(0);

    const answer = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({ session_id: sessionId, hook_event_name: 'UserPromptSubmit' }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(answer.status).toBe(0);
    expect(isBlockAnswered(blockId, feedDir)).toBe(true);

    const republish = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_input: { questions: [{ question: 'Second?' }] },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(republish.status).toBe(0);
    expect(isBlockAnswered(blockId, feedDir)).toBe(false);
    expect(listBlocks(feedDir)).toMatchObject([{ questions: [{ text: 'Second?' }] }]);
  });
});
