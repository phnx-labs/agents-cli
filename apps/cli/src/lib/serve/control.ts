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
import { spawn } from 'child_process';
import { randomUUID, randomBytes } from 'crypto';
import { getAgentsInvocation } from '../daemon.js';
import { handleServeGet, resolveServeContext, type ServeOptions } from './server.js';
import { verifyControlToken } from './token.js';

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
}

const MAX_BODY_BYTES = 64 * 1024;

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
 * Spawn a detached child and settle once it has either successfully spawned or
 * failed to. Attaching an `'error'` listener is mandatory: a `ChildProcess` is
 * an `EventEmitter`, so an `'error'` event (e.g. ENOENT from a stale/missing
 * `agents` binary — a real condition `validateDaemonBinary` guards against)
 * with no listener throws and would take down the whole anchor process, not
 * just the one request. Mirrors the `once('spawn') / once('error')` pattern in
 * `teams/agents.ts`. The `'error'` listener registered by `once` survives after
 * a successful spawn, so a later error is absorbed rather than crashing.
 */
export function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env: process.env });
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
  await spawnDetached(inv.command, inv.args);
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
