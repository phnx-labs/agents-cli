import React, { useState } from 'react';
import type { LogEntry } from './types';
import { serializedPayload } from './types';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusLabel(entry: LogEntry): string {
  if (entry.status === 'ok') return 'OK';
  if (entry.status === 'error') return 'ERR';
  if (entry.status === 'retry') return 'RETRY';
  return 'WAIT';
}

export function LogRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const payload = serializedPayload(entry);
  return (
    <div className={`sw-log-row ${expanded ? 'expanded' : ''} ${entry.status}`}>
      <button type="button" className="sw-log-summary" onClick={() => setExpanded(!expanded)}>
        <span className={`sw-log-status ${entry.status}`}>{statusLabel(entry)}</span>
        <span className="sw-log-time">{formatTime(entry.ts)}</span>
        <span className="sw-log-source">{entry.source}</span>
        <span className="sw-log-direction">{entry.direction}</span>
        <span className="sw-log-method">{entry.method}</span>
      </button>
      {expanded && (
        <div className="sw-log-detail">
          {entry.error && (
            <pre className="sw-log-error">{entry.error}</pre>
          )}
          <pre>{payload || '(empty payload)'}</pre>
        </div>
      )}
    </div>
  );
}

