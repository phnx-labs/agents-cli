/**
 * Managed known_hosts pinning (RUSH-1767).
 *
 * The real bugs here are security-shaped: a host must be judged "pinned" only
 * when its key is actually recorded (else the credential-copy gate would ship
 * tokens over an unverified connection), the policy must flip to
 * StrictHostKeyChecking=yes exactly when pinned, and re-scanning an
 * already-pinned key must be a no-op (else the store grows without bound).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  hostKeyCheckingOpts,
  isHostPinned,
  isHostPinnedIn,
  newKnownHostsLines,
} from './known-hosts.js';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI0000000000000000000000000000000000000000000';

describe('isHostPinnedIn', () => {
  it('matches a recorded host, case-insensitively, and splits comma / [host]:port entries', () => {
    expect(isHostPinnedIn(`yosemite-s0.ts.net ${KEY}`, 'yosemite-s0.ts.net')).toBe(true);
    expect(isHostPinnedIn(`YOSEMITE-s0.ts.net ${KEY}`, 'yosemite-s0.ts.net')).toBe(true);
    expect(isHostPinnedIn(`a.ts.net,b.ts.net ${KEY}`, 'b.ts.net')).toBe(true);
    expect(isHostPinnedIn(`[box.ts.net]:2222 ${KEY}`, 'box.ts.net')).toBe(true);
  });

  it('does not match an absent host, a hashed entry, or an empty needle', () => {
    expect(isHostPinnedIn(`yosemite-s0.ts.net ${KEY}`, 'other.ts.net')).toBe(false);
    // Hashed entries carry no recoverable hostname — never counts as pinned.
    expect(isHostPinnedIn(`|1|abc=|def= ${KEY}`, 'yosemite-s0.ts.net')).toBe(false);
    expect(isHostPinnedIn('', 'yosemite-s0.ts.net')).toBe(false);
    expect(isHostPinnedIn(`yosemite-s0.ts.net ${KEY}`, '   ')).toBe(false);
  });
});

describe('hostKeyCheckingOpts', () => {
  it('verifies strictly against the managed store once pinned', () => {
    const opts = hostKeyCheckingOpts(true, '/managed/known_hosts');
    expect(opts).toEqual([
      '-o', 'UserKnownHostsFile=/managed/known_hosts',
      '-o', 'StrictHostKeyChecking=yes',
    ]);
  });

  it('learns on first connect (accept-new) before a host is pinned', () => {
    const opts = hostKeyCheckingOpts(false, '/managed/known_hosts');
    expect(opts).toContain('StrictHostKeyChecking=accept-new');
    expect(opts).not.toContain('StrictHostKeyChecking=yes');
    expect(opts).toContain('UserKnownHostsFile=/managed/known_hosts');
  });
});

describe('newKnownHostsLines', () => {
  it('returns only lines absent from the store, dropping comments/blanks and inner dupes', () => {
    const existing = `# managed\nold.ts.net ${KEY}\n`;
    const scanned = `# ssh-keyscan header\nold.ts.net ${KEY}\nnew.ts.net ${KEY}\nnew.ts.net ${KEY}\n`;
    expect(newKnownHostsLines(existing, scanned)).toEqual([`new.ts.net ${KEY}`]);
  });

  it('is a no-op when every scanned key is already pinned', () => {
    const line = `box.ts.net ${KEY}`;
    expect(newKnownHostsLines(`${line}\n`, `# c\n${line}\n`)).toEqual([]);
  });
});

describe('isHostPinned (on-disk store)', () => {
  it('reads the managed store and reports a recorded host as pinned', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
    const file = path.join(dir, 'known_hosts');
    fs.writeFileSync(file, `pinned.ts.net ${KEY}\n`);
    try {
      expect(isHostPinned('pinned.ts.net', file)).toBe(true);
      expect(isHostPinned('unpinned.ts.net', file)).toBe(false);
      // A missing store never throws and never reports pinned.
      expect(isHostPinned('pinned.ts.net', path.join(dir, 'absent'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
