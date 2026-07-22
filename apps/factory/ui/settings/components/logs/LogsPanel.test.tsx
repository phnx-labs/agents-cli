import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LogsPanel } from './LogsPanel';
import { filterLogEntries, pendingLogCount, type LogEntry } from './types';

const rows: LogEntry[] = [
  {
    id: 'one',
    ts: 1000,
    source: 'jsonrpc',
    direction: 'outgoing',
    method: 'fetchAllTerminals',
    status: 'pending',
    payload: { type: 'fetchAllTerminals' },
  },
  {
    id: 'two',
    ts: 2000,
    source: 'oauth',
    direction: 'step',
    method: 'linear.auth.check',
    status: 'ok',
    payload: { connected: true },
  },
  {
    id: 'three',
    ts: 3000,
    source: 'jsonrpc',
    direction: 'incoming',
    method: 'dispatch',
    status: 'error',
    error: 'Dispatch failed',
  },
];

describe('filterLogEntries', () => {
  test('filters by source, method/payload search, and errors-only', () => {
    expect(filterLogEntries(rows, { source: 'oauth', query: '', errorsOnly: false }).map((row) => row.id)).toEqual(['two']);
    expect(filterLogEntries(rows, { source: 'all', query: 'terminals', errorsOnly: false }).map((row) => row.id)).toEqual(['one']);
    expect(filterLogEntries(rows, { source: 'all', query: '', errorsOnly: true }).map((row) => row.id)).toEqual(['three']);
  });

  test('counts pending rows independently from the capped visible buffer length', () => {
    expect(pendingLogCount(625, 500)).toBe(125);
    expect(pendingLogCount(500, 500)).toBe(0);
  });
});

describe('LogsPanel', () => {
  test('renders docked log rows and controls', () => {
    const html = renderToStaticMarkup(<LogsPanel entries={rows} totalEntryCount={rows.length} />);

    expect(html).toContain('JSON-RPC and OAuth logs');
    expect(html).toContain('fetchAllTerminals');
    expect(html).toContain('linear.auth.check');
    expect(html).toContain('Errors only');
    expect(html).toContain('Pause');
  });
});
