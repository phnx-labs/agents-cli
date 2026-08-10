/**
 * Wire types for the monitor broadcast channel (#66).
 *
 * The elected monitor (#65) runs a {@link MonitorBroadcastServer} and pushes
 * computed, pid/sessionId-keyed facts to every follower window. The transport
 * is a Unix-domain socket carrying newline-delimited JSON ("NDJSON") frames so
 * a single connection can multiplex three message kinds:
 *
 *   - `event`    server -> all clients   (fan-out push)
 *   - `request`  client -> server        (e.g. "register pids", "snapshot")
 *   - `response` server -> one client     (reply correlated by request id)
 */

/** The fact the monitor pushes to followers. `payload` is type-specific. */
export interface MonitorEvent {
  type: string;
  sessionId?: string;
  pid?: number;
  payload: unknown;
  ts: number;
}

/** Server -> clients: a broadcast push. */
export interface MonitorEventFrame {
  kind: 'event';
  event: MonitorEvent;
}

/** Client -> server: a correlated request on the persistent connection. */
export interface MonitorRequestFrame {
  kind: 'request';
  id: number;
  payload: unknown;
}

/** Server -> one client: the reply to a {@link MonitorRequestFrame}. */
export interface MonitorResponseFrame {
  kind: 'response';
  id: number;
  payload?: unknown;
  error?: string;
}

export type MonitorFrame =
  | MonitorEventFrame
  | MonitorRequestFrame
  | MonitorResponseFrame;

/** Serialize a frame as a single NDJSON line (trailing newline included). */
export function encodeFrame(frame: MonitorFrame): string {
  return JSON.stringify(frame) + '\n';
}

/**
 * Incremental NDJSON decoder. Socket reads do not align to line boundaries, so
 * the decoder buffers partial lines and emits complete frames as they arrive.
 * Malformed lines are dropped rather than throwing, so one corrupt frame never
 * tears down a persistent connection.
 */
export class FrameDecoder {
  private buf = '';

  push(chunk: string): MonitorFrame[] {
    this.buf += chunk;
    const frames: MonitorFrame[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) {
        continue;
      }
      try {
        frames.push(JSON.parse(line) as MonitorFrame);
      } catch {
        // Drop the malformed line; the connection stays alive.
      }
    }
    return frames;
  }
}
