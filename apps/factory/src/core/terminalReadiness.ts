// Terminal readiness state machine (pure logic, VS Code independent).
//
// Events per terminal, monotonic on the way up:
//   tabReady   -> pty allocated, terminal handle exists
//   shellReady -> shell binary has exec'd (zsh/bash/fish)
//   promptReady -> rc files done, shell idle at prompt
//   agentReady  -> agent CLI (child of shell) idle waiting on pty input

export type ReadinessEvent =
  | 'tabReady'
  | 'shellReady'
  | 'promptReady'
  | 'agentReady';

export const READINESS_ORDER: readonly ReadinessEvent[] = [
  'tabReady',
  'shellReady',
  'promptReady',
  'agentReady',
];

export interface ReadinessState {
  tabReadyAt: number | null;
  shellReadyAt: number | null;
  promptReadyAt: number | null;
  agentReadyAt: number | null;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export interface ReadinessEntry {
  state: ReadinessState;
  waiters: Map<ReadinessEvent, Waiter[]>;
  disposed: boolean;
}

export function createEntry(): ReadinessEntry {
  return {
    state: {
      tabReadyAt: null,
      shellReadyAt: null,
      promptReadyAt: null,
      agentReadyAt: null,
    },
    waiters: new Map(),
    disposed: false,
  };
}

const EVENT_FIELD: Record<ReadinessEvent, keyof ReadinessState> = {
  tabReady: 'tabReadyAt',
  shellReady: 'shellReadyAt',
  promptReady: 'promptReadyAt',
  agentReady: 'agentReadyAt',
};

export function hasFired(entry: ReadinessEntry, event: ReadinessEvent): boolean {
  return entry.state[EVENT_FIELD[event]] !== null;
}

// Mark an event as fired. Cascades to all lower events so callers don't have
// to mark them explicitly (a fast path to promptReady implies tab+shell ready).
// Idempotent: re-marking has no effect.
export function markEvent(
  entry: ReadinessEntry,
  event: ReadinessEvent,
  now: number = Date.now()
): void {
  if (entry.disposed) return;

  const targetIndex = READINESS_ORDER.indexOf(event);
  for (let i = 0; i <= targetIndex; i++) {
    const e = READINESS_ORDER[i];
    if (entry.state[EVENT_FIELD[e]] === null) {
      entry.state[EVENT_FIELD[e]] = now;
      flushWaiters(entry, e);
    }
  }
}

// Reset agentReady (and optionally promptReady) so Resume flows can re-await
// after killing the agent CLI. tabReady and shellReady stay set because the
// pty and shell are still alive.
export function resetFrom(entry: ReadinessEntry, event: ReadinessEvent): void {
  if (entry.disposed) return;

  const fromIndex = READINESS_ORDER.indexOf(event);
  for (let i = fromIndex; i < READINESS_ORDER.length; i++) {
    const e = READINESS_ORDER[i];
    entry.state[EVENT_FIELD[e]] = null;
  }
}

function flushWaiters(entry: ReadinessEntry, event: ReadinessEvent): void {
  const list = entry.waiters.get(event);
  if (!list || list.length === 0) return;
  entry.waiters.delete(event);
  for (const w of list) {
    if (w.timer) clearTimeout(w.timer);
    w.resolve();
  }
}

export interface WaitOptions {
  timeoutMs?: number;
}

export function waitFor(
  entry: ReadinessEntry,
  event: ReadinessEvent,
  opts: WaitOptions = {}
): Promise<void> {
  if (entry.disposed) {
    return Promise.reject(new Error('terminal readiness entry disposed'));
  }

  if (hasFired(entry, event)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let list = entry.waiters.get(event);
    if (!list) {
      list = [];
      entry.waiters.set(event, list);
    }

    let timer: NodeJS.Timeout | null = null;
    const waiter: Waiter = {
      resolve,
      reject,
      timer: null,
    };

    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        const current = entry.waiters.get(event);
        if (!current) return;
        const idx = current.indexOf(waiter);
        if (idx >= 0) current.splice(idx, 1);
        if (current.length === 0) entry.waiters.delete(event);
        reject(new Error(`timed out waiting for ${event} after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
      waiter.timer = timer;
    }

    list.push(waiter);
  });
}

// Reject all pending waiters and mark the entry disposed.
// Called when the terminal closes or the extension deactivates.
export function dispose(entry: ReadinessEntry, reason: string = 'disposed'): void {
  if (entry.disposed) return;
  entry.disposed = true;
  for (const list of entry.waiters.values()) {
    for (const w of list) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(new Error(reason));
    }
  }
  entry.waiters.clear();
}

// --- Agent CLI detection (pure helpers) -----------------------------------

export type AgentLauncherKey = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode';

/**
 * Detect a known agent CLI from a `ps -o args=` output string.
 * Handles direct invocation, absolute paths, node-wrapped scripts, and
 * `agents run <agent>` wrappers from agents-cli.
 */
export function detectAgentKeyFromArgs(args: string): AgentLauncherKey | null {
  const runMatch = args.match(/\bagents\s+run\s+(claude|codex|gemini|cursor|opencode)\b/);
  if (runMatch) return runMatch[1] as AgentLauncherKey;

  const tokens = args.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const base = (tok.split('/').pop() || '').toLowerCase();
    if (base === 'claude' || base === 'claude.js') return 'claude';
    if (base === 'codex' || base === 'codex.js') return 'codex';
    if (base === 'gemini' || base === 'gemini.js') return 'gemini';
    if (base === 'cursor-agent') return 'cursor';
    if (base === 'opencode') return 'opencode';
  }
  return null;
}

/**
 * Extract a session UUID from agent CLI args. Recognizes:
 *   --session-id <uuid>
 *   --session-id=<uuid>
 *   --session <uuid>
 */
export function extractSessionIdFromArgs(args: string): string | undefined {
  const m = args.match(
    /--session(?:-id)?[\s=]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  return m?.[1];
}
