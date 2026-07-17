/**
 * The `--copy-creds` security gate decision (RUSH-1767).
 *
 * This is the choke point that decides whether credentials (and the Claude OAuth
 * token) ship to a remote host. The real bug it guards against: shipping tokens
 * over an accept-new (TOFU) connection a machine-in-the-middle could intercept.
 * So the decision must ship ONLY when the host key is pinned in the managed
 * store, must resolve an ssh-config alias to its real HostName before checking
 * (else it would verify a different host than the dispatch connects to), and
 * must self-pin a non-device alias in place while steering a registered device
 * to `agents ssh <name>` instead.
 *
 * The two network seams (`resolve` = `ssh -G`, `selfPin` = `ssh-keyscan`) are fed
 * real fixture data — a real `ssh -G` result shape and real ssh-keyscan text run
 * through the real `recordScannedKeys` store-write — so the decision, the store
 * reads (real `isHostPinned`), and the pin are all exercised without a network.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decideCopyCredsGate } from './exec.js';
import { isHostPinned, recordScannedKeys } from '../lib/devices/known-hosts.js';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI0000000000000000000000000000000000000000000';

/** A fresh, empty managed store in a temp dir; caller cleans up. */
function mkStore(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  return { dir, file: path.join(dir, 'known_hosts') };
}

describe('decideCopyCredsGate — refuses an unpinned host (no cred copy)', () => {
  it('refuses a registered device that is not pinned, WITHOUT self-pinning it', () => {
    const { dir, file } = mkStore();
    try {
      // A registered device earns its pin through `agents ssh <name>` (accept-new),
      // not here — the gate must NOT ssh-keyscan it. selfPin records if it's called.
      let selfPinCalls = 0;
      const decision = decideCopyCredsGate(
        { name: 'yosemite-s0', address: '100.84.1.2', provider: 'devices' },
        {
          file,
          selfPin: (target, port, f) => {
            selfPinCalls++;
            return recordScannedKeys(target, `${target} ${KEY}\n`, f).pinned;
          },
        },
      );
      expect(decision).toEqual({ allowed: false, pinTarget: '100.84.1.2', selfPinned: false });
      expect(selfPinCalls).toBe(0); // device left for the accept-new connect, never scanned
      expect(isHostPinned('100.84.1.2', file)).toBe(false); // nothing was shipped-eligible
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a non-device alias whose ssh-keyscan yields no usable key', () => {
    const { dir, file } = mkStore();
    try {
      // ssh-config alias `web` → real HostName web.internal, but the host is
      // unreachable so ssh-keyscan emits only comments: recordScannedKeys pins
      // nothing, so the gate still refuses (tokens never ship to an unpinned host).
      const decision = decideCopyCredsGate(
        { name: 'web', provider: 'local' },
        {
          file,
          resolve: () => ({ hostname: 'web.internal', port: '22' }),
          selfPin: (target, port, f) => recordScannedKeys(target, '# no key\n', f).pinned,
        },
      );
      expect(decision).toEqual({ allowed: false, pinTarget: 'web.internal', selfPinned: false });
      expect(isHostPinned('web.internal', file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('decideCopyCredsGate — allows after the self-pin path pins the alias', () => {
  it('resolves an ssh-config alias to its real HostName, self-pins it, then allows', () => {
    const { dir, file } = mkStore();
    try {
      // `ssh -G web` resolves the bare alias to its real HostName. The alias is
      // NOT a registered device, so `agents ssh web` dead-ends ("Unknown device")
      // and can never pin it — the gate must pin the RESOLVED HostName itself.
      const scanned = `# web.internal:22 SSH-2.0-OpenSSH_9.6\nweb.internal ${KEY}\n`;
      expect(isHostPinned('web.internal', file)).toBe(false); // unpinned to start
      const decision = decideCopyCredsGate(
        { name: 'web', provider: 'local' },
        {
          file,
          resolve: () => ({ hostname: 'web.internal', port: '22' }),
          selfPin: (target, port, f) => recordScannedKeys(target, scanned, f).pinned,
        },
      );
      // The gate now allows, and pinned the resolved HostName (not the alias), so
      // the strict dispatch verifies against the same host it connects to.
      expect(decision).toEqual({ allowed: true, pinTarget: 'web.internal', selfPinned: true });
      expect(isHostPinned('web.internal', file)).toBe(true);
      expect(isHostPinned('web', file)).toBe(false); // the alias name itself is never pinned
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes a non-default ssh-config Port to the pin so a [host]:port key is recorded', () => {
    const { dir, file } = mkStore();
    try {
      // ssh-keyscan -p 2222 emits `[host]:port` lines. The gate must forward the
      // resolved Port (2222, not the default 22) so the right key is scanned.
      let seenPort: number | undefined = -1 as unknown as number;
      const decision = decideCopyCredsGate(
        { name: 'box', provider: 'local' },
        {
          file,
          resolve: () => ({ hostname: 'box.internal', port: '2222' }),
          selfPin: (target, port, f) => {
            seenPort = port;
            return recordScannedKeys(target, `[${target}]:2222 ${KEY}\n`, f).pinned;
          },
        },
      );
      expect(seenPort).toBe(2222); // non-default port forwarded to the pin
      expect(decision).toEqual({ allowed: true, pinTarget: 'box.internal', selfPinned: true });
      expect(isHostPinned('box.internal', file)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows an already-pinned host without self-pinning again', () => {
    const { dir, file } = mkStore();
    try {
      // An inline host with a concrete address already recorded in the store:
      // the gate uses the address as the target, allows, and never re-scans.
      fs.writeFileSync(file, `10.0.0.5 ${KEY}\n`);
      let selfPinCalls = 0;
      const decision = decideCopyCredsGate(
        { name: 'box', address: '10.0.0.5', provider: 'local' },
        {
          file,
          selfPin: (target, port, f) => {
            selfPinCalls++;
            return recordScannedKeys(target, `${target} ${KEY}\n`, f).pinned;
          },
        },
      );
      expect(decision).toEqual({ allowed: true, pinTarget: '10.0.0.5', selfPinned: false });
      expect(selfPinCalls).toBe(0); // already pinned → no scan
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
