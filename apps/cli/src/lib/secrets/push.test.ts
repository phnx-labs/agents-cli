/**
 * Real-path coverage for the push primitive extracted from `secrets export --host`.
 *
 * No mocking (repo rule): the transport really is `spawnSync('ssh', …)`, and the
 * OS lookup really reads a device registry off disk. Both are driven with real
 * inputs instead of stand-ins:
 *
 * - **The device registry is real** — a temp `registry.json` selected via
 *   `AGENTS_DEVICES_DIR`, so `resolveRemoteOsSync` resolves a Windows and a Linux
 *   target through the same loader production uses.
 * - **PATH is emptied** for the transport-failure cases. `spawnSync` then fails
 *   ENOENT with `status === null` — the exact shape ssh produces when the
 *   transport dies rather than the remote exiting — and, crucially, an ssh that
 *   cannot run is proof that a branch expected to return BEFORE ssh really did.
 * - **A reserved `.invalid` hostname** (RFC 6761: guaranteed never to resolve)
 *   gives a real ssh process exiting non-zero, with no packet leaving the box.
 *
 * The transport SELECTION is pinned separately from execution, against
 * `planPushTransport`. Choosing wrong is silent — a Windows target handed
 * `--from -` hangs on a stdin the `agents.ps1` shim never forwards — and it is
 * not observable from an `SshExecResult`, so asserting the plan is the only way
 * to bite that branch without a live Windows box.
 *
 * Not covered here: the keychain read-back on a SUCCESSFUL push. It needs a live
 * macOS remote whose login keychain is reachable over headless SSH — there is no
 * way to reach `code === 0` without one, and a fake `ssh` on PATH would be the
 * mock this repo forbids. What IS pinned below is the security-relevant half: a
 * failed transport can never reach the verification step and can never return ok.
 */
import { describe, expect, it, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Point the real registry loader at a temp registry. AGENTS_DEVICES_DIR is read
// per call (state.ts:613), so this holds regardless of module import order.
const TEST_DEVICES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-push-test-'));
const REAL_DEVICES_DIR = process.env.AGENTS_DEVICES_DIR;
process.env.AGENTS_DEVICES_DIR = TEST_DEVICES_DIR;
fs.writeFileSync(
  path.join(TEST_DEVICES_DIR, 'registry.json'),
  JSON.stringify({
    'push-test-win': { name: 'push-test-win', platform: 'windows' },
    'push-test-linux': { name: 'push-test-linux', platform: 'linux' },
  }),
);

afterAll(() => {
  if (REAL_DEVICES_DIR === undefined) delete process.env.AGENTS_DEVICES_DIR;
  else process.env.AGENTS_DEVICES_DIR = REAL_DEVICES_DIR;
  fs.rmSync(TEST_DEVICES_DIR, { recursive: true, force: true });
});

const { pushResolvedBundleToHost, planPushTransport, bundleEnvToDotenv, resolveBundleForPush } = await import('./push.js');
const { writeBundleWithItems } = await import('./bundles.js');
const { secretsKeychainItem, setKeychainBackendForTest } = await import('./index.js');
type KeychainBackend = import('./index.js').KeychainBackend;

/** A bundle already read from the store — never resolved here, so nothing prompts. */
const RESOLVED = {
  env: { API_KEY: 'push-test-value', OTHER: 'second' },
  dotenv: bundleEnvToDotenv({ API_KEY: 'push-test-value', OTHER: 'second' }),
  keyCount: 2,
};

/**
 * The selection, not the builders it calls. Picking the wrong transport is
 * silent — a Windows target handed `--from -` hangs on a stdin the `agents.ps1`
 * shim never forwards — so what is pinned here is which of the four a
 * (backend, target-OS) pair resolves to, decided off the real device registry.
 */
describe('planPushTransport — which transport a backend/OS pair selects', () => {
  const plan = (host: string, remoteBackend: 'file' | 'keychain', force?: boolean) =>
    planPushTransport(RESOLVED, 'apple.com', host, { remoteBackend, force, operation: 'push.test' });

  it('refuses file backend to a Windows target instead of emitting broken PowerShell', () => {
    expect(plan('push-test-win', 'file')).toEqual({
      kind: 'refuse',
      message: 'file backend export to a Windows target is not yet supported',
    });
  });

  it('sends the POSIX file-import command to a Linux target, with the .env on stdin', () => {
    const t = plan('push-test-linux', 'file');
    expect(t.kind).toBe('ssh');
    if (t.kind !== 'ssh') throw new Error('unreachable');
    expect(t.remoteCmd).toContain('bash -lc');
    expect(t.remoteCmd).not.toMatch(/powershell/i);
    expect(t.input).toContain('API_KEY=');
  });

  it('bridges a Windows KEYCHAIN push through PowerShell, never through --from -', () => {
    const t = plan('push-test-win', 'keychain');
    expect(t.kind).toBe('ssh');
    if (t.kind !== 'ssh') throw new Error('unreachable');
    expect(t.remoteCmd).toMatch(/^powershell -NoProfile -EncodedCommand /);
    const script = Buffer.from(t.remoteCmd.split('-EncodedCommand ')[1], 'base64').toString('utf16le');
    // The shim can't forward ssh-piped stdin to node, so `--from -` would hang.
    expect(script).toContain("agents secrets import 'apple.com' --from $tmp");
    expect(script).not.toContain('--from -');
    expect(t.input).toBe(RESOLVED.dotenv);
  });

  it('uses the OS-aware secrets wrapper for a POSIX keychain push', () => {
    expect(plan('push-test-linux', 'keychain')).toEqual({
      kind: 'remote-secrets',
      args: ['import', 'apple.com', '--from', '-'],
      input: RESOLVED.dotenv,
    });
  });

  it('resolves the target OS after stripping a user@ prefix', () => {
    expect(plan('admin@push-test-win', 'file').kind).toBe('refuse');
    expect(plan('admin@push-test-linux', 'file').kind).toBe('ssh');
  });

  it('treats an unregistered host as POSIX', () => {
    expect(plan('push-test-never-registered', 'file').kind).toBe('ssh');
    expect(plan('push-test-never-registered', 'keychain').kind).toBe('remote-secrets');
  });

  it('forwards --force on all three transports', () => {
    const win = plan('push-test-win', 'keychain', true);
    if (win.kind !== 'ssh') throw new Error('unreachable');
    const script = Buffer.from(win.remoteCmd.split('-EncodedCommand ')[1], 'base64').toString('utf16le');
    expect(script).toContain('--from $tmp --force');
    expect(plan('push-test-linux', 'keychain', true)).toMatchObject({
      args: ['import', 'apple.com', '--from', '-', '--force'],
    });
    const file = plan('push-test-linux', 'file', true);
    if (file.kind !== 'ssh') throw new Error('unreachable');
    expect(file.remoteCmd).toContain('--force');
    expect((plan('push-test-linux', 'file') as { remoteCmd: string }).remoteCmd).not.toContain('--force');
  });

  it('never forwards a passphrase the caller did not pass — the RUSH-1968 contract', () => {
    // `fleet apply` calls this with no passphrase on purpose: each device keys the
    // bundle under its OWN machine-local key instead of a fleet-wide shared secret.
    // No prologue means AGENTS_SECRETS_PASSPHRASE stays unset on the remote.
    const t = plan('push-test-linux', 'file');
    if (t.kind !== 'ssh') throw new Error('unreachable');
    expect(t.remoteCmd).not.toContain('AGENTS_SECRETS_PASSPHRASE');
    expect(t.input).toBe(RESOLVED.dotenv);
  });

  it('carries an opt-in passphrase on stdin, never in the command line', () => {
    // A value in argv is readable from any process list, so the shared-key opt-in
    // reads it off the FIRST stdin line instead.
    const t = planPushTransport(RESOLVED, 'apple.com', 'push-test-linux', {
      remoteBackend: 'file',
      passphrase: 'push-test-passphrase',
      operation: 'push.test',
    });
    if (t.kind !== 'ssh') throw new Error('unreachable');
    expect(t.remoteCmd).not.toContain('push-test-passphrase');
    expect(t.remoteCmd).toContain('IFS= read -r AGENTS_SECRETS_PASSPHRASE');
    expect(t.input).toBe(`push-test-passphrase\n${RESOLVED.dotenv}`);
  });
});

describe('pushResolvedBundleToHost — transport branches', () => {
  const realPath = process.env.PATH;
  // Mirror AGENTS_DEVICES_DIR's delete-or-restore, so an env that genuinely had
  // no PATH is not handed back an empty string.
  const restorePath = () => {
    if (realPath === undefined) delete process.env.PATH;
    else process.env.PATH = realPath;
  };

  describe('with no ssh on PATH (transport cannot run)', () => {
    beforeAll(() => { process.env.PATH = ''; });
    afterAll(restorePath);

    it('refuses a file-backend push to a Windows target BEFORE reaching ssh', () => {
      const out = pushResolvedBundleToHost(RESOLVED, 'apple.com', 'push-test-win', {
        remoteBackend: 'file',
        operation: 'push.test',
      });
      // 'ssh failed' here would mean the refusal did not short-circuit.
      expect(out).toEqual({
        ok: false,
        host: 'push-test-win',
        bundle: 'apple.com',
        keyCount: 2,
        message: 'file backend export to a Windows target is not yet supported',
      });
    });

    it('classifies a dead transport as ssh failure, not a remote exit', () => {
      const out = pushResolvedBundleToHost(RESOLVED, 'apple.com', 'push-test-linux', {
        remoteBackend: 'file',
        operation: 'push.test',
      });
      expect(out.ok).toBe(false);
      expect(out.message).toBe('ssh failed');
      // The remote-exit branch would have said "remote import failed (exit N)".
      expect(out.message).not.toMatch(/remote import failed/);
    });

    it('never reaches keychain read-back — or returns ok — when the transport dies', () => {
      const out = pushResolvedBundleToHost(RESOLVED, 'apple.com', 'push-test-linux', {
        remoteBackend: 'keychain',
        operation: 'push.test',
      });
      expect(out.ok).toBe(false);
      expect(out.message).toBe('ssh failed');
      // verifyRemoteKeychainPush's failures read "pushed '<bundle>' but could not
      // verify it" / the locked-keychain guidance. Reaching either would mean the
      // 0-exit gate above it had been skipped.
      expect(out.message).not.toMatch(/pushed '|could not verify|keychain/i);
    });

    it('reports the host and key count on every refusal, so a caller can render it', () => {
      for (const backend of ['file', 'keychain'] as const) {
        const out = pushResolvedBundleToHost(RESOLVED, 'apple.com', 'push-test-linux', {
          remoteBackend: backend,
          operation: 'push.test',
        });
        expect(out.host).toBe('push-test-linux');
        expect(out.bundle).toBe('apple.com');
        expect(out.keyCount).toBe(2);
      }
    });
  });

  it('classifies a real non-zero ssh exit as a remote import failure', () => {
    // RFC 6761 reserves .invalid: resolution fails locally, ssh exits 255.
    const out = pushResolvedBundleToHost(RESOLVED, 'apple.com', 'push-test-host.invalid', {
      remoteBackend: 'file',
      operation: 'push.test',
    });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/^remote import failed \(exit \d+\)/);
    expect(out.message).not.toBe('ssh failed');
    // The remote's own stderr is carried through so the caller can show it.
    expect(out.message).toMatch(/could not resolve|name or service not known|nodename/i);
  });

  it('never puts a secret value in the returned message', () => {
    process.env.PATH = '';
    try {
      for (const host of ['push-test-win', 'push-test-linux']) {
        for (const backend of ['file', 'keychain'] as const) {
          const out = pushResolvedBundleToHost(RESOLVED, 'apple.com', host, {
            remoteBackend: backend,
            operation: 'push.test',
          });
          expect(out.message).not.toContain('push-test-value');
        }
      }
    } finally {
      restorePath();
    }
  });
});

describe('bundleEnvToDotenv', () => {
  it('quotes every value so it round-trips through the remote parseDotenv', () => {
    expect(bundleEnvToDotenv({ A: '1', B: 'has space' })).toBe('A="1"\nB="has space"\n');
  });

  it('rejects a multi-line value rather than silently corrupting it', () => {
    expect(() => bundleEnvToDotenv({ KEY: 'line1\nline2' })).toThrow(/multi-line/);
  });
});

/**
 * `resolveBundleForPush` must FORWARD the caller's `agentOnly`, not hardcode it.
 *
 * The bug: it passed `agentOnly: true` unconditionally, so `agents secrets export
 * --host` refused every keychain-backed bundle with "not unlocked in the secrets
 * agent" — even for a human at a TTY who could simply answer the Touch ID sheet.
 * Its sibling reads (`view --reveal`, `get`) already decided this per-invocation
 * with `isHeadlessSecretsContext() || !isInteractiveTerminal()`, and `view
 * --reveal` prints plaintext to the screen, so the push path was the strictest
 * read for no stated reason.
 *
 * Real path, no mocking of logic: the production `readAndResolveBundleEnv` runs
 * unchanged, with only the STORAGE backend swapped for an in-memory one — the
 * same technique `bundles.test.ts` uses to reach this guard without a live
 * macOS Keychain, so the assertions hold on Linux CI too.
 */
describe('resolveBundleForPush — agentOnly is the caller\'s decision', () => {
  class MemBackend implements KeychainBackend {
    store = new Map<string, string>();
    has(item: string) { return this.store.has(item); }
    get(item: string) {
      const v = this.store.get(item);
      if (v === undefined) throw new Error(`missing ${item}`);
      return v;
    }
    set(item: string, value: string) { this.store.set(item, value); }
    delete(item: string) { return this.store.delete(item); }
    list(prefix: string) { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
  }

  let prevBackend: KeychainBackend;
  let prevNoAgent: string | undefined;

  beforeEach(() => {
    prevBackend = setKeychainBackendForTest(new MemBackend());
    prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
    process.env.AGENTS_SECRETS_NO_AGENT = '1'; // no broker fast-path — exercise the guard
    writeBundleWithItems(
      { name: 'apple.com', policy: 'hold', vars: { APPLE_TEAM_ID: 'keychain:APPLE_TEAM_ID' } },
      new Map([[secretsKeychainItem('apple.com', 'APPLE_TEAM_ID'), '2HTP252L87']]),
    );
  });

  afterEach(() => {
    setKeychainBackendForTest(prevBackend);
    if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
    else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
  });

  // The fix. Pre-fix this threw the unlock error no matter what the caller asked for.
  it('resolves a locked keychain bundle when the caller is interactive (agentOnly: false)', () => {
    expect(resolveBundleForPush('apple.com', 'ssh export', { agentOnly: false }).env)
      .toEqual({ APPLE_TEAM_ID: '2HTP252L87' });
  });

  it('still fails fast with the unlock hint when the caller is headless (agentOnly: true)', () => {
    expect(() => resolveBundleForPush('apple.com', 'ssh export', { agentOnly: true }))
      .toThrow("Secrets bundle 'apple.com' is not unlocked in the secrets agent");
  });

  // The default is load-bearing: `pushBundleToHost` (fleet apply) passes nothing,
  // and a bulk automated push must not start raising biometric sheets.
  it('defaults to broker-only when the caller says nothing', () => {
    expect(() => resolveBundleForPush('apple.com', 'ssh export'))
      .toThrow("Secrets bundle 'apple.com' is not unlocked in the secrets agent");
  });
});
