/**
 * WebSocket source evaluator.
 *
 * ws is push-based: each frame is an observation. The poll-model `evaluate`
 * returns null (there is nothing to snapshot on a tick); real observations arrive
 * through `subscribe`, which opens a persistent client (the same `ws` client
 * lib/browser/cdp.ts uses — not the platform undici WebSocket).
 */

import WSWebSocket from 'ws';
import type { MonitorSource } from '../config.js';
import type { Observation } from './types.js';

/** Push-only: nothing to snapshot on a poll tick. */
export function evaluate(_source: MonitorSource): Promise<Observation | null> {
  return Promise.resolve(null);
}

/** Open a persistent WebSocket; emit each received frame as an observation. */
export function subscribe(source: MonitorSource, onObs: (obs: Observation) => void): () => void {
  const url = source.wsUrl;
  if (!url) return () => {};

  let closed = false;
  let socket: WSWebSocket | null = null;

  const connect = () => {
    if (closed) return;
    socket = new WSWebSocket(url, { maxPayload: 8 * 1024 * 1024 });
    socket.onmessage = (ev) => onObs({ raw: String(ev.data), meta: { kind: 'frame' } });
    socket.onclose = () => {
      if (!closed) setTimeout(connect, 5_000); // reconnect on drop
    };
    socket.onerror = () => {
      try { socket?.close(); } catch { /* already closing */ }
    };
  };
  connect();

  return () => {
    closed = true;
    try { socket?.close(); } catch { /* already closed */ }
  };
}
