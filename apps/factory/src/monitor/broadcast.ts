import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import {
  encodeFrame,
  FrameDecoder,
  MonitorEvent,
  MonitorFrame,
} from './broadcastTypes';

/**
 * Default socket path for the monitor broadcast channel. Deliberately separate
 * from the one-shot watchdog socket (`~/.agents/.tmp/watchdog.sock`) so this
 * parallel pub/sub channel never disturbs the existing request/reply bridge.
 */
export const MONITOR_SOCKET_PATH = path.join(
  os.homedir(),
  '.agents',
  '.tmp',
  'monitor-broadcast.sock'
);

/**
 * Handles a follower->monitor request arriving on a persistent connection. The
 * return value (or thrown error) is serialized back to the requesting client.
 * A later leader (#65) supplies the real handler (e.g. "register pids",
 * "give me the current snapshot"); the transport itself is leader-agnostic.
 */
export type MonitorRequestHandler = (
  payload: unknown,
  socket: net.Socket
) => Promise<unknown> | unknown;

export interface MonitorBroadcastServerOptions {
  socketPath?: string;
  onRequest?: MonitorRequestHandler;
}

/**
 * Listens on the monitor socket, maintains a live set of follower connections,
 * and pushes events to all of them. Dead sockets are evicted from the set on
 * 'error'/'close'/'end' and on any failed write, so a closed follower window
 * never blocks the fan-out.
 */
export class MonitorBroadcastServer {
  private readonly socketPath: string;
  private readonly onRequest?: MonitorRequestHandler;
  private server: net.Server | null = null;
  private readonly clients = new Set<net.Socket>();

  constructor(options: MonitorBroadcastServerOptions = {}) {
    this.socketPath = options.socketPath ?? MONITOR_SOCKET_PATH;
    this.onRequest = options.onRequest;
  }

  /** Number of currently-connected follower sockets. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Bind and start listening. Rejects if the socket address is already taken. */
  async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.socketPath), { recursive: true });
    await this.unlinkSocket();
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));
      const onListenError = (err: Error) => reject(err);
      server.once('error', onListenError);
      server.listen(this.socketPath, () => {
        server.removeListener('error', onListenError);
        server.on('error', (err) =>
          console.error('[MONITOR] broadcast server error:', err)
        );
        this.server = server;
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    socket.setEncoding('utf8');
    this.clients.add(socket);
    const decoder = new FrameDecoder();

    socket.on('data', (chunk: string) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind === 'request') {
          void this.handleRequest(socket, frame.id, frame.payload);
        }
      }
    });

    const drop = () => {
      this.clients.delete(socket);
    };
    socket.on('error', drop);
    socket.on('close', drop);
    socket.on('end', drop);
  }

  private async handleRequest(
    socket: net.Socket,
    id: number,
    payload: unknown
  ): Promise<void> {
    if (!this.onRequest) {
      this.writeFrame(socket, {
        kind: 'response',
        id,
        error: 'No request handler registered',
      });
      return;
    }
    try {
      const result = await this.onRequest(payload, socket);
      this.writeFrame(socket, { kind: 'response', id, payload: result });
    } catch (err) {
      this.writeFrame(socket, {
        kind: 'response',
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Push an event to every connected follower. */
  broadcast(event: MonitorEvent): void {
    const line = encodeFrame({ kind: 'event', event });
    for (const socket of this.clients) {
      this.writeRaw(socket, line);
    }
  }

  private writeFrame(socket: net.Socket, frame: MonitorFrame): void {
    this.writeRaw(socket, encodeFrame(frame));
  }

  private writeRaw(socket: net.Socket, line: string): void {
    if (socket.destroyed || !socket.writable) {
      this.clients.delete(socket);
      return;
    }
    try {
      socket.write(line);
    } catch {
      this.clients.delete(socket);
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
    }
  }

  private async unlinkSocket(): Promise<void> {
    try {
      await fs.unlink(this.socketPath);
    } catch {
      // Nothing to clean up.
    }
  }

  /** Stop listening, drop all clients, and remove the socket file. */
  async close(): Promise<void> {
    for (const socket of this.clients) {
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
    }
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.unlinkSocket();
  }
}

export type MonitorConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'closed';

export type MonitorEventListener = (event: MonitorEvent) => void;

export interface MonitorBroadcastClientOptions {
  socketPath?: string;
  /** Initial reconnect backoff, doubled each failed attempt. Default 100ms. */
  minReconnectDelayMs?: number;
  /** Reconnect backoff ceiling. Default 5000ms. */
  maxReconnectDelayMs?: number;
  /** How long a pending follower->server request waits. Default 5000ms. */
  requestTimeoutMs?: number;
  onStateChange?: (state: MonitorConnectionState) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Holds a PERSISTENT connection to the monitor. Subscribers receive pushed
 * events; callers can issue correlated requests on the same socket. If the
 * connection drops (e.g. a leader takeover, #65) the client auto-reconnects
 * with exponential backoff. {@link state}/{@link connected} are exposed so a
 * caller can decide to degrade to the JSON registry while disconnected — the
 * fallback itself is intentionally NOT wired here.
 */
export class MonitorBroadcastClient {
  private readonly socketPath: string;
  private readonly minDelay: number;
  private readonly maxDelay: number;
  private readonly requestTimeoutMs: number;
  private readonly onStateChange?: (state: MonitorConnectionState) => void;

  private socket: net.Socket | null = null;
  private decoder = new FrameDecoder();
  private _state: MonitorConnectionState = 'disconnected';
  private reconnectDelay: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<MonitorEventListener>();

  constructor(options: MonitorBroadcastClientOptions = {}) {
    this.socketPath = options.socketPath ?? MONITOR_SOCKET_PATH;
    this.minDelay = options.minReconnectDelayMs ?? 100;
    this.maxDelay = options.maxReconnectDelayMs ?? 5000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.onStateChange = options.onStateChange;
    this.reconnectDelay = this.minDelay;
  }

  get state(): MonitorConnectionState {
    return this._state;
  }

  get connected(): boolean {
    return this._state === 'connected';
  }

  /** Register an event listener. Returns an unsubscribe function. */
  subscribe(listener: MonitorEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Begin connecting (and stay connected, reconnecting as needed). */
  connect(): void {
    if (this.closed || this.socket) {
      return;
    }
    this.setState('connecting');
    const socket = net.createConnection(this.socketPath);
    socket.setEncoding('utf8');
    this.socket = socket;

    socket.on('connect', () => {
      this.reconnectDelay = this.minDelay;
      this.decoder = new FrameDecoder();
      this.setState('connected');
    });
    socket.on('data', (chunk: string) => {
      for (const frame of this.decoder.push(chunk)) {
        this.handleFrame(frame);
      }
    });
    // 'error' always precedes 'close'; reconnect is driven from 'close' so the
    // teardown path runs exactly once.
    socket.on('error', () => undefined);
    socket.on('close', () => this.handleDisconnect());
  }

  private handleFrame(frame: MonitorFrame): void {
    if (frame.kind === 'event') {
      for (const listener of this.listeners) {
        try {
          listener(frame.event);
        } catch (err) {
          console.error('[MONITOR] broadcast listener threw:', err);
        }
      }
      return;
    }
    if (frame.kind === 'response') {
      const pending = this.pending.get(frame.id);
      if (!pending) {
        return;
      }
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error) {
        pending.reject(new Error(frame.error));
      } else {
        pending.resolve(frame.payload);
      }
    }
  }

  /** Send a correlated request to the monitor and await its response. */
  request(payload: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const socket = this.socket;
      if (!socket || this._state !== 'connected') {
        reject(new Error('Not connected to monitor'));
        return;
      }
      const id = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Monitor request timed out'));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.write(encodeFrame({ kind: 'request', id, payload }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleDisconnect(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
    }
    this.rejectAllPending(new Error('Monitor connection lost'));
    if (this.closed) {
      return;
    }
    this.setState('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxDelay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private setState(state: MonitorConnectionState): void {
    if (this._state === state) {
      return;
    }
    this._state = state;
    if (this.onStateChange) {
      try {
        this.onStateChange(state);
      } catch (err) {
        console.error('[MONITOR] onStateChange threw:', err);
      }
    }
  }

  /** Permanently close the client: no further reconnects. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new Error('Monitor client closed'));
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // Already gone.
      }
      this.socket = null;
    }
    this.listeners.clear();
    this.setState('closed');
  }
}
