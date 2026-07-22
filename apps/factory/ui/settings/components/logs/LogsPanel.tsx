import React, { useEffect, useMemo, useState } from 'react';
import { LogFilters } from './LogFilters';
import { LogRow } from './LogRow';
import type { LogEntry, LogFilterState } from './types';
import { filterLogEntries, pendingLogCount } from './types';

interface LogsPanelProps {
  entries: LogEntry[];
  totalEntryCount: number;
}

export function LogsPanel({ entries, totalEntryCount }: LogsPanelProps) {
  const [filters, setFilters] = useState<LogFilterState>({ source: 'all', query: '', errorsOnly: false });
  const [paused, setPaused] = useState(false);
  const [visibleEntries, setVisibleEntries] = useState<LogEntry[]>(entries);
  const [visibleTotalEntryCount, setVisibleTotalEntryCount] = useState(totalEntryCount);

  useEffect(() => {
    if (!paused) {
      setVisibleEntries(entries);
      setVisibleTotalEntryCount(totalEntryCount);
    }
  }, [entries, paused, totalEntryCount]);

  const filtered = useMemo(() => filterLogEntries(visibleEntries, filters), [visibleEntries, filters]);
  const pendingCount = pendingLogCount(totalEntryCount, visibleTotalEntryCount);

  const handlePausedChange = (nextPaused: boolean) => {
    if (!nextPaused) {
      setVisibleEntries(entries);
      setVisibleTotalEntryCount(totalEntryCount);
    }
    setPaused(nextPaused);
  };

  return (
    <main className="sw-logs-panel">
      <section className="sw-logs-head">
        <div>
          <div className="sw-logs-eyebrow">Live traffic</div>
          <h1>JSON-RPC and OAuth logs</h1>
        </div>
        <div className="sw-logs-count">{filtered.length} rows</div>
      </section>
      <LogFilters
        filters={filters}
        paused={paused}
        pendingCount={pendingCount}
        onFiltersChange={setFilters}
        onPausedChange={handlePausedChange}
      />
      <section className="sw-logs-table" aria-label="JSON-RPC and OAuth log rows">
        {filtered.length === 0 ? (
          <div className="sw-logs-empty">No log rows match the current filters.</div>
        ) : (
          filtered.map((entry) => <LogRow key={entry.id} entry={entry} />)
        )}
      </section>
    </main>
  );
}
