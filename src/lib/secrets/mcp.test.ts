/**
 * Tests for the JIT credential MCP server (issue #333).
 *
 * Setup mirrors bundles-file-backend.test.ts: a REAL temp-dir AES-256-GCM file
 * store (real crypto — the Linux libsecret backend's own headless / locked-
 * collection fallback) keyed by AGENTS_SECRETS_PASSPHRASE, plus an in-memory
 * keychain backend so the `listBundles` keychain branch never reaches the
 * developer's real keyring. The code under test — the MCP request handler and
 * `resolveSecret` — is NOT mocked; secrets flow through the genuine
 * readBundle -> readAndResolveBundleEnv read path.
 *
 * The guarantees pinned here: get_secret returns the value; a missing key /
 * missing bundle errors clearly; and `tools/list` advertises bundle + key NAMES
 * but never a value.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  bundleItemStore,
  keychainRef,
  writeBundle,
  type SecretsBundle,
} from './bundles.js';
import { _resetFileStoreForTest } from './filestore.js';
import {
  secretsKeychainItem,
  setKeychainBackendForTest,
  type KeychainBackend,
} from './index.js';
import {
  GET_SECRET_TOOL,
  MCP_PROTOCOL_VERSION,
  handleMcpRequest,
  listSecretMetadata,
  resolveSecret,
  runSecretsMcpServer,
} from './mcp.js';

function makeMemoryBackend(): { backend: KeychainBackend; store: Map<string, string> } {
  const store = new Map<string, string>();
  const backend: KeychainBackend = {
    has: (item) => store.has(item),
    get: (item) => {
      const v = store.get(item);
      if (v === undefined) throw new Error(`Keychain item '${item}' not found.`);
      return v;
    },
    set: (item, value) => { store.set(item, value); },
    delete: (item) => store.delete(item),
    list: (prefix) => Array.from(store.keys()).filter((k) => k.startsWith(prefix)),
  };
  return { backend, store };
}

const PASS = 'per-run-passphrase';
const SECRET_VALUE = 'resolved-jit-credential-value-abc';
let restore: KeychainBackend | null = null;
let tmpDir: string;
let prevNoAgent: string | undefined;
let prevNoTrack: string | undefined;

/** Create a file-backed bundle with one keychain-style secret + one literal. */
function createFileBundle(name: string, key: string, value: string): void {
  const bundle: SecretsBundle = { name, backend: 'file', vars: {} };
  bundleItemStore('file').set(secretsKeychainItem(name, key), value);
  bundle.vars[key] = keychainRef(key);
  bundle.vars.LOG_LEVEL = 'info'; // literal, non-sensitive
  writeBundle(bundle);
}

beforeEach(() => {
  const m = makeMemoryBackend();
  restore = setKeychainBackendForTest(m.backend);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-mcp-'));
  // Keep resolution hermetic: no secrets-agent broker, no last_used writeback.
  prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
  prevNoTrack = process.env.AGENTS_NO_USAGE_TRACK;
  process.env.AGENTS_SECRETS_NO_AGENT = '1';
  process.env.AGENTS_NO_USAGE_TRACK = '1';
  process.env.AGENTS_SECRETS_PASSPHRASE = PASS;
  _resetFileStoreForTest({ fileDir: tmpDir, passphrase: PASS });
  createFileBundle('prod', 'STRIPE_KEY', SECRET_VALUE);
});

afterEach(() => {
  setKeychainBackendForTest(restore);
  delete process.env.AGENTS_SECRETS_PASSPHRASE;
  if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
  else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
  if (prevNoTrack === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
  else process.env.AGENTS_NO_USAGE_TRACK = prevNoTrack;
  _resetFileStoreForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveSecret (real file store)', () => {
  it('returns the value for an existing bundle + key', () => {
    expect(resolveSecret('prod', 'STRIPE_KEY')).toBe(SECRET_VALUE);
  });

  it('resolves a literal value too', () => {
    expect(resolveSecret('prod', 'LOG_LEVEL')).toBe('info');
  });

  it('throws a clear error for a missing key (listing the available keys)', () => {
    expect(() => resolveSecret('prod', 'NOPE')).toThrow(/Key 'NOPE' not found in bundle 'prod'/);
    expect(() => resolveSecret('prod', 'NOPE')).toThrow(/STRIPE_KEY/); // lists what IS there
  });

  it('throws for a missing bundle', () => {
    expect(() => resolveSecret('ghost', 'STRIPE_KEY')).toThrow(/not found/i);
  });
});

describe('tools/call get_secret', () => {
  const call = (bundle: unknown, key: unknown) =>
    handleMcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: GET_SECRET_TOOL, arguments: { bundle, key } },
    });

  it('returns the value in the tool result content', () => {
    const res = call('prod', 'STRIPE_KEY') as any;
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content).toEqual([{ type: 'text', text: SECRET_VALUE }]);
  });

  it('reports a missing key as an in-band tool error (isError), not a value', () => {
    const res = call('prod', 'MISSING') as any;
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/Key 'MISSING' not found/);
    expect(res.result.content[0].text).not.toContain(SECRET_VALUE);
  });

  it('reports a missing bundle as an in-band tool error', () => {
    const res = call('ghost', 'STRIPE_KEY') as any;
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/not found/i);
  });

  it('validates that bundle and key are non-empty strings', () => {
    const res = call('prod', '') as any;
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/requires non-empty string/);
  });
});

describe('tools/list (names only, never values)', () => {
  it('advertises the get_secret tool with bundle + key names but no value', () => {
    const res = handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as any;
    const tools = res.result.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe(GET_SECRET_TOOL);
    expect(tools[0].inputSchema.required).toEqual(['bundle', 'key']);

    // Names are advertised...
    const serialized = JSON.stringify(res);
    expect(serialized).toContain('prod');
    expect(serialized).toContain('STRIPE_KEY');
    // ...but the secret VALUE never appears anywhere in the listing.
    expect(serialized).not.toContain(SECRET_VALUE);
  });

  it('listSecretMetadata surfaces key names but carries no value', () => {
    const meta = listSecretMetadata();
    const prod = meta.find((m) => m.bundle === 'prod');
    expect(prod?.keys).toContain('STRIPE_KEY');
    expect(JSON.stringify(meta)).not.toContain(SECRET_VALUE);
  });
});

describe('protocol handshake', () => {
  it('initialize negotiates the protocol version and reports serverInfo', () => {
    const res = handleMcpRequest(
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
      { version: '9.9.9' },
    ) as any;
    expect(res.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(res.result.capabilities.tools).toBeDefined();
    expect(res.result.serverInfo.version).toBe('9.9.9');
  });

  it('notifications/initialized gets no reply', () => {
    expect(handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('unknown method returns a JSON-RPC method-not-found error', () => {
    const res = handleMcpRequest({ jsonrpc: '2.0', id: 5, method: 'no/such' }) as any;
    expect(res.error.code).toBe(-32601);
  });
});

describe('stdio transport end-to-end', () => {
  it('drives initialize + tools/call over newline-delimited JSON-RPC', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (c) => chunks.push(Buffer.from(c)));

    const done = runSecretsMcpServer({ input, output, version: '1.2.3' });

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: GET_SECRET_TOOL, arguments: { bundle: 'prod', key: 'STRIPE_KEY' } },
      }) + '\n',
    );
    input.end();
    await done;

    const lines = Buffer.concat(chunks).toString('utf8').trim().split('\n').filter(Boolean);
    const msgs = lines.map((l) => JSON.parse(l));
    expect(msgs[0].result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(msgs[1].result.content).toEqual([{ type: 'text', text: SECRET_VALUE }]);
  });
});
