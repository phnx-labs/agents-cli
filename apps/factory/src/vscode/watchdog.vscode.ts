import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentsViewJsonAgent,
  isVersionStillUsable,
  sessionUsedPercent,
} from '../core/resumeInBest';
import { getAllTerminals, EditorTerminal } from './terminals.vscode';
import { formatEvent, trimToLast, WatchdogEvent, WATCHDOG_LOG_PATH } from '../core/watchdogLog';
import { WatchdogVersionsPayload, WatchdogWatch } from '../monitor/protocol';

// This module is the extension's version auto-rotate loop. It is NOT a nudger:
// autonomous stall detection and nudge injection were retired — the CLI daemon
// watchdog is the sole injector now and writes the SAME `WatchdogEvent` JSONL
// feed (core/watchdogLog.ts) the Factory Floor status card reads. The extension
// keeps ONE capability the CLI lacks: on version exhaustion it rotates an agent
// terminal to the best signed-in version (rotateTerminalToBestVersion in
// extension.ts) and records a `rotate` event to that shared log.

const LOG_MAX_LINES = 500;

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
  try {
    const line = formatEvent(ev) + '\n';
    await fs.mkdir(path.dirname(WATCHDOG_LOG_PATH), { recursive: true });
    await fs.appendFile(WATCHDOG_LOG_PATH, line, 'utf8');
    if (++appendCount % LOG_TRIM_EVERY === 0) {
      await trimLogToCap(WATCHDOG_LOG_PATH, LOG_MAX_LINES);
    }
  } catch (err) {
    console.warn('[WATCHDOG] log write failed:', err);
  }
}

export type WatchdogRotateOutcome =
  | { status: 'no_session' }
  | { status: 'unsupported_agent' }
  | { status: 'view_unavailable' }
  | { status: 'already_usable'; agentKey: string; version: string; usedPercent: number }
  | { status: 'no_versions'; agentKey: string }
  | { status: 'rotated'; agentKey: string; oldVersion?: string; newVersion: string; newSessionId: string; email: string | null; usedPercent: number };

export interface WatchdogDeps {
  rotateTerminal: (entry: EditorTerminal) => Promise<WatchdogRotateOutcome>;
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

async function fetchAgentsViewJsonForWatchdog(agentKey: string): Promise<AgentsViewJsonAgent | null> {
  try {
    const { runAgents } = await import('../core/agentsBin');
    const { stdout } = await runAgents(`view ${agentKey} --json`, {
      maxBuffer: 5 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as AgentsViewJsonAgent;
    if (!parsed || !Array.isArray(parsed.versions)) return null;
    return parsed;
  } catch (err) {
    console.warn(`[WATCHDOG] agents view ${agentKey} --json failed:`, err);
    return null;
  }
}

// --- Monitor follower routing (#70) ---------------------------------------
//
// When this window is connected to the centralized monitor, the leader polls
// `agents view --json` once machine-wide and broadcasts a `watchdog/versions`
// fact; this window ARMS the monitor with the agent keys it needs polled and
// CONSUMES the broadcast for the auto-rotate exhaustion check instead of each
// window forking `agents view`. When disconnected (election race, leader loss)
// the window falls back to a local `agents view` spawn — nothing breaks.

let monitorConnected: () => boolean = () => false;
let monitorArmWatches: ((watches: WatchdogWatch[]) => void) | undefined;
// agentKey -> latest broadcast `agents view` result, consumed by auto-rotate.
const broadcastViews = new Map<string, AgentsViewJsonAgent>();

/** Wire the predicate the tick consults to decide local-vs-broadcast polling. */
export function setWatchdogMonitorConnectivity(fn: () => boolean): void {
  monitorConnected = fn;
}

/** Wire the sink that arms the monitor with this window's rotate-watched agents. */
export function setWatchdogArmSink(
  fn: ((watches: WatchdogWatch[]) => void) | undefined,
): void {
  monitorArmWatches = fn;
}

/** Apply a broadcast `agents view` fact: cache it for the auto-rotate check. */
export function ingestWatchdogVersionsFact(payload: WatchdogVersionsPayload): void {
  broadcastViews.set(payload.agentKey, payload.view);
}

let tickInFlight = false;
// Idle-window gating: when the IDE window has been unfocused for this long,
// skip ticks. Auto-rotate does network-bound `agents view` calls and spawns a
// fresh terminal — neither is useful when the user isn't watching.
const WATCHDOG_IDLE_SKIP_MS = 5 * 60_000;
let lastFocusedAtMs = Date.now();

async function tick(
  lastRotateMs: Map<string, number>,
  deps: WatchdogDeps
): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const cfg = readConfig();
    if (!cfg.enabled || !cfg.autoRotate) return;

    // Skip if no agent terminals exist in this window — nothing to rotate.
    const tracked = getAllTerminals().filter(
      (e) => !!e.sessionId && !!e.agentType,
    );
    if (tracked.length === 0) return;

    // Skip when the window has been unfocused long enough that the user is
    // clearly elsewhere. `vscode.window.state.focused` is a live snapshot; we
    // keep our own freshness clock so we don't hammer when the user hasn't
    // touched the window in minutes.
    if (vscode.window.state.focused) lastFocusedAtMs = Date.now();
    if (Date.now() - lastFocusedAtMs >= WATCHDOG_IDLE_SKIP_MS) return;

    const now = Date.now();
    const useMonitor = monitorConnected();

    const agentViewCache = new Map<string, AgentsViewJsonAgent | null>();
    const getAgentView = async (agentKey: string): Promise<AgentsViewJsonAgent | null> => {
      if (agentViewCache.has(agentKey)) return agentViewCache.get(agentKey) ?? null;
      // Prefer the leader's broadcast poll; fall back to a local spawn only
      // while disconnected so we never each fork `agents view` per window.
      const cached = useMonitor ? broadcastViews.get(agentKey) ?? null : null;
      const data = cached ?? await fetchAgentsViewJsonForWatchdog(agentKey);
      agentViewCache.set(agentKey, data);
      return data;
    };

    // Arm the monitor with the agents this window needs `agents view` polled
    // for. Replaces this window's whole slice each tick, so closed terminals
    // drop out automatically. Only Claude terminals with a pinned version can
    // rotate, so only those are armed.
    if (useMonitor && monitorArmWatches) {
      const watches: WatchdogWatch[] = [];
      for (const entry of tracked) {
        if (!entry.sessionId || !entry.agentType) continue;
        if (entry.agentType !== 'claude' || !entry.version) continue;
        watches.push({ sessionId: entry.sessionId, rotateAgentKey: entry.agentType });
      }
      monitorArmWatches(watches);
    }

    for (const entry of tracked) {
      if (!entry.sessionId || !entry.agentType) continue;
      const agentType = entry.agentType;
      // Auto-rotate is Claude-only: it swaps a version-pinned terminal that has
      // exhausted its quad to the best available signed-in version.
      if (agentType !== 'claude' || !entry.version) continue;

      const lastRotate = lastRotateMs.get(entry.id) ?? 0;
      if (now - lastRotate < cfg.rotateCooldownMs) continue;

      const view = await getAgentView(agentType);
      if (!view) continue;
      const current = view.versions.find((v) => v.version === entry.version);
      if (!current || isVersionStillUsable(current)) continue;

      console.log(
        `[WATCHDOG] auto-rotate triggered for ${entry.id} — ${agentType}@${entry.version} status=${current.usageStatus} session=${sessionUsedPercent(current)}%`
      );
      lastRotateMs.set(entry.id, now);
      try {
        const outcome = await deps.rotateTerminal(entry);
        if (outcome.status === 'rotated') {
          const acct = outcome.email ? ` (${outcome.email})` : '';
          vscode.window.setStatusBarMessage(
            `Auto-rotated ${outcome.agentKey} ${outcome.oldVersion ?? '?'} -> ${outcome.newVersion}${acct} · ${outcome.usedPercent}% session`,
            8000
          );
          console.log(`[WATCHDOG] rotated ${entry.id} -> ${outcome.newVersion}`);
          void appendToLog({
            ts: now,
            kind: 'rotate',
            terminalId: entry.id,
            agentType: agentType,
            message: `${outcome.oldVersion ?? '?'} -> ${outcome.newVersion}`,
            reason: `session ${outcome.usedPercent}% used${acct}`,
          });
          continue;
        }
        if (outcome.status === 'no_versions') {
          vscode.window.setStatusBarMessage(
            `All ${outcome.agentKey} quads exhausted — no rotation target`,
            8000
          );
          console.log(`[WATCHDOG] no available versions to rotate ${entry.id} into`);
        }
      } catch (err) {
        console.error(`[WATCHDOG] rotate failed for ${entry.id}:`, err);
      }
    }
  } finally {
    tickInFlight = false;
  }
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
