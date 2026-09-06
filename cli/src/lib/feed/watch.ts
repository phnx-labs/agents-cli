import { SessionProjection } from '../session/projection.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { loadDevices, isDialableDevice } from '../devices/registry.js';
import { deviceIdentityArgs, sshTargetFor } from '../devices/connect.js';
import { machineId, normalizeHost } from '../machine-id.js';
import { SSH_OPTS, controlOpts, shellQuote } from '../ssh-exec.js';
import { buildWindowsAgentsCommand, remoteShellFor } from '../hosts/remote-cmd.js';
import { watchLocalSessions, type SessionWatchEnvelope, type SessionWatchRow, type SessionWatchScopeStatus } from '../session/watch.js';
import { readBlock, readResolution, blockIdForSession } from './feed.js';
import { reconcileAttention, type AttentionItem } from './attention.js';
import { readRecentActivity, type ActivityEvent } from './activity.js';
import { readPullRequestStatus } from './pr-status.js';

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

/** Reuse session ownership reconciliation for the combined operator stream. */
export class FeedSessionProjection {
  private readonly sessions = new SessionProjection();
  private readonly observations = new Map<string, Map<string, AttentionItem>>();
  private projectedAttention = new Map<string, { scope: string; item: AttentionItem }>();
  constructor(private readonly state = new FeedWatchState()) {}

  apply(event: FeedWatchEnvelope): FeedWatchEnvelope[] {
    const scope = normalizeHost(event.scope);
    const base = { version: 1 as const, streamId: event.streamId, sequence: event.sequence, capturedAt: 'capturedAt' in event ? event.capturedAt : Date.now(), scope };
    let sessionEvent: SessionWatchEnvelope | undefined;
    if (event.type === 'reset') {
      sessionEvent = { ...base, type: 'reset', rows: event.agents };
      const attention = new Map<string, AttentionItem>();
      for (const row of event.agents) {
        const item = event.attention.find(item => item.sessionId === row.sessionId);
        if (item && !row.previous) attention.set(row.rowKey, item);
      }
      this.observations.set(scope, attention);
    } else if (event.type === 'agent.upsert') {
      sessionEvent = { ...base, type: 'upsert', rowKey: event.rowKey, row: event.agent };
    } else if (event.type === 'agent.remove') {
      sessionEvent = { ...base, type: 'remove', rowKey: event.rowKey };
      this.observations.get(scope)?.delete(event.rowKey);
    } else if (event.type === 'attention.upsert') {
      if (!this.observations.has(scope)) this.observations.set(scope, new Map());
      this.observations.get(scope)!.set(event.rowKey, event.attention);
    } else if (event.type === 'attention.remove') {
      this.observations.get(scope)?.delete(event.rowKey);
    } else {
      const { v: _v, streamId: _streamId, sequence: _sequence, ...payload } = event;
      return [this.state.emit(payload)];
    }
    const projected = sessionEvent ? this.sessions.apply(sessionEvent) : [];
    const next = new Map<string, { scope: string; item: AttentionItem }>();
    for (const [observer, items] of this.observations) for (const [rowKey, item] of items) {
      const row = this.sessions.rowForObservation(observer, rowKey);
      if (row && !row.previous && row.sourceDevice === observer) next.set(item.key, { scope: observer, item });
    }
    const result: FeedWatchEnvelope[] = [];
    const resetScopes = new Set<string>();
    for (const rowEvent of projected) {
      if (rowEvent.type === 'reset') {
        resetScopes.add(rowEvent.scope);
        result.push(this.state.emit({ type: 'reset', scope: rowEvent.scope, capturedAt: rowEvent.capturedAt, agents: rowEvent.rows,
          attention: [...next.values()].filter(value => value.scope === rowEvent.scope).map(value => value.item) }));
      } else if (rowEvent.type === 'upsert') {
        result.push(this.state.emit({ type: 'agent.upsert', scope: rowEvent.scope, rowKey: rowEvent.rowKey, agent: rowEvent.row }));
      } else if (rowEvent.type === 'remove') {
        result.push(this.state.emit({ type: 'agent.remove', scope: rowEvent.scope, rowKey: rowEvent.rowKey }));
      }
    }
    // Attention has its own stable generation key, also used by feed answer.
    // Never substitute the projected agent row key: reset consumers key by item.key.
    for (const [key, previous] of this.projectedAttention) {
      if (!next.has(key) && !resetScopes.has(previous.scope)) result.push(this.state.emit({ type: 'attention.remove', scope: previous.scope, rowKey: key }));
    }
    for (const [key, value] of next) {
      if (!resetScopes.has(value.scope) && JSON.stringify(this.projectedAttention.get(key)) !== JSON.stringify(value)) {
        result.push(this.state.emit({ type: 'attention.upsert', scope: value.scope, rowKey: key, attention: value.item }));
      }
    }
    this.projectedAttention = next;
    return result;
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

export async function watchLocalFeed(options: { scope: string; signal: AbortSignal; emit: (event: FeedWatchEnvelope) => void; activityPollMs?: number }): Promise<void> {
  const state = new FeedWatchState();
  let activityCursor = Date.now();
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
  const activityTimer = setInterval(() => {
    pending = pending.then(async () => {
    const events = readRecentActivity({ sinceMs: activityCursor + 1 }).reverse();
    for (const event of events) {
      activityCursor = Math.max(activityCursor, Date.parse(event.ts));
      options.emit(state.emit({ type: 'activity.append', scope: options.scope, event }));
    }
      await reconcileRows();
    });
  }, options.activityPollMs ?? 500);
  const stopActivity = () => clearInterval(activityTimer);
  options.signal.addEventListener('abort', stopActivity, { once: true });
  try {
    await watchLocalSessions({ scope: options.scope, signal: options.signal, emit: (event) => {
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
  const projection = new FeedSessionProjection(coordinator);
  const forward = (event: FeedWatchEnvelope) => {
    for (const projected of projection.apply(event)) options.emit(projected);
  };
  const local = watchLocalFeed({ scope: machineId(), signal: options.signal, emit: forward });
  let devices: Awaited<ReturnType<typeof loadDevices>>;
  try { devices = await loadDevices(); } catch { await local; return; }
  const self = machineId();
  const peers = Object.values(devices).filter((device) => isDialableDevice(device) && normalizeHost(device.name) !== self && ['windows', 'linux', 'macos'].includes(device.platform));
  const tasks = peers.map(async (device) => {
    const scope = normalizeHost(device.name);
    while (!options.signal.aborted) {
      let target: string;
      try { target = sshTargetFor(device); } catch (error) {
        options.emit(coordinator.emit({ type: 'scope', capturedAt: Date.now(), scope, status: 'unavailable', reason: String(error) })); break;
      }
      const child = spawn('ssh', [...SSH_OPTS, ...controlOpts(), ...deviceIdentityArgs(device), target, remoteFeedWatchCommand(device.platform)], { stdio: ['ignore', 'pipe', 'ignore'] });
      const stop = () => child.kill('SIGTERM');
      options.signal.addEventListener('abort', stop, { once: true });
      const reader = createInterface({ input: child.stdout! });
      reader.on('line', (line) => { try { const event = JSON.parse(line) as FeedWatchEnvelope; if (event.v === 1) forward(event); } catch { /* protocol only */ } });
      const code = await new Promise<number | null>((resolve) => { child.once('error', () => resolve(null)); child.once('close', resolve); });
      reader.close(); options.signal.removeEventListener('abort', stop);
      if (options.signal.aborted) break;
      options.emit(coordinator.emit({ type: 'scope', capturedAt: Date.now(), scope, status: 'unavailable', reason: code == null ? 'ssh failed' : `ssh exited ${code}` }));
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, options.reconnectMs ?? 2_000); options.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    }
  });
  await Promise.all([local, ...tasks]);
}
