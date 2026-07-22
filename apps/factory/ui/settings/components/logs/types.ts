export type LogSource = 'jsonrpc' | 'oauth';
export type LogDirection = 'outgoing' | 'incoming' | 'step';
export type LogStatus = 'pending' | 'ok' | 'error' | 'retry';

export interface LogEntry {
  id: string;
  ts: number;
  source: LogSource;
  direction: LogDirection;
  method: string;
  status: LogStatus;
  payload?: unknown;
  error?: string;
}

export interface LogFilterState {
  source: 'all' | LogSource;
  query: string;
  errorsOnly: boolean;
}

export function serializedPayload(entry: LogEntry): string {
  if (entry.payload === undefined) return '';
  if (typeof entry.payload === 'string') return entry.payload;
  try {
    return JSON.stringify(entry.payload, null, 2);
  } catch {
    return String(entry.payload);
  }
}

export function filterLogEntries(entries: LogEntry[], filters: LogFilterState): LogEntry[] {
  const needle = filters.query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filters.source !== 'all' && entry.source !== filters.source) return false;
    if (filters.errorsOnly && entry.status !== 'error') return false;
    if (!needle) return true;
    const haystack = [
      entry.source,
      entry.direction,
      entry.method,
      entry.status,
      entry.error ?? '',
      serializedPayload(entry),
    ].join('\n').toLowerCase();
    return haystack.includes(needle);
  });
}

export function pendingLogCount(totalEntryCount: number, visibleTotalEntryCount: number): number {
  return Math.max(0, totalEntryCount - visibleTotalEntryCount);
}
