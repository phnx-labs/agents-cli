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
 * Not covered here: the keychain read-back on a SUCCESSFUL push. It needs a live
 * macOS remote whose login keychain is reachable over headless SSH — there is no
 * way to reach `code === 0` without one, and a fake `ssh` on PATH would be the
 * mock this repo forbids. What IS pinned below is the security-relevant half: a
 * failed transport can never reach the verification step and can never return ok.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
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

const { pushResolvedBundleToHost, isPowershellTarget, bundleEnvToDotenv } = await import('./push.js');
const { buildWindowsStdinImportCommand } = await import('../hosts/remote-cmd.js');

/** A bundle already read from the store — never resolved here, so nothing prompts. */
const RESOLVED = {
  env: { API_KEY: 'push-test-value', OTHER: 'second' },
  dotenv: bundleEnvToDotenv({ API_KEY: 'push-test-value', OTHER: 'second' }),
  keyCount: 2,
};

describe('isPowershellTarget — the one predicate behind both Windows branches', () => {
  it('reads the platform off the real device registry', () => {
    expect(isPowershellTarget('push-test-win')).toBe(true);
    expect(isPowershellTarget('push-test-linux')).toBe(false);
  });

  it('strips a user@ prefix before the lookup', () => {
    expect(isPowershellTarget('admin@push-test-win')).toBe(true);
  });

  it('treats an unknown host as POSIX', () => {
    expect(isPowershellTarget('push-test-never-registered')).toBe(false);
  });
});

describe('pushResolvedBundleToHost — transport branches', () => {
  const realPath = process.env.PATH;

  describe('with no ssh on PATH (transport cannot run)', () => {
    beforeAll(() => { process.env.PATH = ''; });
    afterAll(() => { process.env.PATH = realPath; });

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
      process.env.PATH = realPath;
    }
  });
});

describe('Windows keychain transport bridges stdin through a temp file', () => {
  // The `agents.ps1` shim does not forward ssh-piped stdin to node, so the POSIX
  // `--from -` form would hang forever. This is the command that branch sends.
  const cmd = buildWindowsStdinImportCommand('apple.com');

  it('is an encoded PowerShell command, not a bash -lc', () => {
    expect(cmd).toMatch(/^powershell -NoProfile -EncodedCommand /);
    expect(cmd).not.toContain('bash -lc');
  });

  it('imports from a temp FILE and deletes it, rather than from stdin', () => {
    const encoded = cmd.split('-EncodedCommand ')[1];
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(script).toContain('[Console]::In.ReadToEnd()');
    expect(script).toContain('GetTempFileName()');
    expect(script).toContain("agents secrets import 'apple.com' --from $tmp");
    expect(script).not.toContain('--from -');
    // The temp file holds the .env, so cleanup must be unconditional.
    expect(script).toContain('finally {');
    expect(script).toContain('Remove-Item -LiteralPath $tmp -Force');
  });

  it('forwards --force only when asked', () => {
    const decode = (c: string) =>
      Buffer.from(c.split('-EncodedCommand ')[1], 'base64').toString('utf16le');
    expect(decode(buildWindowsStdinImportCommand('apple.com', { force: true }))).toContain('--from $tmp --force');
    expect(decode(cmd)).not.toContain('--force');
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
