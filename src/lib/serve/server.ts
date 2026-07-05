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
 */
import http from 'http';
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
}

/**
 * Create (but do not start) the read-only serve server. Caller invokes
 * `.listen(port, SERVE_HOST)`. Returned so tests can bind an ephemeral port.
 */
export function createServeServer(opts: ServeOptions = {}): http.Server {
  const cwd = opts.cwd ?? process.cwd();
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  const snapshot = (): Promise<ServeState> => assembleState(cwd);

  const server = http.createServer(async (req, res) => {
    // Read-only: reject anything that could mutate. Only GET is served.
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET' });
      res.end('method not allowed');
      return;
    }

    const url = (req.url || '/').split('?')[0];

    if (url === '/' || url === '/index.html') {
      const html = renderPage();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url === '/api/state') {
      try {
        const state = await snapshot();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(state));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String((err as Error)?.message ?? err) }));
      }
      return;
    }

    if (url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      let closed = false;
      const push = async () => {
        if (closed) return;
        try {
          const state = await snapshot();
          if (closed) return;
          res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
        } catch (err) {
          if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`);
        }
      };

      await push(); // immediate first frame
      const timer = setInterval(push, intervalMs);
      req.on('close', () => {
        closed = true;
        clearInterval(timer);
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
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
