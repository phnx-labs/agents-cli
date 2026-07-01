import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock only spawnSync; keep execSync et al. real so the filestore fallback
// (which uses execSync for the TTY prompt) still loads. Pattern mirrors
// remote.test.ts:4-18 (vi.hoisted + vi.mock with importActual).
const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawnSync: spawnSyncMock };
});

import {
  parseWindowsCredList,
  windowsBackend,
  getCredManToken,
  setCredManToken,
  CRED_MAX_CREDENTIAL_BLOB_SIZE,
  _resetForTest,
} from './windows.js';

const PREFIX = 'agents-cli.bundles.';

// ---- spawnSync dispatch harness ----
type Resp = { status: number; stdout?: string; stderr?: string; error?: Error };
let responder: (op: string, ctx: { env: any; input?: string }) => Resp;

let tmpDir: string;

beforeEach(() => {
  responder = () => { throw new Error('unexpected spawnSync in this test'); };
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation((_cmd: string, _args: string[], options: any) => {
    const op = options?.env?.AGENTS_CRED_OP;
    if (!op) return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }; // availability probe
    const r = responder(op, { env: options.env, input: options.input });
    return {
      status: r.status,
      stdout: Buffer.from(r.stdout ?? ''),
      stderr: Buffer.from(r.stderr ?? ''),
      error: r.error,
    };
  });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-win-'));
  delete process.env.AGENTS_SECRETS_PASSPHRASE;
});

afterEach(() => {
  _resetForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// (a) pure parser
describe('parseWindowsCredList', () => {
  it('returns [] on empty output', () => {
    expect(parseWindowsCredList('', PREFIX)).toEqual([]);
    expect(parseWindowsCredList('\n\n', PREFIX)).toEqual([]);
  });

  it('filters by prefix and trims CRLF', () => {
    const out = [
      'agents-cli.bundles.demo',
      'agents-cli.secrets.demo.API_KEY',
      'some-other-app/token',
      'agents-cli.bundles.prod',
    ].join('\r\n');
    expect(parseWindowsCredList(out, PREFIX)).toEqual([
      'agents-cli.bundles.demo',
      'agents-cli.bundles.prod',
    ]);
  });

  it('dedupes repeated target names', () => {
    const out = [
      'agents-cli.bundles.alpha',
      'agents-cli.bundles.beta',
      'agents-cli.bundles.alpha',
    ].join('\n');
    expect(parseWindowsCredList(out, PREFIX)).toEqual([
      'agents-cli.bundles.alpha',
      'agents-cli.bundles.beta',
    ]);
  });
});

// (b) base64 get-output round-trip
describe('get base64 decode', () => {
  const cases = [
    'plain-token',
    'unicode: café ☕ 日本語',
    'has=equals=signs==',
    '  leading and trailing spaces kept-internally  ',
    'sk-proj-AbC123/xyz+789',
  ];
  for (const value of cases) {
    it(`round-trips ${JSON.stringify(value)}`, () => {
      _resetForTest({ forceAvailable: true, fileDir: tmpDir });
      const b64 = Buffer.from(value, 'utf8').toString('base64');
      responder = (op) => {
        expect(op).toBe('get');
        return { status: 0, stdout: b64 };
      };
      // Whitespace values still decode faithfully; only the base64 wire form is trimmed.
      expect(getCredManToken('agents-cli.secrets.demo.KEY')).toBe(value);
    });
  }
});

// (c) dispatch + fallback routing
describe('CredMan dispatch', () => {
  it('routes has/get/set/delete/list to the PS ops on success', () => {
    _resetForTest({ forceAvailable: true, fileDir: tmpDir });

    responder = (op, ctx) => {
      switch (op) {
        case 'has':
          expect(ctx.env.AGENTS_CRED_TARGET).toBe('agents-cli.bundles.demo');
          return { status: 0 };
        case 'get':
          return { status: 0, stdout: Buffer.from('hello', 'utf8').toString('base64') };
        case 'set':
          expect(ctx.input).toBe('secret-value');
          return { status: 0 };
        case 'delete':
          return { status: 0 };
        case 'list':
          expect(ctx.env.AGENTS_CRED_PREFIX).toBe(PREFIX);
          return { status: 0, stdout: 'agents-cli.bundles.demo\nagents-cli.bundles.prod\n' };
        default:
          throw new Error(`unexpected op ${op}`);
      }
    };

    expect(windowsBackend.has('agents-cli.bundles.demo')).toBe(true);
    expect(windowsBackend.get('agents-cli.secrets.demo.KEY')).toBe('hello');
    windowsBackend.set('agents-cli.secrets.demo.KEY', 'secret-value');
    expect(windowsBackend.delete('agents-cli.bundles.demo')).toBe(true);
    expect(windowsBackend.list(PREFIX)).toEqual([
      'agents-cli.bundles.demo',
      'agents-cli.bundles.prod',
    ]);
  });

  it('reports clean not-found (exit 3) as false/throw without fallback', () => {
    _resetForTest({ forceAvailable: true, fileDir: tmpDir });
    responder = (op) => ({ status: 3 });
    expect(windowsBackend.has('agents-cli.bundles.missing')).toBe(false);
    expect(windowsBackend.delete('agents-cli.bundles.missing')).toBe(false);
    expect(() => windowsBackend.get('agents-cli.bundles.missing')).toThrow(/not found/i);
  });

  it('falls back to the encrypted file store on ERROR_NO_SUCH_LOGON_SESSION (1312)', () => {
    _resetForTest({ forceAvailable: true, fileDir: tmpDir, passphrase: 'test-pass' });
    const item = 'agents-cli.secrets.demo.KEY';

    // First a set: CredMan reports 1312 -> value lands in the file store instead.
    responder = (op) => ({ status: 1, stderr: 'CredMan error 1312' });
    windowsBackend.set(item, 'file-routed-value');

    // Once the fallback is active, subsequent ops don't spawn PowerShell at all.
    responder = () => { throw new Error('should not spawn after fallback'); };
    expect(windowsBackend.has(item)).toBe(true);
    expect(windowsBackend.get(item)).toBe('file-routed-value');
    expect(windowsBackend.list('agents-cli.secrets.demo.')).toEqual([item]);
    expect(windowsBackend.delete(item)).toBe(true);
    expect(windowsBackend.has(item)).toBe(false);

    // The encrypted file really exists on disk (ciphertext, not plaintext).
    _resetForTest({ forceAvailable: true, fileDir: tmpDir, passphrase: 'test-pass' });
    responder = (op) => ({ status: 1, stderr: 'CredMan error 1312' });
    windowsBackend.set(item, 'persisted');
    const enc = fs.readFileSync(path.join(tmpDir, `${item}.enc`), 'utf8');
    expect(enc).not.toContain('persisted');
    expect(JSON.parse(enc)).toHaveProperty('ciphertext');
  });
});

// (d) blob-size guard
describe('CRED_MAX_CREDENTIAL_BLOB_SIZE guard', () => {
  it('throws a clear error before spawning when the value exceeds the limit', () => {
    _resetForTest({ forceAvailable: true, fileDir: tmpDir });
    responder = () => { throw new Error('guard should throw before spawnSync'); };
    const big = 'x'.repeat(CRED_MAX_CREDENTIAL_BLOB_SIZE + 1);
    expect(() => setCredManToken('agents-cli.secrets.demo.BIG', big)).toThrow(
      /CRED_MAX_CREDENTIAL_BLOB_SIZE/
    );
  });

  it('accepts a value exactly at the limit', () => {
    _resetForTest({ forceAvailable: true, fileDir: tmpDir });
    let sawSet = false;
    responder = (op) => { if (op === 'set') sawSet = true; return { status: 0 }; };
    const atLimit = 'x'.repeat(CRED_MAX_CREDENTIAL_BLOB_SIZE);
    setCredManToken('agents-cli.secrets.demo.MAX', atLimit);
    expect(sawSet).toBe(true);
  });
});

// (e) real Credential Manager round-trip — only on Windows CI leg.
describe.skipIf(process.platform !== 'win32')('real Windows Credential Manager', () => {
  it('set -> has -> get -> list -> delete against real advapi32', async () => {
    const cp = await vi.importActual<typeof import('child_process')>('child_process');
    spawnSyncMock.mockImplementation((...a: any[]) => (cp.spawnSync as any)(...a));
    _resetForTest({ forceAvailable: true });

    const item = `agents-cli.secrets.wintest.${Date.now()}`;
    const value = 'real-round-trip: café ☕ =+/';
    try {
      windowsBackend.set(item, value);
      expect(windowsBackend.has(item)).toBe(true);
      expect(windowsBackend.get(item)).toBe(value);
      expect(windowsBackend.list('agents-cli.secrets.wintest.')).toContain(item);
    } finally {
      expect(windowsBackend.delete(item)).toBe(true);
      expect(windowsBackend.has(item)).toBe(false);
    }
  });
});
