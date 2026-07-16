/**
 * Read-only localhost HTTP + Server-Sent-Events server for `agents serve`.
 *
 * There is deliberately NO framework and NO mutation surface:
 *  - binds 127.0.0.1 only (loopback) — never reachable off the machine;
 *  - answers GET only (every other method → 405);
 *  - routes: `GET /` → HTML page, `GET /api/state` → JSON snapshot,
 *    `GET /events` → SSE stream that re-pushes the snapshot on an interval.
 *
 * The whole thing is a viewer over data other commands already own
 * ({@link assembleState}); it writes nothing.
 *
 * The GET routing is exported as {@link handleServeGet} so the authenticated
 * `--control` variant (see control.ts) can reuse it verbatim rather than
 * duplicate the state/SSE surface.
 */
import type http from 'http';
import { createServer } from 'http';
import { assembleState } from './data.js';
import type { ServeState } from './data.js';
import { renderPage } from './page.js';

/** Loopback address — the server binds here and nowhere else. */
export const SERVE_HOST = '127.0.0.1';
/** Default port for `agents serve`. */
export const DEFAULT_SERVE_PORT = 4477;
/** Default SSE push cadence. */
export const DEFAULT_INTERVAL_MS = 3000;

export interface ServeOptions {
  /** Project root for project-scoped routine discovery. Defaults to process.cwd(). */
  cwd?: string;
  /** SSE push cadence in ms. Defaults to {@link DEFAULT_INTERVAL_MS}. */
  intervalMs?: number;
  /**
   * Snapshot data source. Defaults to {@link assembleState}. Read-only DI seam
   * so tests can drive SSE lifecycle timing deterministically (e.g. gate the
   * first snapshot to reproduce a mid-snapshot disconnect); production never
   * sets it.
   */
  snapshot?: () => Promise<ServeState>;
}

/**
 * Resolved GET-route context: the snapshot source and SSE cadence, with all
 * defaults applied. Built once by {@link resolveServeContext}.
 */
export interface ServeContext {
  snapshot: () => Promise<ServeState>;
  intervalMs: number;
}

/** Apply defaults to {@link ServeOptions}, producing a {@link ServeContext}. */
export function resolveServeContext(opts: ServeOptions = {}): ServeContext {
  const cwd = opts.cwd ?? process.cwd();
  return {
    snapshot: opts.snapshot ?? ((): Promise<ServeState> => assembleState(cwd)),
    intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
  };
}

/**
 * Handle the shared read-only GET surface (`/`, `/api/state`, `/events`).
 * Returns `true` when the route was recognized and a response was written (or
 * begun, for SSE); `false` when the path is unknown so the caller can 404 or
 * try its own routes first. Extracted so the `--control` server reuses the
 * exact same state/SSE behavior — including the load-bearing SSE close/timer
 * ordering below — without duplicating it.
 */
export async function handleServeGet(
  url: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServeContext,
): Promise<boolean> {
  if (url === '/' || url === '/index.html') {
    const html = renderPage();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  if (url === '/api/state') {
    try {
      const state = await ctx.snapshot();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(state));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String((err as Error)?.message ?? err) }));
    }
    return true;
  }

  if (url === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    let closed = false;
    // Declare the timer first and register the disconnect cleanup BEFORE the
    // first `await push()`. `assembleState()` (team scan + git diffs) can be
    // slow; if the client disconnects during it, the one-shot 'close' must
    // already have a listener — otherwise it fires into the void, the interval
    // starts anyway, and we leak a timer writing to a destroyed socket forever.
    let timer: ReturnType<typeof setInterval> | undefined;
    req.on('close', () => {
      closed = true;
      if (timer) clearInterval(timer);
    });

    const push = async () => {
      if (closed) return;
      try {
        const state = await ctx.snapshot();
        if (closed) return;
        res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
      } catch (err) {
        if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`);
      }
    };

    await push(); // immediate first frame
    // Only arm the interval if the client is still connected. If 'close' fired
    // during the first push, `closed` is already true (and the handler ran
    // while `timer` was undefined), so starting an interval here would leak.
    if (!closed) timer = setInterval(push, ctx.intervalMs);
    return true;
  }

  return false;
}

/**
 * Create (but do not start) the read-only serve server. Caller invokes
 * `.listen(port, SERVE_HOST)`. Returned so tests can bind an ephemeral port.
 */
export function createServeServer(opts: ServeOptions = {}): http.Server {
  const ctx = resolveServeContext(opts);

  const server = createServer(async (req, res) => {
    // Read-only: reject anything that could mutate. Only GET is served.
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET' });
      res.end('method not allowed');
      return;
    }

    const url = (req.url || '/').split('?')[0];
    const handled = await handleServeGet(url, req, res, ctx);
    if (!handled) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });

  return server;
}

/**
 * Start the serve server on `port`, bound to loopback. Resolves with the
 * actual bound port (useful when `port === 0` for tests).
 */
export function startServeServer(
  port: number = DEFAULT_SERVE_PORT,
  opts: ServeOptions = {},
): Promise<{ server: http.Server; port: number }> {
  const server = createServeServer(opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, SERVE_HOST, () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, port: boundPort });
    });
  });
}
