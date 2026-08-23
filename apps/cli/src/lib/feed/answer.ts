import { getActiveSessions, type ActiveSession } from '../session/active.js';
import { resolveAnswerRoute } from '../answer-router.js';
import { enqueue, mailboxDir } from '../mailbox.js';
import { injectIntoTerminal } from '../terminal/index.js';
import { verifyOperatorIdentity } from '../operator.js';
import {
  blockIdForSession,
  getAnswerRecord,
  readBlock,
  recordAnswer,
  recordMessageReceipt,
  type MessageReceipt,
  type OpenBlock,
} from './feed.js';
import { reconcileAttention, type AttentionItem } from './attention.js';

export interface VerifiedOperator { id?: string; verified: boolean; label?: string }
export interface FeedAnswerResult { status: 'delivered' | 'already_answered'; receipt: MessageReceipt }

function sessionForBlock(block: OpenBlock, sessions: ActiveSession[]): ActiveSession | undefined {
  return sessions.find((session) => session.sessionId === block.sessionId || session.agentId === block.mailboxId);
}

function resolveBlock(attentionKey: string, sessions: ActiveSession[], root?: string): { block: OpenBlock; attention: AttentionItem } {
  for (const session of sessions) {
    if (!session.sessionId) continue;
    const block = readBlock(blockIdForSession(session.sessionId), root);
    if (!block) continue;
    const attention = reconcileAttention({ block, session, nowMs: Date.now() });
    if (attention?.key === attentionKey) return { block, attention };
    // The winning caller advances the block to answered before a concurrent
    // loser resolves it. Reconstruct only this block's original generation so
    // the loser can return already_answered without routing a second reply.
    const original = reconcileAttention({ block: { ...block, state: 'open', answer: undefined }, session, nowMs: Date.now() });
    if (original?.key === attentionKey && getAnswerRecord(block.blockId, root)) return { block, attention: original };
  }
  throw new Error(`No open attention item matches '${attentionKey}'.`);
}

/** Atomically claim the first answer, then route it over the session's recorded reply rail. */
export async function claimAndRouteAttentionAnswer(input: {
  attentionKey: string;
  choiceId?: string;
  text?: string;
  operator: VerifiedOperator;
  feedRoot?: string;
  mailboxRoot?: string;
  sessions?: ActiveSession[];
}): Promise<FeedAnswerResult> {
  if ((input.choiceId == null) === (input.text == null)) throw new Error('Exactly one of choiceId or text is required.');
  const sessions = input.sessions ?? await getActiveSessions();
  const { block, attention } = resolveBlock(input.attentionKey, sessions, input.feedRoot);
  const choice = input.choiceId == null ? undefined : attention.choices?.find((item) => item.id === input.choiceId);
  if (input.choiceId != null && !choice) throw new Error(`Unknown choice '${input.choiceId}' for '${input.attentionKey}'.`);
  const answer = input.text ?? choice?.deliveryKey ?? choice?.label;
  if (!answer) throw new Error('Answer is empty.');
  const verified = input.operator.verified && verifyOperatorIdentity(input.operator.id);
  const claim = recordAnswer(block.blockId, {
    answeredBy: input.operator.label,
    answeredFrom: 'feed',
    operatorId: input.operator.id,
    verified,
  }, input.feedRoot);
  if (!claim.ok) {
    if ('unauthorized' in claim) throw new Error(claim.reason);
    const existing = getAnswerRecord(block.blockId, input.feedRoot) ?? claim.existing;
    return { status: 'already_answered', receipt: {
      msgId: `answer-${block.blockId}`,
      status: 'queued',
      at: existing.answeredAt,
      from: existing.answeredBy ?? existing.answeredFrom,
    } };
  }

  const session = sessionForBlock(block, sessions);
  const route = resolveAnswerRoute({ mailboxId: block.mailboxId, answer, block, session });
  if (route.kind === 'refuse' || route.kind === 'resume') {
    throw new Error(route.kind === 'resume'
      ? `Attention '${input.attentionKey}' has no live reply rail; resume delivery is not safe after an atomic UI claim.`
      : route.reason);
  }
  let msgId: string;
  if (route.kind === 'mailbox') {
    msgId = enqueue(mailboxDir(block.mailboxId, input.mailboxRoot), {
      to: block.mailboxId, text: answer, from: input.operator.label, blockId: block.blockId,
    });
  } else {
    if (!route.inject || route.payload == null) throw new Error(`Incomplete ${route.kind} reply rail.`);
    const delivered = await injectIntoTerminal(route.inject, route.payload, { enter: true, combined: false });
    if (!delivered.ok) throw new Error(delivered.error ?? `Failed to deliver over ${route.kind}.`);
    msgId = `inject-${Date.now()}`;
  }
  const receipt: MessageReceipt = { msgId, status: 'queued', at: new Date().toISOString(), from: input.operator.label };
  recordMessageReceipt(block.blockId, receipt, input.feedRoot);
  return { status: 'delivered', receipt };
}
