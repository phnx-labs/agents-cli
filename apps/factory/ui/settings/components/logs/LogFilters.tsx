import React from 'react';
import type { LogFilterState } from './types';

interface LogFiltersProps {
  filters: LogFilterState;
  paused: boolean;
  pendingCount: number;
  onFiltersChange: (filters: LogFilterState) => void;
  onPausedChange: (paused: boolean) => void;
}

export function LogFilters({ filters, paused, pendingCount, onFiltersChange, onPausedChange }: LogFiltersProps) {
  return (
    <div className="sw-logs-filters">
      <label className="sw-logs-control">
        <span>Source</span>
        <select
          value={filters.source}
          onChange={(event) => onFiltersChange({ ...filters, source: event.target.value as LogFilterState['source'] })}
        >
          <option value="all">All</option>
          <option value="jsonrpc">JSON-RPC</option>
          <option value="oauth">OAuth</option>
        </select>
      </label>
      <label className="sw-logs-control sw-logs-search">
        <span>Method</span>
        <input
          value={filters.query}
          onChange={(event) => onFiltersChange({ ...filters, query: event.target.value })}
          placeholder="Filter method or payload"
        />
      </label>
      <label className="sw-logs-check">
        <input
          type="checkbox"
          checked={filters.errorsOnly}
          onChange={(event) => onFiltersChange({ ...filters, errorsOnly: event.target.checked })}
        />
        <span>Errors only</span>
      </label>
      <button
        type="button"
        className={`sw-logs-pause ${paused ? 'paused' : ''}`}
        onClick={() => onPausedChange(!paused)}
      >
        {paused ? `Resume${pendingCount > 0 ? ` (${pendingCount})` : ''}` : 'Pause'}
      </button>
    </div>
  );
}

