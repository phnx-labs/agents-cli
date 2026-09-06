import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadDevices, isDialableDevice } from '../devices/registry.js';
import { machineId, normalizeHost } from '../machine-id.js';
import { shellQuote } from '../ssh-exec.js';
import { buildWindowsAgentsCommand, remoteShellFor } from '../hosts/remote-cmd.js';
import { getFeedDir } from '../state.js';
import { streamFromPeer } from '../session/remote/peer-stream.js';
import { watchLocalSessions, type SessionWatchEnvelope, type SessionWatchRow, type SessionWatchScopeStatus, type WatchLocalOptions } from '../session/watch.js';
import { readBlock, readResolution, blockIdForSession } from './feed.js';
import { reconcileAttention, type AttentionItem } from './attention.js';
import { type ActivityEvent } from './activity.js';
import { ActivityStream } from './activity-stream.js';
import { PR_STATUS_TTL_MS, readPullRequestStatus } from './pr-status.js';

export const FEED_WATCH_VERSION = 1 as const;
type Base = { v: 1; type: string; streamId: string; sequence: number; scope: string };
export type FeedWatchEnvelope =
  | Base & { type: 'reset'; capturedAt: number; agents: SessionWatchRow[]; attention: AttentionItem[] }
  | Base & { type: 'agent.upsert'; rowKey: string; agent: SessionWatchRow }
  | Base & { type: 'agent.remove'; rowKey: string }
  | Base & { type: 'attention.upsert'; rowKey: string; attention: AttentionItem }
  | Base & { type: 'attention.remove'; rowKey: string }
  | Base & { type: 'activity.append'; event: ActivityEvent }
  | Base & { type: 'scope'; capturedAt: number; status: SessionWatchScopeStatus; reason?: string }
  | Base & { type: 'heartbeat'; capturedAt: number };
type FeedWatchPayload = FeedWatchEnvelope extends infer Envelope
  ? Envelope extends FeedWatchEnvelope ? Omit<Envelope, 'v' | 'streamId' | 'sequence'> : never
  : never;

export class FeedWatchState {
  readonly streamId: string;
  private sequence = 0;
  constructor(streamId = randomUUID()) { this.streamId = streamId; }
  emit(event: FeedWatchPayload): FeedWatchEnvelope {
    return { v: 1, streamId: this.streamId, sequence: ++this.sequence, ...event } as unknown as FeedWatchEnvelope;
  }
}

async function attentionFor(agent: SessionWatchRow): Promise<AttentionItem | undefined> {
  // Durable Previous rows share the operator stream for Sessions history, but
  // they are not live work and must never synthesize Needs-you attention.
  if (!agent.sessionId || agent.previous || agent.context === 'recent') return undefined;
  const blockId = blockIdForSession(agent.sessionId);
  // ActiveSession.host names the terminal app; the feed contract's host is the
  // device scope. Normalize only the reconciler input so lifecycle/PR keys are
  // routable across the fleet while the projected agent row stays compatible.
  const session: import('../session/active.js').ActiveSession = {
    ...agent,
    context: agent.context,
    host: agent.sourceDevice,
    viewingIn: undefined,
  };
  return reconcileAttention({
    block: readBlock(blockId), session,
    resolution: readResolution(blockId),
    pullRequest: await readPullRequestStatus(session), nowMs: Date.now(),
  });
}

export async function projectSessionEnvelope(event: SessionWatchEnvelope, state: FeedWatchState): Promise<FeedWatchEnvelope[]> {
  if (event.type === 'reset') {
    const attention = (await Promise.all(event.rows.map(attentionFor))).filter((item): item is AttentionItem => item !== undefined);
    return [state.emit({ type: 'reset', capturedAt: event.capturedAt, scope: event.scope, agents: event.rows, attention })];
  }
  if (event.type === 'upsert') {
    const attention = await attentionFor(event.row);
    return [
      state.emit({ type: 'agent.upsert', scope: event.scope, rowKey: event.rowKey, agent: event.row }),
      attention
        ? state.emit({ type: 'attention.upsert', scope: event.scope, rowKey: event.rowKey, attention })
        : state.emit({ type: 'attention.remove', scope: event.scope, rowKey: event.rowKey }),
    ];
  }
  if (event.type === 'remove') return [
    state.emit({ type: 'agent.remove', scope: event.scope, rowKey: event.rowKey }),
    state.emit({ type: 'attention.remove', scope: event.scope, rowKey: event.rowKey }),
  ];
  if (event.type === 'scope') return [state.emit({ type: 'scope', capturedAt: event.capturedAt, scope: event.scope, status: event.status, ...(event.reason ? { reason: event.reason } : {}) })];
  return [state.emit({ type: 'heartbeat', capturedAt: event.capturedAt, scope: event.scope })];
}

/**
 * Watch the feed dirs that can change attention without a session event: an
 * `agents feed post --blocked` writes a block, `feed answer` writes a
 * resolution. Both are external processes, so nothing on the session stream
 * announces them — this is what lets the reconcile pass be event-driven instead
 * of a poll over every row twice a second.
 */
function watchAttentionStores(onChange: () => void): () => void {
  const feedDir = getFeedDir();
  const watchers: fs.FSWatcher[] = [];
  for (const dir of [feedDir, path.join(feedDir, 'resolutions')]) {
    try {
      const watcher = fs.watch(dir, () => onChange());
      // A directory that disappears must not take the watcher process down; the
      // PR-status cadence below still reconciles on its own timer.
      watcher.on('error', () => watcher.close());
      watchers.push(watcher);
    } catch { /* the dir appears with the first block; the timed pass covers it */ }
  }
  return () => { for (const watcher of watchers) watcher.close(); };
}

export interface WatchLocalFeedOptions {
  scope: string;
  signal: AbortSignal;
  emit: (event: FeedWatchEnvelope) => void;
  /** Activity drain cadence. */
  activityPollMs?: number;
  /** Attention reconcile cadence when nothing has announced a change. */
  reconcileMs?: number;
  /** Session-watch inputs, forwarded verbatim to {@link watchLocalSessions}. */
  sessions?: Pick<WatchLocalOptions, 'readCache' | 'readPrevious' | 'journalPath' | 'journalPollMs' | 'heartbeatMs'>;
}

export async function watchLocalFeed(options: WatchLocalFeedOptions): Promise<void> {
  const state = new FeedWatchState();
  let activityCursor = Date.now();
  const activity = new ActivityStream();
  const agents = new Map<string, SessionWatchRow>();
  const attention = new Map<string, string>();
  let pending = Promise.resolve();
  const reconcileRows = async () => {
    for (const [rowKey, agent] of agents) {
      const item = await attentionFor(agent);
      const next = item ? JSON.stringify(item) : '';
      if (attention.get(rowKey) === next) continue;
      attention.set(rowKey, next);
      options.emit(item
        ? state.emit({ type: 'attention.upsert', scope: options.scope, rowKey, attention: item })
        : state.emit({ type: 'attention.remove', scope: options.scope, rowKey }));
    }
  };
  // Attention is reconciled when something can actually have changed it — a row
  // moved, a block/resolution file was written — or when the PR-status TTL has
  // expired and the cached verdicts are stale. Re-running it every 500 ms cost
  // two file reads per row per tick and changed nothing.
  const reconcileMs = options.reconcileMs ?? PR_STATUS_TTL_MS;
  let attentionDirty = true;
  let lastReconcileMs = 0;
  const markAttentionDirty = () => { attentionDirty = true; };
  const stopAttentionWatch = watchAttentionStores(markAttentionDirty);
  const activityTimer = setInterval(() => {
    pending = pending.then(async () => {
      const nowMs = Date.now();
      const events = activity.read(activityCursor + 1, nowMs).reverse();
      for (const event of events) {
        activityCursor = Math.max(activityCursor, Date.parse(event.ts));
        options.emit(state.emit({ type: 'activity.append', scope: options.scope, event }));
      }
      if (!attentionDirty && nowMs - lastReconcileMs < reconcileMs) return;
      attentionDirty = false;
      lastReconcileMs = nowMs;
      await reconcileRows();
    });
  }, options.activityPollMs ?? 500);
  const stopActivity = () => { clearInterval(activityTimer); stopAttentionWatch(); activity.close(); };
  options.signal.addEventListener('abort', stopActivity, { once: true });
  try {
    await watchLocalSessions({ ...options.sessions, scope: options.scope, signal: options.signal, emit: (event) => {
      if (event.type === 'reset') {
        agents.clear();
        for (const row of event.rows) agents.set(row.rowKey, row);
      } else if (event.type === 'upsert') agents.set(event.rowKey, event.row);
      else if (event.type === 'remove') { agents.delete(event.rowKey); attention.delete(event.rowKey); }
      pending = pending.then(() => projectSessionEnvelope(event, state)).then((events) => {
        for (const projected of events) {
          if (projected.type === 'reset') {
            attention.clear();
            for (const row of projected.agents) attention.set(row.rowKey, '');
            for (const item of projected.attention) {
              const row = projected.agents.find((agent) => agent.sessionId === item.sessionId);
              if (row) attention.set(row.rowKey, JSON.stringify(item));
            }
          } else if (projected.type === 'attention.upsert') attention.set(projected.rowKey, JSON.stringify(projected.attention));
          else if (projected.type === 'attention.remove') attention.set(projected.rowKey, '');
          options.emit(projected);
        }
      });
    } });
    await pending;
  } finally { stopActivity(); }
}

function remoteFeedWatchCommand(os: string): string {
  const args = ['feed', 'watch', '--json', '--local'];
  return remoteShellFor(os) === 'powershell'
    ? buildWindowsAgentsCommand({ args })
    : `bash -lc ${shellQuote(`agents ${args.map(shellQuote).join(' ')}`)}`;
}

export async function watchFleetFeed(options: { signal: AbortSignal; emit: (event: FeedWatchEnvelope) => void; reconnectMs?: number }): Promise<void> {
  const coordinator = new FeedWatchState();
  const forward = (event: FeedWatchEnvelope) => {
    const { v: _v, streamId: peerStreamId, sequence: peerSequence, ...payload } = event;
    options.emit(coordinator.emit({ ...payload, peerStreamId, peerSequence } as unknown as FeedWatchPayload));
  };
  const local = watchLocalFeed({ scope: machineId(), signal: options.signal, emit: forward });
  let devices: Awaited<ReturnType<typeof loadDevices>>;
  try { devices = await loadDevices(); } catch { await local; return; }
  const self = machineId();
  const peers = Object.values(devices).filter((device) => isDialableDevice(device) && normalizeHost(device.name) !== self && ['windows', 'linux', 'macos'].includes(device.platform));
  const tasks = peers.map((device) => {
    const scope = normalizeHost(device.name);
    return streamFromPeer({
      device,
      signal: options.signal,
      command: remoteFeedWatchCommand(device.platform),
      backoffBaseMs: options.reconnectMs,
      onLine: (line) => {
        try {
          const event = JSON.parse(line) as FeedWatchEnvelope;
          if (event.v !== 1) return false;
          forward(event);
          return true;
        } catch { return false; /* protocol only */ }
      },
      onUnavailable: (reason) => options.emit(coordinator.emit({ type: 'scope', capturedAt: Date.now(), scope, status: 'unavailable', reason })),
    });
  });
  await Promise.all([local, ...tasks]);
}
