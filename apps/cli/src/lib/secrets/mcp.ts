/**
 * Zero-knowledge / JIT secret delivery over MCP (issue #333).
 *
 * A stdio MCP server exposing a single `get_secret(bundle, key)` tool. Unlike
 * `agents secrets exec`, which spawns the child process with EVERY resolved
 * value baked into `process.env` (any subprocess can `printenv` the lot — see
 * buildSecretsExecEnv in src/commands/secrets.ts), this server hands an
 * MCP-speaking agent framework ONE credential at a time, by name, at call
 * time. The raw value is returned only inside the tool result: it never enters
 * the child's environment, is never logged, and never appears in `tools/list`
 * metadata (names only).
 *
 * Resolution reuses the canonical bundle read path
 * (readAndResolveBundleEnv -> getKeychainToken); no keychain access is
 * re-implemented here. On Linux the libsecret backend (or its encrypted-file
 * fallback for locked/headless collections) applies transparently through that
 * abstraction, so the server stays backend-agnostic and works unchanged on
 * macOS.
 *
 * Transport: the MCP stdio transport is newline-delimited JSON-RPC 2.0 (one
 * message per line, UTF-8, no embedded newlines). That framing is trivial, so
 * we implement it directly rather than pull in the @modelcontextprotocol/sdk
 * server dependency — keeping the tree dependency-free and the handler pure and
 * unit-testable in-process.
 */

import * as readline from 'readline';
import {
  listBundles,
  readAndResolveBundleEnv,
  isHeadlessSecretsContext,
  readBundle,
  validateBundleName,
} from './bundles.js';

/** MCP protocol revision this server negotiates. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';
/** The single tool this server exposes. */
export const GET_SECRET_TOOL = 'get_secret';
/** serverInfo.name reported at `initialize`. */
export const MCP_SERVER_NAME = 'agents-secrets';

// JSON-RPC 2.0 error codes we use.
const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcErrorResponse;

/** Per-bundle metadata for `tools/list` — names only, NEVER values. */
export interface BundleKeyMetadata {
  bundle: string;
  description?: string;
  keys: string[];
}

/**
 * Enumerate every bundle and its key names WITHOUT resolving or reading any
 * value. Mirrors how `agents secrets list` surfaces bundle metadata: names are
 * safe to expose, values are not. `listBundles()` reads only the bundle
 * metadata items (var definitions), never the secret items behind them.
 */
export function listSecretMetadata(): BundleKeyMetadata[] {
  return listBundles()
    .map((b) => ({
      bundle: b.name,
      description: b.description,
      keys: Object.keys(b.vars).sort(),
    }))
    .sort((a, b) => a.bundle.localeCompare(b.bundle));
}

/**
 * Resolve a single secret value by bundle + key through the canonical read
 * path. Throws a clear error when the bundle or the key is absent.
 *
 * The bundle metadata is read first (readBundle) so a missing key is reported
 * without triggering resolution — and, on macOS, without prompting Touch ID —
 * for the other keys in the bundle.
 */
export function resolveSecret(bundle: string, key: string): string {
  validateBundleName(bundle);
  // readBundle throws `Secrets bundle '<name>' not found.` for a missing bundle.
  const meta = readBundle(bundle);
  if (!Object.prototype.hasOwnProperty.call(meta.vars, key)) {
    const available = Object.keys(meta.vars).sort();
    throw new Error(
      `Key '${key}' not found in bundle '${bundle}'.` +
        (available.length ? ` Available keys: ${available.join(', ')}.` : ' Bundle has no keys.'),
    );
  }
  // The MCP get_secret tool is typically served by a background/headless agent
  // process; resolve broker-only there so it never raises an unwatched prompt.
  const { env } = readAndResolveBundleEnv(bundle, { caller: 'secrets-mcp', agentOnly: isHeadlessSecretsContext() });
  const value = env[key];
  if (value === undefined) {
    throw new Error(`Key '${key}' in bundle '${bundle}' could not be resolved.`);
  }
  return value;
}

/** Build the `get_secret` tool definition, advertising available names only. */
function getSecretToolDefinition() {
  let catalog = '(no bundles configured)';
  try {
    const meta = listSecretMetadata();
    if (meta.length > 0) {
      catalog = meta
        .map((b) => `${b.bundle}: ${b.keys.length ? b.keys.join(', ') : '(no keys)'}`)
        .join(' | ');
    }
  } catch {
    // Listing is best-effort decoration; never fail tools/list because the
    // keychain enumeration hiccuped.
    catalog = '(unavailable)';
  }
  return {
    name: GET_SECRET_TOOL,
    description:
      'Fetch a single secret value by bundle + key, resolved at call time. The value ' +
      'is returned only in this tool result and never enters the process environment. ' +
      `Available bundles and keys (names only): ${catalog}`,
    inputSchema: {
      type: 'object',
      properties: {
        bundle: { type: 'string', description: 'Secrets bundle name' },
        key: { type: 'string', description: 'Key / env-var name within the bundle' },
      },
      required: ['bundle', 'key'],
      additionalProperties: false,
    },
  };
}

function success(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * A tool-execution failure. Per the MCP spec, tool errors are reported IN the
 * result (`isError: true`) — not as a JSON-RPC error — so the model sees and
 * can react to the message. The value channel (`content`) still carries no
 * secret here.
 */
function toolError(id: string | number | null, message: string): JsonRpcSuccess {
  return success(id, { content: [{ type: 'text', text: message }], isError: true });
}

function handleToolCall(id: string | number | null, params: unknown): JsonRpcResponse {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (p.name !== GET_SECRET_TOOL) {
    return rpcError(id, JSONRPC_INVALID_PARAMS, `Unknown tool: ${String(p.name)}`);
  }
  const args = (p.arguments ?? {}) as { bundle?: unknown; key?: unknown };
  if (typeof args.bundle !== 'string' || !args.bundle || typeof args.key !== 'string' || !args.key) {
    return toolError(id, `${GET_SECRET_TOOL} requires non-empty string 'bundle' and 'key' arguments.`);
  }
  try {
    const value = resolveSecret(args.bundle, args.key);
    return success(id, { content: [{ type: 'text', text: value }] });
  } catch (err) {
    return toolError(id, (err as Error).message);
  }
}

/**
 * Handle one parsed JSON-RPC request. Returns the response object, or `null`
 * for notifications (which take no reply). Pure — no I/O, no logging — so tests
 * drive it directly.
 */
export function handleMcpRequest(
  req: JsonRpcRequest,
  ctx: { version?: string } = {},
): JsonRpcResponse | null {
  const id = req.id ?? null;
  const isNotification = req.id === undefined || req.id === null;
  switch (req.method) {
    case 'initialize':
      return success(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: ctx.version ?? '0.0.0' },
      });
    case 'notifications/initialized':
    case 'initialized':
      return null; // notification — no response
    case 'ping':
      return success(id, {});
    case 'tools/list':
      return success(id, { tools: [getSecretToolDefinition()] });
    case 'tools/call':
      return handleToolCall(id, req.params);
    default:
      if (isNotification) return null; // unknown notification — stay silent
      return rpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${String(req.method)}`);
  }
}

function writeMessage(output: NodeJS.WritableStream, msg: JsonRpcResponse): void {
  output.write(JSON.stringify(msg) + '\n');
}

/**
 * Run the stdio MCP server: read newline-delimited JSON-RPC requests from
 * `input`, write responses to `output`. Resolves when the input stream ends.
 * Streams are injectable so tests can drive a full request/response loop
 * without spawning a process.
 */
export async function runSecretsMcpServer(
  opts: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; version?: string } = {},
): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      writeMessage(output, rpcError(null, JSONRPC_PARSE_ERROR, 'Parse error'));
      continue;
    }
    if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
      writeMessage(output, rpcError((req && req.id) ?? null, JSONRPC_INVALID_REQUEST, 'Invalid Request'));
      continue;
    }
    const res = handleMcpRequest(req, { version: opts.version });
    if (res) writeMessage(output, res);
  }
}
