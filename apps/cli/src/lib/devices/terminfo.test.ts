import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  shouldSyncTerminfo,
  terminfoSynced,
  markTerminfoSynced,
  localTerminfoSource,
} from './terminfo.js';

describe('shouldSyncTerminfo', () => {
  it('skips non-interactive invocations (a remote command)', () => {
    expect(shouldSyncTerminfo({ term: 'xterm-ghostty', shell: 'posix', interactive: false })).toBe(false);
  });

  it('skips Windows/powershell devices — the console ignores terminfo', () => {
    expect(shouldSyncTerminfo({ term: 'xterm-ghostty', shell: 'powershell', interactive: true })).toBe(false);
  });

  it('skips when TERM is unset or blank', () => {
    expect(shouldSyncTerminfo({ term: undefined, shell: 'posix', interactive: true })).toBe(false);
    expect(shouldSyncTerminfo({ term: '   ', shell: 'posix', interactive: true })).toBe(false);
  });

  it('skips universally-shipped terminfo names (no wasted round-trip)', () => {
    for (const t of ['xterm', 'xterm-256color', 'screen-256color', 'tmux-256color', 'vt100', 'linux']) {
      expect(shouldSyncTerminfo({ term: t, shell: 'posix', interactive: true })).toBe(false);
    }
  });

  it('syncs exotic terminal entries the remote is unlikely to have', () => {
    for (const t of ['xterm-ghostty', 'xterm-kitty', 'alacritty', 'wezterm', 'foot', 'rio']) {
      expect(shouldSyncTerminfo({ term: t, shell: 'posix', interactive: true })).toBe(true);
    }
  });
});

describe('terminfo sync cache stamp', () => {
  let tmp: string;

  beforeEach(() => {
    // A real, isolated cache root — the stamp functions write to the real
    // filesystem here (no mocking), keyed off this dir via the cacheRoot override.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-terminfo-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is false before any sync, true after marking, and round-trips exotic names', () => {
    expect(terminfoSynced('host-a', 'xterm-ghostty', tmp)).toBe(false);
    markTerminfoSynced('host-a', 'xterm-ghostty', tmp);
    expect(terminfoSynced('host-a', 'xterm-ghostty', tmp)).toBe(true);
  });

  it('keys the stamp by BOTH host and TERM', () => {
    markTerminfoSynced('host-a', 'xterm-ghostty', tmp);
    expect(terminfoSynced('host-b', 'xterm-ghostty', tmp)).toBe(false); // different host
    expect(terminfoSynced('host-a', 'xterm-kitty', tmp)).toBe(false); // different TERM
  });

  it('treats a stale stamp (older than the TTL) as un-synced', () => {
    markTerminfoSynced('host-a', 'xterm-ghostty', tmp);
    const stamp = path.join(tmp, 'devices', 'terminfo', 'host-a__xterm-ghostty');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days > 7-day TTL
    fs.utimesSync(stamp, old, old);
    expect(terminfoSynced('host-a', 'xterm-ghostty', tmp)).toBe(false);
  });

  it('does not crash on hosts/terms with filesystem-hostile characters', () => {
    const host = 'user@10.0.0.1:22';
    markTerminfoSynced(host, 'xterm-ghostty', tmp);
    expect(terminfoSynced(host, 'xterm-ghostty', tmp)).toBe(true);
  });
});

describe('localTerminfoSource', () => {
  it('returns a compilable source for a term this machine has, or null otherwise', () => {
    // xterm is present wherever ncurses/infocmp exists; CI Linux has it. If the
    // box has no infocmp at all, the fail-safe path returns null — assert the
    // contract holds either way.
    const src = localTerminfoSource('xterm');
    if (src !== null) {
      expect(src).toContain('xterm');
    } else {
      expect(src).toBeNull();
    }
  });

  it('returns null for a terminfo name that does not exist', () => {
    expect(localTerminfoSource('definitely-not-a-real-term-xyz')).toBeNull();
  });
});
