import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { EditorTerminal } from './terminals.vscode';
import { formatEvent, trimToLast, WatchdogEvent, WATCHDOG_LOG_PATH } from '../core/watchdogLog';
import { classifyTailForRotate } from '../core/autoRotate';

// This module is the extension's auto-rotate loop. It is NOT a nudger:
// autonomous stall detection and nudge injection were retired — the CLI daemon
// watchdog is the sole injector now and writes the SAME `WatchdogEvent` JSONL
// feed (core/watchdogLog.ts) the Factory Floor status card reads. The extension
// keeps ONE capability the CLI lacks: when a terminal's account is exhausted it
// rotates the session into a fresh terminal via `agents run auto` — the CLI
// owns host affinity, harness headroom, and account balance — and records a
// `rotate` event to that shared log.
//
// Loop suppression (RUSH-2132): the rotate DECIDES from the terminal's tail
// (agent-reported rate-limit text, or the CLI's fail-loud `no healthy … resets
// <time>` error). A `no healthy` verdict — from a tail or reported by the
// rotate path itself (recordNoHealthyRotateFailure) — suppresses ALL rotation
// on that host until the parsed reset: the tick keeps evaluating but never
// spawns, and logs ONE skip event per suppression window. The old per-tick
// `agents view --json` probe is gone — it only fed the deleted picker and was
// the source of the repeated macOS Keychain prompts during the 2026-08-03
// incident.

const LOG_MAX_LINES = 500;

// How many transcript tail lines the rotate decision scans per tick.
const ROTATE_TAIL_LINES = 40;

// User-editable playbook file. It used to hold house rules the (now-retired)
// nudge decision appended to its prompt; the CLI daemon watchdog owns nudging
// now, so this file no longer drives any in-extension behavior. The scaffold +
// status helpers stay because the Factory Floor settings panel still surfaces
// the file for editing.
export const WATCHDOG_PLAYBOOK_PATH = path.join(
  os.homedir(),
  '.agents',
  'playbooks',
  'watchdog.md'
);

const WATCHDOG_PLAYBOOK_TEMPLATE = `# Watchdog Playbook

House rules for the Watchdog. Add patterns you've observed. One rule per bullet.
Be specific.

## Nudge recipes

- When the agent says "I'll write/create/run X" with no matching tool call
  in the next 30 seconds, nudge: "Do it now."

## Skip rules

- Skip if the last assistant message ends with a question mark — user input expected.

## Project-specific

- (Add rules tied to your repos here.)
`;

export function ensureWatchdogPlaybookScaffold(): void {
  if (fsSync.existsSync(WATCHDOG_PLAYBOOK_PATH)) return;
  fsSync.mkdirSync(path.dirname(WATCHDOG_PLAYBOOK_PATH), { recursive: true });
  fsSync.writeFileSync(WATCHDOG_PLAYBOOK_PATH, WATCHDOG_PLAYBOOK_TEMPLATE, 'utf8');
}

export interface WatchdogPlaybookStatus {
  exists: boolean;
  lines: number;
  mtimeMs: number;
}

export function getWatchdogPlaybookStatus(): WatchdogPlaybookStatus {
  try {
    const stat = fsSync.statSync(WATCHDOG_PLAYBOOK_PATH);
    const content = fsSync.readFileSync(WATCHDOG_PLAYBOOK_PATH, 'utf8');
    return {
      exists: true,
      lines: content.split('\n').filter((l) => l.trim().length > 0).length,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return { exists: false, lines: 0, mtimeMs: 0 };
  }
}

// Hot path: append is O(1) (no read+rewrite of the whole file). The file is
// trimmed back to LOG_MAX_LINES only once every LOG_TRIM_EVERY appends, so a
// burst of rotations doesn't rewrite the file each time. Between trims the file
// may briefly exceed the cap by up to that many lines — acceptable for a
// diagnostic feed.
const LOG_TRIM_EVERY = 100;
let appendCount = 0;

// Tests point the writer at a temp file; production always uses the shared
// WATCHDOG_LOG_PATH feed the CLI daemon watchdog writes too.
let logPathOverride: string | null = null;
export function __setWatchdogLogPathForTests(p: string | null): void {
  logPathOverride = p;
}
function activeLogPath(): string {
  return logPathOverride ?? WATCHDOG_LOG_PATH;
}

async function trimLogToCap(logPath: string, maxLines: number): Promise<void> {
  try {
    const existing = await fs.readFile(logPath, 'utf8');
    const trimmed = trimToLast(existing, maxLines);
    if (trimmed.length !== existing.length) {
      await fs.writeFile(logPath, trimmed, 'utf8');
    }
  } catch {
    // file missing or unreadable — nothing to trim
  }
}

async function appendToLog(ev: WatchdogEvent): Promise<void> {
  const logPath = activeLogPath();
  try {
    const line = formatEvent(ev) + '\n';
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, line, 'utf8');
    if (++appendCount % LOG_TRIM_EVERY === 0) {
      await trimLogToCap(logPath, LOG_MAX_LINES);
    }
  } catch (err) {
    console.warn('[WATCHDOG] log write failed:', err);
  }
}

export type WatchdogRotateOutcome =
  | { status: 'no_session' }
  | { status: 'unsupported_agent' }
  | { status: 'no_healthy_account'; agentKey?: string }
  | { status: 'rotated'; newSessionId: string };

export interface WatchdogDeps {
  rotateTerminal: (entry: EditorTerminal) => Promise<WatchdogRotateOutcome>;
  /**
   * Tail text the rotate decision scans. Defaults to the session transcript
   * tail (ROTATE_TAIL_LINES lines); injected by tests.
   */
  readTail?: (entry: EditorTerminal) => Promise<string>;
  /** Tracked terminal listing; defaults to the live registry. */
  listTerminals?: () => EditorTerminal[];
}

interface WatchdogConfig {
  enabled: boolean;
  autoRotate: boolean;
  rotateCooldownMs: number;
  tickMs: number;
}

function readConfig(): WatchdogConfig {
  const cfg = vscode.workspace.getConfiguration('agents.watchdog');
  return {
    enabled: cfg.get<boolean>('enabled', true),
    autoRotate: cfg.get<boolean>('autoRotate', true),
    rotateCooldownMs: cfg.get<number>('rotateCooldownSeconds', 120) * 1000,
    tickMs: cfg.get<number>('tickSeconds', 120) * 1000,
  };
}

// --- No-healthy suppression -------------------------------------------------
//
// When `agents run auto` reports zero healthy accounts on a machine, EVERY
// rotate there fails the same way until the earliest window resets — so the
// suppression is keyed by host (the local machine is 'local'), not by
// terminal. The tick keeps evaluating but never spawns while suppressed.

const LOCAL_HOST_KEY = 'local';
const hostKey = (host?: string): string => host ?? LOCAL_HOST_KEY;

/** host key -> suppress rotations on that host until this epoch ms. */
const noHealthyUntilMs = new Map<string, number>();
/** host key -> the suppression horizon we already logged a skip event for. */
const noHealthySkipLoggedUntilMs = new Map<string, number>();

/**
 * Record a failed rotate whose `agents run auto` exited with the fail-loud
 * `no healthy` error. Called by the rotate path in extension.ts (which reads
 * the launch's output stream) — the one place the CLI's stderr is observable,
 * since pty scrollback is not readable from an extension. Also reachable from
 * the tick when the error text shows up in a tail.
 */
export function recordNoHealthyRotateFailure(
  host: string | undefined,
  untilMs: number | undefined,
  detail?: string,
): void {
  const now = Date.now();
  const until = untilMs && untilMs > now ? untilMs : now + readConfig().rotateCooldownMs;
  noHealthyUntilMs.set(hostKey(host), until);
  void logNoHealthySkipOnce(host, until, detail);
}

/** ONE skip event per host per suppression window — never per tick. */
async function logNoHealthySkipOnce(
  host: string | undefined,
  untilMs: number,
  detail?: string,
): Promise<void> {
  const key = hostKey(host);
  if ((noHealthySkipLoggedUntilMs.get(key) ?? 0) >= untilMs) return;
  noHealthySkipLoggedUntilMs.set(key, untilMs);
  await appendToLog({
    ts: Date.now(),
    kind: 'rotate',
    message: `skip — no healthy account to rotate into${host ? ` on ${host}` : ''}`,
    reason: detail ?? `no healthy account — skipping until reset ${new Date(untilMs).toISOString()}`,
  });
}

/** Test hook: clear suppression + skip-log state between cases. */
export function __clearNoHealthyStateForTests(): void {
  noHealthyUntilMs.clear();
  noHealthySkipLoggedUntilMs.clear();
}

// Session transcript tail: the agent's own limit message ("You've hit your
// weekly limit …") lands in the jsonl the session already writes — no probing,
// no Keychain prompts. A terminal with no resolvable transcript simply isn't
// judged this tick. Lazy-imported so this module stays loadable in tests with
// only the vscode mock.
async function defaultReadTail(entry: EditorTerminal): Promise<string> {
  if (!entry.sessionId || !entry.agentType) return '';
  try {
    const sessions = await import('./sessions.vscode');
    const sessionPath = await sessions.getSessionPathBySessionId(
      entry.sessionId,
      entry.agentType as Parameters<typeof sessions.getSessionPathBySessionId>[1],
    );
    if (!sessionPath) return '';
    const lines = await sessions.readTailLines(sessionPath, ROTATE_TAIL_LINES);
    return lines.join('\n');
  } catch {
    return '';
  }
}

async function listTerminalsDefault(): Promise<EditorTerminal[]> {
  const mod = await import('./terminals.vscode');
  return mod.getAllTerminals();
}

let tickInFlight = false;
// Idle-window gating: when the IDE window has been unfocused for this long,
// skip ticks. Auto-rotate spawns a fresh terminal — not useful when the user
// isn't watching.
const WATCHDOG_IDLE_SKIP_MS = 5 * 60_000;
let lastFocusedAtMs = Date.now();

export async function tick(
  lastRotateMs: Map<string, number>,
  deps: WatchdogDeps
): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const cfg = readConfig();
    if (!cfg.enabled || !cfg.autoRotate) return;

    const tracked = deps.listTerminals ? deps.listTerminals() : await listTerminalsDefault();
    const sessions = tracked.filter((e) => !!e.sessionId && !!e.agentType);
    if (sessions.length === 0) return;

    // Skip when the window has been unfocused long enough that the user is
    // clearly elsewhere. `vscode.window.state.focused` is a live snapshot; we
    // keep our own freshness clock so we don't hammer when the user hasn't
    // touched the window in minutes.
    if (vscode.window.state.focused) lastFocusedAtMs = Date.now();
    if (Date.now() - lastFocusedAtMs >= WATCHDOG_IDLE_SKIP_MS) return;

    const now = Date.now();
    const readTail = deps.readTail ?? defaultReadTail;

    for (const entry of sessions) {
      if (!entry.sessionId || !entry.agentType) continue;

      // Host-level suppression: a previous `no healthy` (from a tail or from
      // the rotate path) holds until the reset — evaluate but never spawn.
      const suppressedUntil = noHealthyUntilMs.get(hostKey(entry.host)) ?? 0;
      if (suppressedUntil > now) {
        await logNoHealthySkipOnce(entry.host, suppressedUntil);
        continue;
      }

      const lastRotate = lastRotateMs.get(entry.id) ?? 0;
      if (now - lastRotate < cfg.rotateCooldownMs) continue;

      const tail = await readTail(entry);
      if (!tail) continue;
      const verdict = classifyTailForRotate(tail, now);

      if (verdict.kind === 'no_healthy_account') {
        // The CLI already told us nothing on this machine can take the
        // session — suppress every rotate here until the window resets.
        const until = verdict.resetsAtMs && verdict.resetsAtMs > now
          ? verdict.resetsAtMs
          : now + cfg.rotateCooldownMs;
        noHealthyUntilMs.set(hostKey(entry.host), until);
        console.log(
          `[WATCHDOG] ${entry.id}${entry.host ? ` on ${entry.host}` : ''}: no healthy account — suppressing rotation until ${new Date(until).toISOString()}`
        );
        await logNoHealthySkipOnce(entry.host, until);
        continue;
      }

      if (verdict.kind !== 'rate_limited') continue;

      console.log(
        `[WATCHDOG] auto-rotate triggered for ${entry.id}${entry.host ? ` on ${entry.host}` : ''} — tail shows an exhausted account`
      );
      lastRotateMs.set(entry.id, now);
      try {
        const outcome = await deps.rotateTerminal(entry);
        if (outcome.status === 'rotated') {
          vscode.window.setStatusBarMessage(
            `Auto-rotated ${entry.agentType} via agents run auto · ${outcome.newSessionId.slice(0, 8)}`,
            8000
          );
          console.log(`[WATCHDOG] rotated ${entry.id} -> agents run auto (${outcome.newSessionId.slice(0, 8)})`);
          await appendToLog({
            ts: now,
            kind: 'rotate',
            terminalId: entry.id,
            agentType: entry.agentType,
            message: `-> agents run auto · ${outcome.newSessionId.slice(0, 8)}`,
            reason: 'account exhausted (rate-limited tail)',
          });
          continue;
        }
        if (outcome.status === 'no_healthy_account') {
          // The rotate path already recorded the suppression and its skip
          // event (it saw the CLI's stderr); just surface it here.
          vscode.window.setStatusBarMessage(
            'All accounts are at their limit — nothing to rotate to',
            8000
          );
          console.log(`[WATCHDOG] no healthy account to rotate ${entry.id} into`);
        }
      } catch (err) {
        console.error(`[WATCHDOG] rotate failed for ${entry.id}:`, err);
      }
    }
  } finally {
    tickInFlight = false;
  }
}

/**
 * `Agents: Toggle Watchdog Auto-Rotate` — the off switch that did not exist
 * during the 2026-08-03 loop. Flips `agents.watchdog.autoRotate`; the running
 * loop picks it up via the configuration-change listener in startWatchdog.
 */
export function registerToggleAutoRotateCommand(
  registerCommand: typeof vscode.commands.registerCommand,
): vscode.Disposable {
  return registerCommand('agents.toggleWatchdogAutoRotate', async () => {
    const cfg = vscode.workspace.getConfiguration('agents.watchdog');
    const current = cfg.get<boolean>('autoRotate', true);
    await cfg.update('autoRotate', !current, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(
      `Watchdog auto-rotate ${!current ? 'ON' : 'OFF'}`,
      4000
    );
  });
}

export function startWatchdog(deps: WatchdogDeps): vscode.Disposable {
  const lastRotateMs = new Map<string, number>();
  const disposables: vscode.Disposable[] = [];
  let intervalId: NodeJS.Timeout | null = null;

  const ensureInterval = () => {
    const cfg = readConfig();
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (!cfg.enabled || !cfg.autoRotate) {
      console.log('[WATCHDOG] auto-rotate disabled');
      return;
    }
    intervalId = setInterval(() => {
      tick(lastRotateMs, deps).catch((err) => {
        console.error('[WATCHDOG] tick error:', err);
      });
    }, cfg.tickMs);
    console.log(`[WATCHDOG] auto-rotate enabled, tick=${cfg.tickMs}ms rotateCooldown=${cfg.rotateCooldownMs}ms`);
  };

  ensureInterval();

  disposables.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agents.watchdog')) {
        ensureInterval();
      }
    })
  );

  return {
    dispose() {
      if (intervalId) clearInterval(intervalId);
      for (const d of disposables) d.dispose();
    },
  };
}
