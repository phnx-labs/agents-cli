export type DebugLogSource = 'jsonrpc' | 'oauth';
export type DebugLogDirection = 'outgoing' | 'incoming' | 'step';
export type DebugLogStatus = 'pending' | 'ok' | 'error' | 'retry';

export interface DebugLogEntry {
  id: string;
  ts: number;
  source: DebugLogSource;
  direction: DebugLogDirection;
  method: string;
  status: DebugLogStatus;
  payload?: unknown;
  error?: string;
}

export interface DebugLogStreamOptions {
  now?: () => number;
  maxEntries?: number;
}

let nextLogSeq = 1;

function sanitizePayload(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function messageType(message: unknown): string {
  if (!message || typeof message !== 'object') return 'unknown';
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' && type.trim() ? type.trim() : 'unknown';
}

export class DebugLogStream {
  private entries: DebugLogEntry[] = [];
  private readonly subscribers = new Set<(entry: DebugLogEntry) => void>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: DebugLogStreamOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 500;
  }

  snapshot(): DebugLogEntry[] {
    return [...this.entries];
  }

  subscribe(fn: (entry: DebugLogEntry) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  append(entry: Omit<DebugLogEntry, 'id' | 'ts'> & Partial<Pick<DebugLogEntry, 'id' | 'ts'>>): DebugLogEntry {
    const full: DebugLogEntry = {
      id: entry.id ?? `dbg-${nextLogSeq++}`,
      ts: entry.ts ?? this.now(),
      source: entry.source,
      direction: entry.direction,
      method: entry.method,
      status: entry.status,
      ...(entry.payload !== undefined ? { payload: sanitizePayload(entry.payload) } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
    this.entries.push(full);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    for (const subscriber of this.subscribers) subscriber(full);
    return full;
  }

  recordJsonRpcRequest(message: unknown): string {
    const method = messageType(message);
    const entry = this.append({
      source: 'jsonrpc',
      direction: 'outgoing',
      method,
      status: 'pending',
      payload: message,
    });
    return entry.id;
  }

  recordJsonRpcResponse(requestId: string, method: string, error?: unknown): DebugLogEntry {
    const errorMessage = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    return this.append({
      id: `${requestId}:response`,
      source: 'jsonrpc',
      direction: 'incoming',
      method,
      status: errorMessage ? 'error' : 'ok',
      ...(errorMessage ? { error: errorMessage } : {}),
    });
  }

  recordOAuthStep(method: string, status: DebugLogStatus, payload?: unknown, error?: unknown): DebugLogEntry {
    const errorMessage = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    return this.append({
      source: 'oauth',
      direction: 'step',
      method,
      status,
      ...(payload !== undefined ? { payload } : {}),
      ...(errorMessage ? { error: errorMessage } : {}),
    });
  }
}

