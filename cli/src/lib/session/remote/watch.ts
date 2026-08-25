import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadDevices, isDialableDevice } from '../../devices/registry.js';
import { deviceIdentityArgs, sshTargetFor } from '../../devices/connect.js';
import { machineId, normalizeHost } from '../../machine-id.js';
import { SSH_OPTS, controlOpts, shellQuote } from '../../ssh-exec.js';
import { buildWindowsAgentsCommand, remoteShellFor } from '../../hosts/remote-cmd.js';
import { isReapableOrphan, type ActiveSession } from '../active.js';
import {
  activeSessionsJournalPath,
  activeSessionJournalIdentity,
  readActiveSessionsCache,
  noteActiveSessionsJournalReader,
  type ActiveSessionsJournalRecord,
} from '../session-cache.js';

export const SESSION_WATCH_VERSION = 1 as const;
export const SESSION_WATCH_HEARTBEAT_MS = 15_000;

export type SessionWatchScopeStatus = 'available' | 'unavailable';

export type SessionWatchEnvelope =
  | { version: 1; type: 'reset'; streamId: string; sequence: number; capturedAt: number; scope: string; rows: SessionWatchRow[] }
  | { version: 1; type: 'upsert'; streamId: string; sequence: number; capturedAt: number; scope: string; rowKey: string; row: SessionWatchRow }
  | { version: 1; type: 'remove'; streamId: string; sequence: number; capturedAt: number; scope: string; rowKey: string }
  | { version: 1; type: 'scope'; streamId: string; sequence: number; capturedAt: number; scope: string; status: SessionWatchScopeStatus; reason?: string }
  | { version: 1; type: 'heartbeat'; streamId: string; sequence: number; scope: string; capturedAt: number };

export interface SessionWatchRow extends Omit<ActiveSession, 'viewingIn'> {
  rowKey: string;
  sourceDevice: string;
  resumable: boolean;
  unwatched: boolean;
  viewingIn: string | null;
  recovery: { command: 'agents'; args: string[]; cwd?: string } | null;
}

/** Stable, opaque identity for one row within one device scope. */
export function sessionWatchRowKey(scope: string, row: ActiveSession): string {
  const identity = activeSessionJournalIdentity(row);
  return createHash('sha256').update(`${scope}\0${identity}`).digest('base64url').slice(0, 22);
}

export function toSessionWatchRow(scope: string, row: ActiveSession): SessionWatchRow {
  const rowKey = sessionWatchRowKey(scope, row);
  // A dead, days-stale crash-orphan is folded OUT of the reconnectable set — it
  // is not resumable, so the "Needs reconnecting" list stops ballooning with
  // leaked --device tunnel sessions (RUSH-3011 / issue #3b). A live or
  // recently-exited session stays resumable.
  const resumable = Boolean(row.sessionId) && !isReapableOrphan(row);
  const viewingIn = row.viewingIn
    ? [row.viewingIn.app, row.viewingIn.tab ? `tab ${row.viewingIn.tab}` : undefined].filter(Boolean).join(' ')
    : null;
  return {
    ...row,
    rowKey,
    sourceDevice: scope,
    resumable,
    unwatched: !viewingIn,
    viewingIn,
    recovery: resumable
      ? { command: 'agents', args: ['sessions', 'resume', row.sessionId!, '--device', scope], ...(row.cwd ? { cwd: row.cwd } : {}) }
      : null,
  };
}

function sameRow(a: SessionWatchRow, b: SessionWatchRow): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Stream-local sequencer and convergent row diff. */
export class SessionWatchState {
  readonly streamId: string;
  private sequence = 0;
  private readonly rows = new Map<string, Map<string, SessionWatchRow>>();

  constructor(streamId: string = randomUUID()) { this.streamId = streamId; }

  private base<T extends SessionWatchEnvelope['type']>(type: T): { version: 1; type: T; streamId: string; sequence: number; capturedAt: number } {
    return { version: SESSION_WATCH_VERSION, type, streamId: this.streamId, sequence: ++this.sequence, capturedAt: Date.now() };
  }

  reset(scope: string, sourceRows: ActiveSession[]): SessionWatchEnvelope {
    const rows = sourceRows.map((row) => toSessionWatchRow(scope, row));
    this.rows.set(scope, new Map(rows.map((row) => [row.rowKey, row])));
    return { ...this.base('reset'), scope, rows };
  }

  update(scope: string, sourceRows: ActiveSession[]): SessionWatchEnvelope[] {
    const previous = this.rows.get(scope) ?? new Map<string, SessionWatchRow>();
    const nextRows = sourceRows.map((row) => toSessionWatchRow(scope, row));
    const next = new Map(nextRows.map((row) => [row.rowKey, row]));
    const events: SessionWatchEnvelope[] = [];
    for (const [rowKey, row] of next) {
      if (!previous.has(rowKey) || !sameRow(previous.get(rowKey)!, row)) {
        events.push({ ...this.base('upsert'), scope, rowKey, row });
      }
    }
    for (const rowKey of previous.keys()) {
      if (!next.has(rowKey)) events.push({ ...this.base('remove'), scope, rowKey });
    }
    this.rows.set(scope, next);
    return events;
  }

  patch(scope: string, upserts: ActiveSession[], removes: string[]): SessionWatchEnvelope[] {
    const current = new Map(this.rows.get(scope) ?? []);
    const events: SessionWatchEnvelope[] = [];
    for (const source of upserts) {
      const row = toSessionWatchRow(scope, source);
      if (!current.has(row.rowKey) || !sameRow(current.get(row.rowKey)!, row)) {
        current.set(row.rowKey, row);
        events.push({ ...this.base('upsert'), scope, rowKey: row.rowKey, row });
      }
    }
    for (const identity of removes) {
      const rowKey = createHash('sha256').update(`${scope}\0${identity}`).digest('base64url').slice(0, 22);
      if (current.delete(rowKey)) events.push({ ...this.base('remove'), scope, rowKey });
    }
    this.rows.set(scope, current);
    return events;
  }

  scope(scope: string, status: SessionWatchScopeStatus, reason?: string): SessionWatchEnvelope {
    // Deliberately retain rows while unavailable. A reconnecting scope replaces
    // them with a reset; transient fleet loss must not look like session death.
    return { ...this.base('scope'), scope, status, ...(reason ? { reason } : {}) };
  }

  heartbeat(scope: string, capturedAt: number = Date.now()): SessionWatchEnvelope {
    return { ...this.base('heartbeat'), scope, capturedAt };
  }
}

export interface WatchLocalOptions {
  scope: string;
  signal: AbortSignal;
  emit: (event: SessionWatchEnvelope) => void;
  refreshMs?: number;
  heartbeatMs?: number;
  readCache?: typeof readActiveSessionsCache;
  journalPath?: string;
  journalPollMs?: number;
}

/**
 * Keep one local subscription alive. Startup reads one canonical reset snapshot;
 * steady state tails the canonical writer journal and never invokes a gather.
 */
export async function watchLocalSessions(options: WatchLocalOptions): Promise<void> {
  const state = new SessionWatchState();
  const readCache = options.readCache ?? readActiveSessionsCache;
  const journal = options.journalPath ?? activeSessionsJournalPath();
  const heartbeatMs = options.heartbeatMs ?? SESSION_WATCH_HEARTBEAT_MS;
  let offset = 0;
  try { offset = fs.statSync(journal).size; } catch { /* first publication */ }
  const initial = readCache('local');
  options.emit(state.reset(options.scope, initial?.sessions ?? []));
  // Known gap (out of scope for RUSH-2484): a present cache alone marks
  // 'available' with no staleness/age check, so a reconnect can briefly render
  // a stale snapshot as live before the out-of-band gather this file triggers
  // (see watchActiveSessionsReaderPresence in session-cache.ts) replaces it.
  options.emit(state.scope(options.scope, initial ? 'available' : 'unavailable', initial ? undefined : 'awaiting publisher'));
  if (options.signal.aborted) return;
  // Signal the daemon that a consumer is live so it does not skip the gather.
  noteActiveSessionsJournalReader();
  await new Promise<void>((resolve) => {
    let partial = '';
    let reading = false;
    const readAppended = () => {
      if (reading || options.signal.aborted) return;
      reading = true;
      try {
        const size = fs.statSync(journal).size;
        if (size < offset) { offset = 0; partial = ''; }
        if (size === offset) return;
        const fd = fs.openSync(journal, 'r');
        try {
          const buffer = Buffer.alloc(size - offset);
          fs.readSync(fd, buffer, 0, buffer.length, offset);
          offset = size;
          const lines = (partial + buffer.toString('utf8')).split('\n');
          partial = lines.pop() ?? '';
          for (const line of lines) {
            if (!line) continue;
            try {
              const record = JSON.parse(line) as ActiveSessionsJournalRecord;
              if (record.version !== 1 || record.scope !== 'local' || !Array.isArray(record.upserts) || !Array.isArray(record.removes)) continue;
              for (const event of state.patch(options.scope, record.upserts, record.removes)) options.emit(event);
              options.emit(state.scope(options.scope, 'available'));
            } catch { /* partial/corrupt journal lines are not state */ }
          }
        } finally { fs.closeSync(fd); }
      } catch { /* journal may not exist until the first publisher write */ }
      finally { reading = false; }
    };
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    const journalListener = () => readAppended();
    fs.watchFile(journal, { interval: options.journalPollMs ?? 250 }, journalListener);
    const heartbeatTimer = setInterval(() => {
      noteActiveSessionsJournalReader();
      options.emit(state.heartbeat(options.scope));
    }, heartbeatMs);
    const stop = () => { fs.unwatchFile(journal, journalListener); clearInterval(heartbeatTimer); resolve(); };
    options.signal.addEventListener('abort', stop, { once: true });
    // Close the offset/read/watch handoff: a publisher may append after the
    // startup offset is captured but before watchFile is registered.
    readAppended();
  });
}

export interface WatchFleetOptions {
  signal: AbortSignal;
  emit: (event: SessionWatchEnvelope) => void;
  reconnectMs?: number;
}

function remoteWatchCommand(os: string): string {
  const args = ['sessions', 'watch', '--json', '--local'];
  return remoteShellFor(os) === 'powershell'
    ? buildWindowsAgentsCommand({ args })
    : `bash -lc ${shellQuote(`agents ${args.map(shellQuote).join(' ')}`)}`;
}

/**
 * Subscribe to every dialable compute device with one persistent SSH process.
 * A peer disconnect emits `scope: unavailable` but no removes; reconnecting
 * peer resets only its own scope. There is no recurring fleet list command.
 */
export async function watchFleetSessions(options: WatchFleetOptions): Promise<void> {
  const local = watchLocalSessions({ scope: machineId(), signal: options.signal, emit: options.emit });
  let devices: Awaited<ReturnType<typeof loadDevices>>;
  try { devices = await loadDevices(); }
  catch { await local; return; }
  const self = machineId();
  const peers = Object.values(devices).filter((device) =>
    isDialableDevice(device)
    && normalizeHost(device.name) !== self
    && ['windows', 'linux', 'macos'].includes(device.platform),
  );
  const reconnectMs = options.reconnectMs ?? 2_000;
  const peerTasks = peers.map(async (device) => {
    const scope = normalizeHost(device.name);
    const state = new SessionWatchState();
    while (!options.signal.aborted) {
      let target: string;
      try { target = sshTargetFor(device); }
      catch (error) {
        options.emit(state.scope(scope, 'unavailable', error instanceof Error ? error.message : String(error)));
        break;
      }
      const child = spawn('ssh', [
        ...SSH_OPTS, ...controlOpts(), ...deviceIdentityArgs(device), target, remoteWatchCommand(device.platform),
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      const stop = () => child.kill('SIGTERM');
      options.signal.addEventListener('abort', stop, { once: true });
      const reader = createInterface({ input: child.stdout! });
      reader.on('line', (line) => {
        try {
          const event = JSON.parse(line) as SessionWatchEnvelope;
          if (event.version === SESSION_WATCH_VERSION && typeof event.sequence === 'number') options.emit(event);
        } catch { /* incomplete/non-protocol peer output is not state */ }
      });
      const code = await new Promise<number | null>((resolve) => {
        child.once('error', () => resolve(null));
        child.once('close', resolve);
      });
      reader.close();
      options.signal.removeEventListener('abort', stop);
      if (options.signal.aborted) break;
      options.emit(state.scope(scope, 'unavailable', code === null ? 'ssh failed' : `ssh exited ${code}`));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, reconnectMs);
        options.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  });
  await Promise.all([local, ...peerTasks]);
}
