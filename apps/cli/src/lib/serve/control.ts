/**
 * Authenticated `agents serve --control` server — the "anchor" the iOS/iPadOS
 * cockpit talks to (RUSH-1731).
 *
 * It is the read-only {@link handleServeGet} surface plus a small mutation API,
 * gated by a bearer token ({@link verifyControlToken}) on EVERY request because,
 * unlike plain `agents serve`, this variant may bind beyond loopback (a tailnet
 * address) so the phone can reach it. It adds no new execution machinery: a run
 * request re-invokes the same `agents run` the CLI uses (inheriting host
 * offload, secrets, detached dispatch), and a message re-invokes `agents
 * message`. The server generates the run's session id so the run is immediately
 * addressable for streaming (Phase 2) and steering.
 *
 * Both side-effecting operations are behind DI seams ({@link ControlOptions})
 * so tests drive them without spawning real agents — mirroring the `snapshot`
 * seam on the read-only server.
 */
import type http from 'http';
import { createServer } from 'http';
import fs from 'fs';
import type { StdioOptions } from 'child_process';
import { spawn } from 'child_process';
import { randomUUID, randomBytes } from 'crypto';
import { getAgentsInvocation } from '../daemon.js';
import { handleServeGet, resolveServeContext, type ServeOptions } from './server.js';
import { verifyControlToken } from './token.js';
import { readNewEvents, streamDir, streamLogPath } from './stream.js';

/** A request to start an agent run on this anchor (local or offloaded). */
export interface RunRequest {
  /** Agent to run: 'claude' | 'codex' | 'gemini' | … */
  agent: string;
  /** Headless prompt. */
  prompt: string;
  /** Permission mode: plan | edit | auto | skip. Defaults to the CLI default. */
  mode?: string;
  /** Offload onto a registered device / host (the executor). Omit → run on the anchor. */
  host?: string;
  /** Working directory (on the host when `host` is set). */
  cwd?: string;
}

/** Identifiers by which the started run can later be streamed / messaged. */
export interface RunResult {
  /** Addressable session id (a UUID for claude; otherwise equals `name`). */
  sessionId: string;
  /** Durable run name seeded into the session label. */
  name: string;
}

/** Starts a run and returns its addressable ids. */
export type RunDispatcher = (req: RunRequest) => Promise<RunResult>;
/** Delivers a message to a running/parked agent by id. */
export type Messenger = (id: string, text: string, from?: string) => Promise<void>;

export interface ControlOptions extends ServeOptions {
  /** Bearer verifier. Defaults to {@link verifyControlToken}. */
  verifyToken?: (presented: string | undefined) => boolean;
  /** Run starter. Defaults to spawning `agents run …` detached. */
  runner?: RunDispatcher;
  /** Message sender. Defaults to spawning `agents message …`. */
  messenger?: Messenger;
  /** Poll cadence (ms) for the session event stream. Defaults to 300. */
  streamPollMs?: number;
  /** Resolve a session id to its NDJSON capture file. Defaults to {@link streamLogPath}. */
  streamLogPathFor?: (sessionId: string) => string;
}

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_STREAM_POLL_MS = 300;

/** Pull the presented bearer token from either header form. */
function presentedToken(req: http.IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const x = req.headers['x-agents-token'];
  return typeof x === 'string' ? x.trim() : undefined;
}

/** Read a JSON request body with a hard size cap. Rejects on overflow/parse error. */
function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/**
 * SSE stream of a session's normalized NDJSON events, offset-tailed from its
 * capture file. Resumes from `?offset=<bytes>` or the `Last-Event-ID` header
 * (each event's `id:` is its exact byte offset, so resume neither loses nor
 * duplicates). Closes when a terminal (`result`/`error`) event is seen or the
 * client disconnects. A not-yet-created file simply yields nothing until the
 * run starts writing — the phone can open the stream the instant it dispatches.
 */
export function startSessionStream(
  file: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pollMs: number,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const params = new URL(req.url ?? '/', 'http://anchor').searchParams;
  const qOffset = Number.parseInt(params.get('offset') ?? '', 10);
  const lastId = Number.parseInt(
    Array.isArray(req.headers['last-event-id'])
      ? req.headers['last-event-id'][0]
      : req.headers['last-event-id'] ?? '',
    10,
  );
  // Clamp at the source: a negative/garbage offset (or Last-Event-ID) is
  // meaningless and, worse, `Buffer.subarray(neg)` indexes from the END — so an
  // unclamped negative offset would read nothing and never self-correct. A bad
  // resume value replays from the start, the EventSource-friendly behavior.
  const wanted = Number.isFinite(qOffset) ? qOffset : Number.isFinite(lastId) ? lastId : 0;
  let offset = Math.max(0, wanted);

  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    closed = true;
    if (timer) clearInterval(timer);
  };
  req.on('close', stop);

  const tick = () => {
    if (closed) return;
    const { events, newOffset, done } = readNewEvents(file, offset);
    for (const { event, offset: at } of events) {
      // `at` is the per-event resume point the CLIENT echoes as Last-Event-ID.
      res.write(`id: ${at}\nevent: ${event.type}\ndata: ${JSON.stringify(event.raw)}\n\n`);
    }
    // The SERVER cursor always adopts newOffset — past every complete line,
    // including trailing blank/non-JSON lines after the last event — so the
    // stream always makes progress (even on an empty read) and never re-scans.
    offset = newOffset;
    if (done && !closed) {
      res.write('event: end\ndata: {"ok":true}\n\n');
      stop();
      res.end();
    }
  };

  tick(); // immediate catch-up from the resume offset
  if (!closed) timer = setInterval(tick, pollMs);
}

/**
 * Spawn a detached child and settle once it has either successfully spawned or
 * failed to. Attaching an `'error'` listener is mandatory: a `ChildProcess` is
 * an `EventEmitter`, so an `'error'` event (e.g. ENOENT from a stale/missing
 * `agents` binary — a real condition `validateDaemonBinary` guards against)
 * with no listener throws and would take down the whole anchor process, not
 * just the one request. Mirrors the `once('spawn') / once('error')` pattern in
 * `teams/agents.ts`. The `'error'` listener registered by `once` survives after
 * a successful spawn, so a later error is absorbed rather than crashing.
 */
export function spawnDetached(
  command: string,
  args: string[],
  stdio: StdioOptions = 'ignore',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio, env: process.env });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

/**
 * Default run dispatcher: re-invoke `agents run` with a server-minted id so the
 * run is addressable, detached so it outlives this request (and the anchor
 * process). Local runs detach here; `--host` runs detach on the executor via
 * the existing dispatch path.
 */
export const defaultRunner: RunDispatcher = async (req) => {
  if (!req.agent?.trim()) throw new Error('agent is required');
  if (!req.prompt?.trim()) throw new Error('prompt is required');

  const name = `ios-${randomBytes(3).toString('hex')}`;
  // claude accepts an explicit session UUID; other agents resolve by --name.
  const sessionId = req.agent === 'claude' ? randomUUID() : name;

  const argv = ['run', req.agent, req.prompt, '--json', '--headless', '--quiet', '--name', name];
  if (req.agent === 'claude') argv.push('--session-id', sessionId);
  if (req.mode) argv.push('--mode', req.mode);
  if (req.host) argv.push('--host', req.host);
  if (req.cwd) argv.push('--cwd', req.cwd);

  const inv = getAgentsInvocation(argv);
  // Await spawn/error so a failed launch becomes a clean 400, never an
  // unhandled 'error' that crashes the anchor for every other session.
  //
  // For an anchor-local run, capture the `--json` NDJSON to a per-session file
  // so `GET /api/session/:id/stream` can offset-tail it. A `--host` run emits
  // its NDJSON on the remote box (streaming that reuses pullRemoteLogDelta — a
  // follow-up), so we don't capture the local dispatcher's output.
  if (req.host) {
    await spawnDetached(inv.command, inv.args);
  } else {
    fs.mkdirSync(streamDir(), { recursive: true });
    const fd = fs.openSync(streamLogPath(sessionId), 'a');
    try {
      await spawnDetached(inv.command, inv.args, ['ignore', fd, fd]);
    } finally {
      // The child inherited the fd; the parent's copy is no longer needed.
      fs.closeSync(fd);
    }
  }
  return { sessionId, name };
};

/** Default messenger: re-invoke `agents message <id> <text>` and await its exit. */
export const defaultMessenger: Messenger = async (id, text, from) => {
  const argv = ['message', id, text];
  if (from) argv.push('--from', from);
  const inv = getAgentsInvocation(argv);
  const code: number = await new Promise((resolve) => {
    const child = spawn(inv.command, inv.args, { stdio: 'ignore', env: process.env });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });
  if (code !== 0) throw new Error(`agents message exited with code ${code}`);
};

/**
 * Create (but do not start) the authenticated control server. Caller invokes
 * `.listen(port, bind)`.
 */
export function createControlServer(opts: ControlOptions = {}): http.Server {
  const ctx = resolveServeContext(opts);
  const verify = opts.verifyToken ?? verifyControlToken;
  const runner = opts.runner ?? defaultRunner;
  const messenger = opts.messenger ?? defaultMessenger;
  const streamPollMs = opts.streamPollMs ?? DEFAULT_STREAM_POLL_MS;
  const streamLogPathFor = opts.streamLogPathFor ?? streamLogPath;

  return createServer(async (req, res) => {
    // Auth gates EVERY request — this server may be reachable off-box.
    if (!verify(presentedToken(req))) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const method = req.method ?? 'GET';
    const url = (req.url || '/').split('?')[0];

    if (method === 'GET') {
      const streamMatch = /^\/api\/session\/([^/]+)\/stream$/.exec(url);
      if (streamMatch) {
        const id = decodeURIComponent(streamMatch[1]);
        startSessionStream(streamLogPathFor(id), req, res, streamPollMs);
        return;
      }
      const handled = await handleServeGet(url, req, res, ctx);
      if (!handled) sendJson(res, 404, { error: 'not found' });
      return;
    }

    if (method === 'POST' && url === '/api/run') {
      try {
        const body = (await readJsonBody(req)) as RunRequest;
        const result = await runner(body);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, { error: String((err as Error)?.message ?? err) });
      }
      return;
    }

    const msgMatch = method === 'POST' && /^\/api\/session\/([^/]+)\/message$/.exec(url);
    if (msgMatch) {
      const id = decodeURIComponent(msgMatch[1]);
      try {
        const body = (await readJsonBody(req)) as { text?: string; from?: string };
        if (!body.text?.trim()) throw new Error('text is required');
        await messenger(id, body.text, body.from);
        sendJson(res, 200, { ok: true, id });
      } catch (err) {
        sendJson(res, 400, { error: String((err as Error)?.message ?? err) });
      }
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });
}

/** Start the control server on `port`, bound to `bind`. Resolves the bound port. */
export function startControlServer(
  port: number,
  bind: string,
  opts: ControlOptions = {},
): Promise<{ server: http.Server; port: number }> {
  const server = createControlServer(opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, port: boundPort });
    });
  });
}
