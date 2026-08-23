import type { SessionCliFactPayload } from '../monitor/protocol';
import { normalizeActiveSession, normalizeHost, resolveSessionHost, type RawActiveSession, type RemoteSession } from './remoteSessions';
import type { ProjectRule } from './settings';

/** Window-local projection of the canonical CLI stream; contains no lifecycle logic. */
export class SessionPresentationStore {
  private rows = new Map<string, unknown>();
  private attention = new Map<string, unknown>();
  private attentionScopes = new Map<string, string>();
  private activity: unknown[] = [];
  private sequences = new Map<string, number>();
  private scopes = new Map<string, { status: 'available' | 'unavailable'; reason?: string }>();

  apply(event: SessionCliFactPayload): boolean {
    const previous = this.sequences.get(event.streamId) ?? 0;
    if (event.sequence <= previous) return false;
    this.sequences.set(event.streamId, event.sequence);
    if (event.type === 'reset') {
      for (const [rowKey, value] of this.rows) {
        if (this.scopeOf(value) === event.scope) this.rows.delete(rowKey);
      }
      for (const row of event.agents ?? []) {
        const rowKey = this.rowKeyOf(row);
        if (rowKey) this.rows.set(rowKey, row);
      }
      for (const [key, scope] of this.attentionScopes) {
        if (scope === event.scope) {
          this.attention.delete(key);
          this.attentionScopes.delete(key);
        }
      }
      for (const item of Array.isArray(event.attention) ? event.attention : []) {
        const key = this.attentionKeyOf(item);
        if (key) {
          this.attention.set(key, item);
          this.attentionScopes.set(key, event.scope);
        }
      }
    } else if (event.type === 'agent.upsert') {
      const rowKey = event.rowKey || this.rowKeyOf(event.agent);
      if (rowKey && event.agent) this.rows.set(rowKey, event.agent);
    } else if (event.type === 'attention.upsert' && event.attention && !Array.isArray(event.attention)) {
      const key = event.rowKey || this.attentionKeyOf(event.attention);
      if (key) {
        this.attention.set(key, event.attention);
        this.attentionScopes.set(key, event.scope);
      }
    } else if (event.type === 'attention.remove' && event.rowKey) {
      const previous = this.attention.get(event.rowKey);
      if (previous && typeof previous === 'object') {
        const resolution = event.resolution && typeof event.resolution === 'object' ? event.resolution as { state?: unknown } : {};
        this.attention.set(event.rowKey, { ...previous, state: typeof resolution.state === 'string' ? resolution.state : 'resolved' });
      }
      if (event.resolution) {
        const attention = previous && typeof previous === 'object' ? previous as Record<string, unknown> : {};
        const resolution = event.resolution as Record<string, unknown>;
        this.activity.push({
          type: 'attention.receipt',
          key: event.rowKey,
          sessionId: attention.sessionId,
          question: attention.question,
          source: attention.source,
          fingerprint: attention.fingerprint,
          state: typeof resolution.state === 'string' ? resolution.state : 'resolved',
          resolvedAt: resolution.resolvedAt ?? event.capturedAt,
          resolution,
        });
      }
    } else if (event.type === 'activity.append' && event.event) {
      this.activity.push(event.event);
    } else if (event.type === 'scope' && event.status) {
      this.scopes.set(event.scope, { status: event.status, ...(event.reason ? { reason: event.reason } : {}) });
    }
    return true;
  }

  sessions(): unknown[] {
    const projected = [...this.attention.values()];
    return [...this.rows.values()].map((value) => {
      if (!value || typeof value !== 'object') return value;
      const row = value as { sessionId?: unknown; id?: unknown };
      const sessionId = typeof row.sessionId === 'string' ? row.sessionId : typeof row.id === 'string' ? row.id : '';
      const attention = projected.find((item) => item && typeof item === 'object'
        && (item as { sessionId?: unknown }).sessionId === sessionId);
      return attention ? { ...row, attention } : row;
    });
  }
  activityEvents(): unknown[] { return [...this.activity]; }
  scope(scope: string): { status: 'available' | 'unavailable'; reason?: string } | undefined {
    return this.scopes.get(scope);
  }
  clear(): void { this.rows.clear(); this.attention.clear(); this.attentionScopes.clear(); this.activity = []; this.sequences.clear(); this.scopes.clear(); }

  /** Normalize the CLI stream rows for UI rendering without starting another query. */
  presentedSessions(
    localMachineId: string,
    localLabel: string,
    projectRules: ProjectRule[] = [],
    fetchedAt: number = Date.now(),
  ): RemoteSession[] {
    return this.sessions().flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const row = value as RawActiveSession & { agentType?: string; host?: string; sourceDevice?: string };
      const raw = {
        ...row,
        kind: row.kind || row.agentType || '',
      } as RawActiveSession;
      // The CLI row's `host` is the terminal APP hosting the session (codium,
      // iterm, tmux, ...), never a machine. `machine` is set only for offloaded
      // sessions; a local row's device identity rides in `sourceDevice`. Using
      // `host` here made a detached session (whose only terminal is the bare
      // tmux server) present as living on a machine called "tmux", which broke
      // every host === local filter (RUSH-2670).
      const machine = typeof raw.machine === 'string' ? raw.machine
        : typeof row.sourceDevice === 'string' ? row.sourceDevice
        : undefined;
      const host = resolveSessionHost(machine, localLabel, normalizeHost(localMachineId), localLabel);
      return [normalizeActiveSession(raw, host, fetchedAt, projectRules)];
    });
  }

  /** Session identity join used by terminal hydration and fork bookkeeping. */
  terminalSessionMap(host?: string): Map<string, string> {
    const wanted = normalizeHost(host || '');
    const result = new Map<string, string>();
    for (const value of this.sessions()) {
      if (!value || typeof value !== 'object') continue;
      const row = value as { terminalId?: unknown; sessionId?: unknown; id?: unknown; machine?: unknown; sourceDevice?: unknown };
      const terminalId = typeof row.terminalId === 'string' ? row.terminalId : '';
      const sessionId = typeof row.sessionId === 'string' ? row.sessionId : typeof row.id === 'string' ? row.id : '';
      const machine = normalizeHost(typeof row.machine === 'string' ? row.machine : typeof row.sourceDevice === 'string' ? row.sourceDevice : '');
      if (wanted && machine && wanted !== machine) continue;
      if (terminalId && sessionId) result.set(terminalId, sessionId);
    }
    return result;
  }

  /**
   * Live stream row for one session id — machine + topic + label, no extra
   * CLI subprocess. `--device auto` tabs never learn their host at launch;
   * this is how they recover it (and a title) once the watch stream indexes
   * the session.
   */
  liveSession(sessionId: string): { machine: string; topic: string; label: string; cwd: string } | undefined {
    const wanted = sessionId.trim();
    if (!wanted) return undefined;
    for (const value of this.sessions()) {
      if (!value || typeof value !== 'object') continue;
      const row = value as {
        sessionId?: unknown;
        id?: unknown;
        machine?: unknown;
        sourceDevice?: unknown;
        topic?: unknown;
        prompt?: unknown;
        firstUserMessage?: unknown;
        label?: unknown;
        cwd?: unknown;
      };
      const id = typeof row.sessionId === 'string' ? row.sessionId
        : typeof row.id === 'string' ? row.id : '';
      if (id !== wanted) continue;
      const machine = typeof row.machine === 'string' ? row.machine
        : typeof row.sourceDevice === 'string' ? row.sourceDevice
        : '';
      const topic = typeof row.topic === 'string' ? row.topic
        : typeof row.prompt === 'string' ? row.prompt
        : typeof row.firstUserMessage === 'string' ? row.firstUserMessage
        : '';
      const label = typeof row.label === 'string' ? row.label : '';
      const cwd = typeof row.cwd === 'string' ? row.cwd : '';
      return { machine, topic, label, cwd };
    }
    return undefined;
  }

  private rowKeyOf(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const rowKey = (value as { rowKey?: unknown }).rowKey;
    return typeof rowKey === 'string' && rowKey ? rowKey : undefined;
  }

  private attentionKeyOf(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const key = (value as { key?: unknown }).key;
    return typeof key === 'string' && key ? key : undefined;
  }

  private scopeOf(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const scope = (value as { sourceDevice?: unknown }).sourceDevice;
    return typeof scope === 'string' ? scope : undefined;
  }
}

/** Exactly one presentation store per extension host process. */
export const sessionPresentationStore = new SessionPresentationStore();
