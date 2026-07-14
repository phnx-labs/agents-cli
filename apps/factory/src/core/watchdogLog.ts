import * as os from 'os';
import * as path from 'path';

// Watchdog event log: formatting + parsing for the JSONL feed at
// ~/.agents/.cache/logs/watchdog.log. The webview pulls this file periodically
// to render the Watchdog activity card on the Factory Floor.

export const WATCHDOG_LOG_PATH = path.join(os.homedir(), '.agents', '.cache', 'logs', 'watchdog.log');

export type WatchdogEventKind = 'tick' | 'decision' | 'nudge' | 'rotate' | 'error';

export interface WatchdogEvent {
  ts: number;
  kind: WatchdogEventKind;
  terminalId?: string;
  agentType?: string;
  message: string;
  reason?: string;
  // For 'tick' events: the session lines the watchdog actually read.
  tailLines?: string[];
  // For 'tick' and 'decision' events: how long the terminal had been stalled.
  stalledForMs?: number;
  // Carried on tick/decision/nudge so the UI can show what the agent was
  // stuck on without re-parsing the raw tail.
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  // For 'decision' events that result in a nudge: the exact text the watchdog
  // chose to inject. Stored here too so a decision row carries the same
  // context as its paired nudge event.
  nudgeText?: string;
}

export function formatEvent(ev: WatchdogEvent): string {
  return JSON.stringify(ev);
}

export function parseEvents(text: string): WatchdogEvent[] {
  if (!text) return [];
  const out: WatchdogEvent[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const ts = typeof parsed.ts === 'number' ? parsed.ts : NaN;
      const kind = parsed.kind;
      const message = typeof parsed.message === 'string' ? parsed.message : '';
      if (!Number.isFinite(ts)) continue;
      if (kind !== 'tick' && kind !== 'decision' && kind !== 'nudge' && kind !== 'rotate' && kind !== 'error') continue;
      out.push({
        ts,
        kind,
        message,
        terminalId: typeof parsed.terminalId === 'string' ? parsed.terminalId : undefined,
        agentType: typeof parsed.agentType === 'string' ? parsed.agentType : undefined,
        reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
        tailLines: Array.isArray(parsed.tailLines)
          ? (parsed.tailLines as unknown[]).filter((l): l is string => typeof l === 'string')
          : undefined,
        stalledForMs: typeof parsed.stalledForMs === 'number' ? parsed.stalledForMs : undefined,
        lastUserMessage: typeof parsed.lastUserMessage === 'string' ? parsed.lastUserMessage : undefined,
        lastAssistantMessage: typeof parsed.lastAssistantMessage === 'string' ? parsed.lastAssistantMessage : undefined,
        nudgeText: typeof parsed.nudgeText === 'string' ? parsed.nudgeText : undefined,
      });
    } catch {
      // Skip malformed lines.
    }
  }
  return out;
}

// Trim a JSONL log body in-memory to the last `maxLines` events. Used by
// the writer when the file grows past the cap so we don't unbounded-grow.
export function trimToLast(text: string, maxLines: number): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length <= maxLines) return lines.join('\n') + (lines.length ? '\n' : '');
  return lines.slice(lines.length - maxLines).join('\n') + '\n';
}
