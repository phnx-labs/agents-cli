/**
 * secrets-client.ts — the ONE process client through which agents-cli talks to
 * the standalone `secrets` CLI (PHNX-3989).
 *
 * This is the agents-owned half of the secrets extraction: a bounded
 * request/response client over the standalone executable's private consumer
 * pipe. It carries NO storage, provider, or broker implementation — every
 * operation is resolved by spawning `secrets __serve` and exchanging one JSON
 * message over inherited pipes (delta-spec RPC-1). The engine lives entirely in
 * the standalone package; agents-cli never rebundles it (DIST-1), so there is
 * deliberately NO fallback to the in-repo `cli/src/lib/secrets/` engine — a
 * missing executable fails loud with install guidance.
 *
 * Transport (matches secrets-cli/src/protocol-server.ts `runProtocolServer`):
 *   - the child reads the request JSON from fd 3 (to EOF) and writes the
 *     response JSON to fd 4; nothing is ever written to the child's stdout.
 *   - async: `spawn` with stdio ['ignore','ignore','inherit','pipe','pipe'];
 *     write+end child.stdio[3], read child.stdio[4] to EOF.
 *   - sync: Node exposes no synchronous `pipe(2)`, and `spawnSync` only feeds
 *     stdin — so the request rides a named FIFO handed to the child as fd 3,
 *     while the response is captured through `spawnSync`'s own fd-4 pipe (which
 *     it drains concurrently, so a large reply never deadlocks). POSIX only;
 *     Windows has no `mkfifo` and fails loud pointing at the async path.
 *
 * State root (MIG-1): the standalone selects its state root from `SECRETS_HOME`.
 * agents-cli points it at the user agents dir (`~/.agents`) by default so the
 * user's existing stores are adopted in place — no copy, no re-encryption. An
 * explicit `SECRETS_HOME` in the environment wins (test isolation, power users),
 * matching the standalone's own `state.ts` precedence.
 *
 * Policy (CTX-1): agents-cli passes its harness name as the opaque `scope` and,
 * when a request must be bounded, a resource-profile-filtered `allowedBundles`
 * set. Computing that policy stays in agents-cli (the caller supplies `context`);
 * this client only forwards it.
 *
 * The typed shapes are imported `type`-only from the in-repo engine so this
 * client's wrappers are exactly the shapes today's consumers pass and receive,
 * making the consumer-conversion wave (tasks.md item 6) a drop-in. `import type`
 * is fully erased at compile time, so it adds no runtime edge and nothing to the
 * npm tarball — DIST-1 holds. When the engine is deleted, repoint these type
 * imports at the published `@phnx-labs/secrets-cli` SDK types.
 */
import { spawn, spawnSync } from 'node:child_process';
import { openSync, writeSync, closeSync, mkdtempSync, rmSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { findExecutable } from './platform/exec.js';
import { getUserAgentsDir } from './state.js';
import type {
  SecretsBundle,
  SecretsBackend,
  ResolveBundleOptions,
  WriteBundleOptions,
} from './secrets/bundles.js';
import type { KeychainReadContext } from './secrets/index.js';
import type { AgentStatusEntry } from './secrets/agent.js';
import type { PushBundleOptions, PushBundleResult } from './secrets/push.js';

/**
 * Wire contract, mirrored from `secrets-cli/src/protocol.ts`. Both sides MUST
 * agree byte-for-byte; this is the shared schema of the seam, the one thing an
 * independent client legitimately re-declares rather than imports.
 */
export const PROTOCOL_VERSION = 1;
const MAX_PROTOCOL_BYTES = 8 * 1024 * 1024;
/** Just over the server's own 60s deadline, so the server times out first. */
const SERVE_TIMEOUT_MS = 65_000;
/**
 * The synchronous path pre-fills a FIFO before the child drains it, so the
 * request must fit the OS pipe buffer (≥64 KiB everywhere agents-cli runs). A
 * larger synchronous request is an error, not a silent hang — use the async
 * path, whose stream backpressure has no such bound.
 */
const SYNC_REQUEST_MAX_BYTES = 60_000;

export interface SecretsContext {
  /** Bundle allowlist; absent ⇒ full trust (the local agents client today). */
  allowedBundles?: string[];
  /** Opaque scope the standalone folds into resolution — the harness name. */
  scope?: string;
}

interface ProtocolRequest {
  v: 1;
  id: string;
  op: string;
  args: unknown[];
  context?: SecretsContext;
}
type ProtocolResponse =
  | { v: 1; id: string; ok: true; result: unknown }
  | { v: 1; id: string; ok: false; error: { code: string; message: string } };

/** Serialize `Map`s the way the server's `decodeWire` expects to receive them. */
export function encodeWire(value: unknown): unknown {
  if (value instanceof Map) {
    return { $map: [...value.entries()].map(([key, item]) => [key, encodeWire(item)]) };
  }
  if (Array.isArray(value)) return value.map(encodeWire);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeWire(item)]));
  }
  return value === undefined ? null : value;
}

/** Reconstruct `Map`s from the server's `encodeWire`'d reply. */
export function decodeWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWire);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length === 1 && Array.isArray(object.$map)) {
      if (object.$map.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')) {
        throw new SecretsClientError('INVALID_RESPONSE', 'Invalid map encoding in secrets response');
      }
      return new Map((object.$map as [string, unknown][]).map(([key, item]) => [key, decodeWire(item)]));
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, decodeWire(item)]));
  }
  return value;
}

/** Carries the server's `{code, message}`, or a client-side transport code. */
export class SecretsClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SecretsClientError';
  }
}

// --- executable resolution -------------------------------------------------

let cachedBin: string | undefined;

/**
 * Resolve the standalone `secrets` executable: `$SECRETS_BIN` if set, else the
 * `secrets` command on PATH. Cached for the process. A miss throws with install
 * guidance — there is NO fallback to the embedded engine (DIST-1).
 */
export function resolveSecretsBin(): string {
  if (cachedBin) return cachedBin;
  const explicit = process.env.SECRETS_BIN?.trim();
  const resolved = explicit && explicit.length > 0 ? explicit : findExecutable('secrets');
  if (!resolved) {
    throw new SecretsClientError(
      'SECRETS_BIN_MISSING',
      'The standalone `secrets` CLI was not found. Install it with:\n' +
        '  npm i -g @phnx-labs/secrets-cli\n' +
        'or point $SECRETS_BIN at its executable.',
    );
  }
  cachedBin = resolved;
  return resolved;
}

/**
 * How to invoke the resolved binary. A `.js`/`.mjs`/`.cjs` entrypoint (a dev
 * build, or `$SECRETS_BIN` pointing at `dist/index.js`) is run through this
 * process's Node so it works without an executable bit and on Windows; an
 * installed `secrets` shim/binary is spawned directly.
 */
function invocation(bin: string): { command: string; prefix: string[] } {
  if (/\.[mc]?js$/.test(bin)) return { command: process.execPath, prefix: [bin] };
  return { command: bin, prefix: [] };
}

/**
 * Spawn env for the child: default `SECRETS_HOME` to the user agents dir so the
 * standalone adopts the existing stores in place (MIG-1), letting an explicit
 * value win.
 */
function serveEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SECRETS_HOME: process.env.SECRETS_HOME ?? getUserAgentsDir(),
  };
}

let requestCounter = 0;
function buildRequest(op: string, args: unknown[], context?: SecretsContext): ProtocolRequest {
  requestCounter += 1;
  const request: ProtocolRequest = {
    v: PROTOCOL_VERSION,
    id: `${process.pid}-${requestCounter}`,
    op,
    args: encodeWire(args) as unknown[],
  };
  if (context) request.context = context;
  return request;
}

function parseResponse(raw: Buffer): unknown {
  let parsed: ProtocolResponse;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as ProtocolResponse;
  } catch {
    throw new SecretsClientError('INVALID_RESPONSE', 'secrets returned a non-JSON response');
  }
  if (!parsed || parsed.v !== PROTOCOL_VERSION || typeof parsed.id !== 'string') {
    throw new SecretsClientError('INVALID_RESPONSE', 'secrets returned a malformed response envelope');
  }
  if (parsed.ok) return decodeWire(parsed.result);
  throw new SecretsClientError(parsed.error.code, parsed.error.message);
}

// --- raw transport (one spawn per request) ---------------------------------

function serveOnce(op: string, args: unknown[], context?: SecretsContext): Promise<unknown> {
  const { command, prefix } = invocation(resolveSecretsBin());
  const request = Buffer.from(JSON.stringify(buildRequest(op, args, context)));
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, '__serve'], {
      stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'],
      env: serveEnv(),
    });
    let settled = false;
    const fail = (error: SecretsClientError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new SecretsClientError('TIMEOUT', 'secrets request timed out')),
      SERVE_TIMEOUT_MS,
    );
    child.on('error', (error) =>
      fail(new SecretsClientError('SPAWN_FAILED', `Failed to spawn secrets: ${error.message}`)),
    );
    // A child that dies before reading gives EPIPE here; the outcome surfaces on
    // fd 4 / 'error' instead, so this handler just keeps it from throwing.
    const input = child.stdio[3] as Writable;
    input.on('error', () => {});
    input.end(request);

    const out = child.stdio[4] as Readable;
    const chunks: Buffer[] = [];
    let size = 0;
    out.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROTOCOL_BYTES) {
        fail(new SecretsClientError('RESPONSE_TOO_LARGE', 'secrets response exceeds the protocol limit'));
        return;
      }
      chunks.push(chunk);
    });
    out.on('error', (error) => fail(new SecretsClientError('IO_ERROR', error.message)));
    out.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(parseResponse(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function serveOnceSync(op: string, args: unknown[], context?: SecretsContext): unknown {
  if (process.platform === 'win32') {
    throw new SecretsClientError(
      'SYNC_UNSUPPORTED',
      'The synchronous secrets path needs a POSIX FIFO; use secretsRequest (async) on Windows.',
    );
  }
  const { command, prefix } = invocation(resolveSecretsBin());
  const request = Buffer.from(JSON.stringify(buildRequest(op, args, context)));
  if (request.length > SYNC_REQUEST_MAX_BYTES) {
    throw new SecretsClientError(
      'REQUEST_TOO_LARGE',
      'Synchronous secrets request exceeds the pipe-buffer bound; use secretsRequest (async).',
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'agents-secrets-'));
  const fifo = join(dir, 'req');
  const mk = spawnSync('mkfifo', [fifo]);
  if (mk.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new SecretsClientError('SYNC_UNSUPPORTED', 'mkfifo is unavailable for the synchronous secrets path');
  }
  // Open the FIFO O_RDWR so neither open blocks on the counterpart, hand the
  // child a dedicated read end, then close our writer to signal EOF.
  let readEnd = -1;
  try {
    const writeEnd = openSync(fifo, constants.O_RDWR);
    readEnd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    writeSync(writeEnd, request);
    closeSync(writeEnd);
    const result = spawnSync(command, [...prefix, '__serve'], {
      stdio: ['ignore', 'ignore', 'inherit', readEnd, 'pipe'],
      env: serveEnv(),
      timeout: SERVE_TIMEOUT_MS,
      maxBuffer: MAX_PROTOCOL_BYTES + 4096,
    });
    if (result.error) {
      const err = result.error as NodeJS.ErrnoException;
      const code = err.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'SPAWN_FAILED';
      throw new SecretsClientError(code, `secrets request failed: ${err.message}`);
    }
    return parseResponse(result.output?.[4] ?? Buffer.alloc(0));
  } finally {
    if (readEnd >= 0) {
      try {
        closeSync(readEnd);
      } catch {
        /* already closed */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- handshake (once per process) ------------------------------------------

let handshakeReady = false;
let handshakePromise: Promise<void> | null = null;

function checkHandshake(result: unknown): void {
  const protocol = (result as { protocol?: unknown } | null)?.protocol;
  if (protocol !== PROTOCOL_VERSION) {
    throw new SecretsClientError(
      'PROTOCOL_UNSUPPORTED',
      `secrets speaks protocol ${String(protocol)}; this agents-cli needs ${PROTOCOL_VERSION}. ` +
        'Update the standalone CLI (npm i -g @phnx-labs/secrets-cli).',
    );
  }
}

async function ensureHandshake(): Promise<void> {
  if (handshakeReady) return;
  if (!handshakePromise) {
    handshakePromise = (async () => {
      checkHandshake(await serveOnce('handshake', []));
      handshakeReady = true;
    })().catch((error) => {
      handshakePromise = null;
      throw error;
    });
  }
  await handshakePromise;
}

function ensureHandshakeSync(): void {
  if (handshakeReady) return;
  checkHandshake(serveOnceSync('handshake', []));
  handshakeReady = true;
}

// --- primitives ------------------------------------------------------------

/**
 * Send one operation to the standalone secrets CLI and await its typed result.
 * Verifies the executable speaks protocol v1 once per process (cached), then
 * spawns `secrets __serve` for the operation. Throws a {@link SecretsClientError}
 * carrying the server's `{code, message}` on failure.
 */
export async function secretsRequest<T = unknown>(
  op: string,
  args: unknown[] = [],
  context?: SecretsContext,
): Promise<T> {
  await ensureHandshake();
  return (await serveOnce(op, args, context)) as T;
}

/**
 * Synchronous sibling of {@link secretsRequest} for the consumers that resolve
 * secrets on a synchronous path (e.g. building a child env before spawn).
 * Bounded by a spawn timeout. POSIX only.
 */
export function secretsRequestSync<T = unknown>(
  op: string,
  args: unknown[] = [],
  context?: SecretsContext,
): T {
  ensureHandshakeSync();
  return serveOnceSync(op, args, context) as T;
}

/** Test hook: forget the cached binary + handshake so a new env is re-resolved. */
export function _resetSecretsClientForTest(): void {
  cachedBin = undefined;
  handshakeReady = false;
  handshakePromise = null;
  requestCounter = 0;
}

// --- typed wrappers (only the ops the inventory shows consumers using) ------
//
// Async by default; the read-hot operations agents-cli resolves synchronously
// carry a `*Sync` sibling. Each is a thin, typed forward onto the two
// primitives above — the standalone remains the single implementation.

// bundles.*
export function readAndResolveBundleEnv(
  name: string,
  opts?: ResolveBundleOptions,
  context?: SecretsContext,
): Promise<{ bundle: SecretsBundle; env: Record<string, string> }> {
  return secretsRequest('bundles.readAndResolveBundleEnv', [name, opts ?? {}], context);
}
export function readAndResolveBundleEnvSync(
  name: string,
  opts?: ResolveBundleOptions,
  context?: SecretsContext,
): { bundle: SecretsBundle; env: Record<string, string> } {
  return secretsRequestSync('bundles.readAndResolveBundleEnv', [name, opts ?? {}], context);
}

export function listBundles(context?: SecretsContext): Promise<SecretsBundle[]> {
  return secretsRequest('bundles.listBundles', [], context);
}

export function readBundle(name: string, context?: SecretsContext): Promise<SecretsBundle> {
  return secretsRequest('bundles.readBundle', [name], context);
}

export function bundleExists(name: string, context?: SecretsContext): Promise<boolean> {
  return secretsRequest('bundles.bundleExists', [name], context);
}
export function bundleExistsSync(name: string, context?: SecretsContext): boolean {
  return secretsRequestSync('bundles.bundleExists', [name], context);
}

export function writeBundle(
  bundle: SecretsBundle,
  opts?: WriteBundleOptions,
  context?: SecretsContext,
): Promise<void> {
  return secretsRequest('bundles.writeBundle', [bundle, opts ?? {}], context);
}

export function writeBundleWithItems(
  bundle: SecretsBundle,
  items: Map<string, string>,
  opts?: WriteBundleOptions,
  context?: SecretsContext,
): Promise<void> {
  return secretsRequest('bundles.writeBundleWithItems', [bundle, items, opts ?? {}], context);
}

export function deleteBundle(name: string, context?: SecretsContext): Promise<boolean> {
  return secretsRequest('bundles.deleteBundle', [name], context);
}

// agent.*
export function agentPing(): Promise<{ reachable: boolean; cliVersion?: string }> {
  return secretsRequest('agent.agentPing', []);
}
export function agentPingSync(): { reachable: boolean; cliVersion?: string } {
  return secretsRequestSync('agent.agentPing', []);
}

export function agentStatus(): Promise<AgentStatusEntry[]> {
  return secretsRequest('agent.agentStatus', []);
}

export function agentLock(name?: string): Promise<number> {
  return secretsRequest('agent.agentLock', name === undefined ? [] : [name]);
}

export function ensureAgentRunning(timeoutMs?: number): Promise<boolean> {
  return secretsRequest('agent.ensureAgentRunning', timeoutMs === undefined ? [] : [timeoutMs]);
}

// index.* (keychain items)
export function getKeychainToken(item: string, context?: KeychainReadContext): Promise<string> {
  return secretsRequest('index.getKeychainToken', [item, context ?? {}]);
}
export function getKeychainTokenSync(item: string, context?: KeychainReadContext): string {
  return secretsRequestSync('index.getKeychainToken', [item, context ?? {}]);
}

export function setKeychainToken(item: string, value: string, opts?: { noAcl?: boolean }): Promise<void> {
  return secretsRequest('index.setKeychainToken', opts === undefined ? [item, value] : [item, value, opts]);
}

export function hasKeychainToken(item: string): Promise<boolean> {
  return secretsRequest('index.hasKeychainToken', [item]);
}
export function hasKeychainTokenSync(item: string): boolean {
  return secretsRequestSync('index.hasKeychainToken', [item]);
}

export function deleteKeychainToken(item: string): Promise<boolean> {
  return secretsRequest('index.deleteKeychainToken', [item]);
}

export function listKeychainItems(prefix: string): Promise<string[]> {
  return secretsRequest('index.listKeychainItems', [prefix]);
}

// store.* (explicit-backend raw item CRUD)
export function storeGet(backend: SecretsBackend, item: string): Promise<string> {
  return secretsRequest('store.get', [backend, item]);
}
export function storeGetSync(backend: SecretsBackend, item: string): string {
  return secretsRequestSync('store.get', [backend, item]);
}

export function storeHas(backend: SecretsBackend, item: string): Promise<boolean> {
  return secretsRequest('store.has', [backend, item]);
}
export function storeHasSync(backend: SecretsBackend, item: string): boolean {
  return secretsRequestSync('store.has', [backend, item]);
}

export function storeSet(backend: SecretsBackend, item: string, value: string): Promise<void> {
  return secretsRequest('store.set', [backend, item, value]);
}

export function storeDelete(backend: SecretsBackend, item: string): Promise<boolean> {
  return secretsRequest('store.delete', [backend, item]);
}

// remote.* / push.*
export function remoteResolveEnv(
  target: string,
  bundle: string,
  opts?: { osLookupName?: string },
): Promise<Record<string, string>> {
  return secretsRequest('remote.remoteResolveEnv', [target, bundle, opts ?? {}]);
}

export function pushBundleToHost(
  bundle: string,
  host: string,
  opts: PushBundleOptions,
): Promise<PushBundleResult> {
  return secretsRequest('push.pushBundleToHost', [bundle, host, opts]);
}

export function pushBundleToHostAsync(
  bundle: string,
  host: string,
  opts: PushBundleOptions,
): Promise<PushBundleResult> {
  return secretsRequest('push.pushBundleToHostAsync', [bundle, host, opts]);
}
