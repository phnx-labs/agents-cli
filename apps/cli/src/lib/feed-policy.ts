/**
 * Feed timeout policy — unattended default-on-no-answer behavior.
 *
 * Two block classes:
 *   - Approval: has a safe default (e.g. 'deny'). After the configured timeout with
 *     no operator answer, the policy auto-records that default and queues it to the
 *     agent. Logged so the operator can audit later.
 *   - Decision: no safe default (a real choice). After the timeout the block is
 *     hard-parked: a parked marker is recorded and, if we can locate the session
 *     process, it is stopped so the agent cannot proceed on a stale default.
 *
 * Policy is loaded from ~/.agents/feed-policy.yaml. Missing file uses the built-in
 * conservative defaults.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getUserAgentsDir } from './state.js';
import {
  recordAnswer,
  recordDefaulted,
  recordMessageReceipt,
  recordParked,
  type OpenBlock,
  type AnswerRecord,
} from './feed.js';
import { enqueue, mailboxDir } from './mailbox.js';

export type BlockClass = 'approval' | 'decision';

export interface ClassPolicy {
  timeoutMinutes: number;
  /** For approval class only: the answer to apply when the timeout fires. */
  safeDefault?: string;
}

export interface FeedPolicy {
  approval: ClassPolicy;
  decision: ClassPolicy;
  /** High-cost-of-delay blocks below this threshold do not page the phone. */
  phoneNotifyThreshold: 'low' | 'medium' | 'high';
}

const POLICY_FILE = 'feed-policy.yaml';
const COST_RANK: Record<'low' | 'medium' | 'high', number> = { low: 0, medium: 1, high: 2 };

export const DEFAULT_POLICY: FeedPolicy = {
  approval: { timeoutMinutes: 30, safeDefault: 'deny' },
  decision: { timeoutMinutes: 60 },
  phoneNotifyThreshold: 'medium',
};

export function getPolicyPath(root?: string): string {
  return path.join(root ?? getUserAgentsDir(), POLICY_FILE);
}

function normalizeClassPolicy(raw: unknown): ClassPolicy {
  const p = (raw ?? {}) as Partial<ClassPolicy>;
  const timeout = typeof p.timeoutMinutes === 'number' ? p.timeoutMinutes : DEFAULT_POLICY.approval.timeoutMinutes;
  return {
    timeoutMinutes: Math.max(1, Math.round(timeout)),
    safeDefault: typeof p.safeDefault === 'string' ? p.safeDefault : undefined,
  };
}

export function loadPolicy(root?: string): FeedPolicy {
  const file = getPolicyPath(root);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = yaml.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Partial<FeedPolicy>;
      const threshold = p.phoneNotifyThreshold;
      return {
        approval: normalizeClassPolicy(p.approval ?? { timeoutMinutes: DEFAULT_POLICY.approval.timeoutMinutes, safeDefault: DEFAULT_POLICY.approval.safeDefault }),
        decision: normalizeClassPolicy(p.decision ?? { timeoutMinutes: DEFAULT_POLICY.decision.timeoutMinutes }),
        phoneNotifyThreshold: threshold === 'low' || threshold === 'medium' || threshold === 'high' ? threshold : DEFAULT_POLICY.phoneNotifyThreshold,
      };
    }
  } catch {
    // missing or malformed -> defaults
  }
  return DEFAULT_POLICY;
}

export function blockClass(block: OpenBlock): BlockClass {
  return block.blockClass === 'decision' ? 'decision' : 'approval';
}

export function isPhoneUrgent(block: OpenBlock, policy: FeedPolicy): boolean {
  if (block.answer) return false; // already answered
  const cost = block.costOfDelay ?? 'low';
  return COST_RANK[cost] >= COST_RANK[policy.phoneNotifyThreshold];
}

export function minutesElapsed(block: OpenBlock, now: Date): number {
  const ts = Date.parse(block.ts);
  if (Number.isNaN(ts)) return 0;
  return (now.getTime() - ts) / 60_000;
}

export function isTimedOut(block: OpenBlock, policy: FeedPolicy, now: Date): boolean {
  const cls = blockClass(block);
  const minutes = minutesElapsed(block, now);
  return minutes >= policy[cls].timeoutMinutes;
}

export interface PolicyResult {
  blockId: string;
  action: 'none' | 'defaulted' | 'parked';
  answer?: AnswerRecord;
}

/**
 * Apply policy to a single open block. Returns the action taken (none/defaulted/parked).
 * Caller is responsible for persistence/logging side effects not owned by feed.ts.
 */
export function applyPolicyToBlock(
  block: OpenBlock,
  policy: FeedPolicy,
  now: Date,
  root?: string,
): PolicyResult {
  if (block.answer || block.parkedAt || block.defaultedAt) {
    return { blockId: block.blockId, action: 'none' };
  }

  if (!isTimedOut(block, policy, now)) {
    return { blockId: block.blockId, action: 'none' };
  }

  const cls = blockClass(block);
  if (cls === 'approval') {
    const safeDefault = block.safeDefault ?? policy.approval.safeDefault;
    if (!safeDefault) {
      return { blockId: block.blockId, action: 'none' };
    }

    const claim = recordAnswer(
      block.blockId,
      { answeredFrom: 'policy', answeredBy: 'default-on-no-answer', operatorId: 'policy', verified: true },
      root,
    );
    if (!claim.ok) {
      return { blockId: block.blockId, action: 'none' };
    }

    const msgId = enqueue(mailboxDir(block.mailboxId, root ?? undefined), {
      to: block.mailboxId,
      text: safeDefault,
      from: 'policy',
      blockId: block.blockId,
    });
    recordMessageReceipt(
      block.blockId,
      { msgId, status: 'queued', at: now.toISOString(), from: 'policy' },
      root,
    );
    recordDefaulted(block.blockId, root);

    return {
      blockId: block.blockId,
      action: 'defaulted',
      answer: {
        answeredAt: now.toISOString(),
        answeredFrom: 'policy',
        answeredBy: 'default-on-no-answer',
        operatorId: 'policy',
        verified: true,
      },
    };
  }

  // Decision class: hard-park.
  recordParked(block.blockId, root);
  return {
    blockId: block.blockId,
    action: 'parked',
    answer: {
      answeredAt: now.toISOString(),
      answeredFrom: 'policy',
      answeredBy: 'hard-park',
      operatorId: 'policy',
      verified: true,
    },
  };
}
