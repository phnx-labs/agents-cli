import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_POLICY,
  loadPolicy,
  blockClass,
  isPhoneUrgent,
  isTimedOut,
  applyPolicyToBlock,
} from './feed-policy.js';
import { publishBlock, readBlock, listBlocks, blockIdForSession, type OpenBlock } from './feed.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-policy-test-'));
}

function makeBlock(sessionId: string, opts?: Partial<OpenBlock>): OpenBlock {
  return {
    blockId: blockIdForSession(sessionId),
    sessionId,
    mailboxId: sessionId,
    host: 'test-host',
    runtime: 'claude',
    ts: new Date().toISOString(),
    questions: [{ text: 'Deploy?' }],
    ...opts,
  };
}

describe('feed policy', () => {
  it('loads defaults when policy file is missing', () => {
    const dir = tmpDir();
    expect(loadPolicy(dir)).toEqual(DEFAULT_POLICY);
  });

  it('loads custom policy from yaml', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'feed-policy.yaml'), `approval:
  timeoutMinutes: 10
  safeDefault: "no"
decision:
  timeoutMinutes: 120
phoneNotifyThreshold: high
`, 'utf-8');
    const p = loadPolicy(dir);
    expect(p.approval).toEqual({ timeoutMinutes: 10, safeDefault: 'no' });
    expect(p.decision.timeoutMinutes).toBe(120);
    expect(p.phoneNotifyThreshold).toBe('high');
  });

  it('classifies blocks', () => {
    expect(blockClass(makeBlock('a', { blockClass: 'approval' }))).toBe('approval');
    expect(blockClass(makeBlock('a', { blockClass: 'decision' }))).toBe('decision');
    expect(blockClass(makeBlock('a', {}))).toBe('approval');
  });

  it('decides phone urgency by cost threshold', () => {
    const policy = loadPolicy(tmpDir());
    expect(isPhoneUrgent(makeBlock('a', { costOfDelay: 'low' }), policy)).toBe(false);
    expect(isPhoneUrgent(makeBlock('a', { costOfDelay: 'high' }), policy)).toBe(true);
    expect(isPhoneUrgent(makeBlock('a', { costOfDelay: 'high', answer: { answeredAt: '', answeredFrom: 'feed' } }), policy)).toBe(false);
  });

  it('times out after configured minutes', () => {
    const now = new Date('2026-01-01T00:35:00.000Z');
    const block = makeBlock('a', { ts: '2026-01-01T00:00:00.000Z', blockClass: 'approval' });
    expect(isTimedOut(block, DEFAULT_POLICY, now)).toBe(true);
    const early = makeBlock('a', { ts: '2026-01-01T00:10:00.000Z', blockClass: 'approval' });
    expect(isTimedOut(early, DEFAULT_POLICY, now)).toBe(false);
  });

  it('auto-defaults an approval block after timeout', () => {
    const dir = tmpDir();
    const ts = '2026-01-01T00:00:00.000Z';
    publishBlock(makeBlock('a', { blockClass: 'approval', safeDefault: 'deny', ts }), dir);
    const policy = DEFAULT_POLICY;
    const now = new Date('2026-01-01T00:35:00.000Z');

    const result = applyPolicyToBlock(readBlock(blockIdForSession('a'), dir)!, policy, now, dir);

    expect(result.action).toBe('defaulted');
    const updated = readBlock(blockIdForSession('a'), dir)!;
    expect(updated.answer?.answeredFrom).toBe('policy');
    expect(updated.defaultedAt).toBeTruthy();
  });

  it('hard-parks a decision block after timeout', () => {
    const dir = tmpDir();
    const ts = '2026-01-01T00:00:00.000Z';
    publishBlock(makeBlock('a', { blockClass: 'decision', ts }), dir);
    const policy = DEFAULT_POLICY;
    const now = new Date('2026-01-01T01:05:00.000Z');

    const result = applyPolicyToBlock(readBlock(blockIdForSession('a'), dir)!, policy, now, dir);

    expect(result.action).toBe('parked');
    const updated = readBlock(blockIdForSession('a'), dir)!;
    expect(updated.parkedAt).toBeTruthy();
  });

  it('does nothing before timeout or after answer', () => {
    const dir = tmpDir();
    publishBlock(makeBlock('a', { blockClass: 'approval', safeDefault: 'deny' }), dir);
    const now = new Date();
    const policy = DEFAULT_POLICY;

    expect(applyPolicyToBlock(readBlock(blockIdForSession('a'), dir)!, policy, now, dir).action).toBe('none');
  });
});
