/**
 * Per-subsystem health record for the always-on daemon.
 *
 * Today a subsystem failure inside `runDaemon()` (daemon.ts) is a single
 * `log('ERROR', ...)` line that scrolls out of the log file and is never
 * surfaced anywhere else — `agents daemon status` has no way to answer "is the
 * secrets broker actually healthy right now?" beyond "the daemon process is
 * alive". This module gives every subsystem a small persisted record —
 * {@link SubsystemHealth} — so `agents daemon status` / `agents daemon
 * services` can report health, not just liveness (RUSH-2354).
 *
 * Scheduled routines get this for free once migrated onto `agents routines`
 * (their run history already carries success/failure — `agents routines
 * stats`). This module exists for the two subsystems that predate routines
 * and have no run history of their own: the secrets broker and the browser
 * IPC server.
 *
 * File-backed (one JSON object keyed by subsystem name) rather than in-memory
 * because `agents daemon status` runs as a SEPARATE process from the daemon —
 * it must read what the daemon last recorded, not maintain its own state.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getDaemonDir } from './state.js';

const HEALTH_FILE = 'health.json';

/** Stable subsystem identifiers shared by the daemon (writer) and `agents daemon` (reader). */
export const SUBSYSTEM_SECRETS_BROKER = 'secrets-broker';
export const SUBSYSTEM_BROWSER_IPC = 'browser-ipc';
/**
 * Daemon startup itself (RUSH-2418). Unlike the two above, this record is
 * written from BOTH sides: the launching CLI records a start that produced no
 * live daemon, and the daemon records its own successful claim. Its
 * `consecutiveFailures` is what `ensureDaemonStarted` reads to open the
 * auto-start circuit breaker, so a daemon dying on boot stops being relaunched
 * by every foreground command that happens to want one.
 */
export const SUBSYSTEM_DAEMON_START = 'daemon-start';

/** One subsystem's health as of the last time it reported in. */
export interface SubsystemHealth {
  /** Stable identifier, e.g. 'secrets-broker', 'browser-ipc'. */
  subsystem: string;
  /** Most recent error message, or null if it has never failed. */
  lastError: string | null;
  /** ISO timestamp of the most recent error, or null. */
  lastErrorAt: string | null;
  /** Consecutive failures since the last success (0 when currently healthy). */
  consecutiveFailures: number;
  /** ISO timestamp of the most recent success, or null if it has never succeeded. */
  lastOkAt: string | null;
}

function getHealthPath(): string {
  return path.join(getDaemonDir(), HEALTH_FILE);
}

function readAll(): Record<string, SubsystemHealth> {
  try {
    const raw = fs.readFileSync(getHealthPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, SubsystemHealth>;
    }
    return {};
  } catch {
    return {};
  }
}

function writeAll(records: Record<string, SubsystemHealth>): void {
  const healthPath = getHealthPath();
  fs.mkdirSync(path.dirname(healthPath), { recursive: true });
  fs.writeFileSync(healthPath, JSON.stringify(records), 'utf-8');
  try { fs.chmodSync(healthPath, 0o600); } catch { /* best effort */ }
}

function blankRecord(subsystem: string): SubsystemHealth {
  return { subsystem, lastError: null, lastErrorAt: null, consecutiveFailures: 0, lastOkAt: null };
}

/** Record a successful subsystem check-in — clears the failure streak. */
export function recordSubsystemOk(subsystem: string, at: string = new Date().toISOString()): void {
  const all = readAll();
  const existing = all[subsystem] ?? blankRecord(subsystem);
  all[subsystem] = { ...existing, subsystem, consecutiveFailures: 0, lastOkAt: at };
  writeAll(all);
}

/** Record a subsystem failure — bumps the consecutive-failure streak. */
export function recordSubsystemError(subsystem: string, error: string, at: string = new Date().toISOString()): void {
  const all = readAll();
  const existing = all[subsystem] ?? blankRecord(subsystem);
  all[subsystem] = {
    ...existing,
    subsystem,
    lastError: error,
    lastErrorAt: at,
    consecutiveFailures: existing.consecutiveFailures + 1,
  };
  writeAll(all);
}

/** Read one subsystem's health record, or null if it has never reported in. */
export function readSubsystemHealth(subsystem: string): SubsystemHealth | null {
  return readAll()[subsystem] ?? null;
}

/** Read every subsystem's health record, sorted by subsystem name. */
export function readAllSubsystemHealth(): SubsystemHealth[] {
  return Object.values(readAll()).sort((a, b) => a.subsystem.localeCompare(b.subsystem));
}
