import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import {
  writeProfileRuntime,
  readProfileRuntime,
  readProfileRuntimeMeta,
  clearProfileRuntime,
  removeProfileCache,
  listProfileCacheDirs,
  listAllProfileSnapshots,
  isProcessAlive,
  reapOrphanedProcesses,
} from './runtime-state.js';
import { getBrowserRuntimeDir, getProfileRuntimeDir } from './profiles.js';

// `state.ts` resolves CACHE_DIR from HOME at module-load time, so we can't
// redirect with process.env.HOME from a test. Instead each test uses a
// random profile-name prefix; we track everything we touch and clean it
// up in afterEach.
let prefix: string;
const created: string[] = [];

// Use whatever `ps` reports for THIS process — that's what the matcher
// compares against at runtime. Test runners (vitest, bun) set process.title,
// which mutates /proc/<pid>/comm on Linux, so `path.basename(process.execPath)`
// disagrees with the live ps output. Fall back to execPath basename if `ps`
// is unavailable.
function currentProcessCommand(): string {
  try {
    const out = execFileSync('ps', ['-p', String(process.pid), '-o', 'comm='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return path.basename(out);
  } catch { /* fall through */ }
  return path.basename(process.execPath);
}

function uniq(base: string): string {
  const name = `${prefix}-${base}`;
  created.push(name);
  return name;
}

beforeEach(() => {
  prefix = `tst-${crypto.randomBytes(6).toString('hex')}`;
});

afterEach(() => {
  const root = getBrowserRuntimeDir();
  for (const name of created) {
    const dir = path.join(root, name);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  created.length = 0;
});

describe('writeProfileRuntime + readProfileRuntime', () => {
  it('round-trips pid/port/command for a live process', () => {
    const name = uniq('p1');
    const command = currentProcessCommand();
    writeProfileRuntime(name, { pid: process.pid, port: 9222, command });
    const got = readProfileRuntime(name);
    expect(got).toEqual({ pid: process.pid, port: 9222, command });
  });

  it('returns null and removes files when the pid is dead', () => {
    const name = uniq('p2');
    writeProfileRuntime(name, { pid: 999999, port: 9222 });
    const got = readProfileRuntime(name);
    expect(got).toBeNull();
    const dir = getProfileRuntimeDir(name);
    expect(fs.existsSync(path.join(dir, 'pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'port'))).toBe(false);
  });

  it('returns null when the live pid runs a different command (pid-reuse defense)', () => {
    const name = uniq('p3');
    writeProfileRuntime(name, { pid: process.pid, port: 9222, command: 'ImpossibleBrowserName' });
    expect(readProfileRuntime(name)).toBeNull();
  });

  it('returns the runtime when pid:0 (attached to externally-launched browser)', () => {
    const name = uniq('p4');
    writeProfileRuntime(name, { pid: 0, port: 9222 });
    expect(readProfileRuntime(name)).toEqual({ pid: 0, port: 9222 });
  });

  it('returns null when no files exist', () => {
    expect(readProfileRuntime(uniq('never-written'))).toBeNull();
  });

  it('does not persist a CDP port for pipe-launched browsers', () => {
    const name = uniq('pipe');
    writeProfileRuntime(name, { pid: process.pid, command: currentProcessCommand() });
    const dir = getProfileRuntimeDir(name);

    expect(fs.existsSync(path.join(dir, 'port'))).toBe(false);
    expect(readProfileRuntime(name)?.port).toBeUndefined();
    expect(readProfileRuntimeMeta(name)?.port).toBeUndefined();
  });
});

describe('clearProfileRuntime', () => {
  it('removes pid/port/command but not chrome-data', () => {
    const name = uniq('p5');
    const dir = getProfileRuntimeDir(name);
    fs.mkdirSync(path.join(dir, 'chrome-data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'chrome-data', 'Local State'), '{}');
    writeProfileRuntime(name, { pid: process.pid, port: 9222, command: 'node' });

    clearProfileRuntime(name);

    expect(fs.existsSync(path.join(dir, 'pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'port'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'command'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'chrome-data', 'Local State'))).toBe(true);
  });

  it('is a no-op when files are already gone', () => {
    expect(() => clearProfileRuntime(uniq('does-not-exist'))).not.toThrow();
  });
});

describe('removeProfileCache', () => {
  it('removes the entire profile directory including chrome-data', () => {
    const name = uniq('p6');
    const dir = getProfileRuntimeDir(name);
    fs.mkdirSync(path.join(dir, 'chrome-data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'chrome-data', 'Local State'), '{}');

    removeProfileCache(name);

    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('listProfileCacheDirs', () => {
  it('matches the legacy non-composite dir AND every composite variant', () => {
    const base = uniq('multi');
    const root = getBrowserRuntimeDir();
    fs.mkdirSync(path.join(root, base), { recursive: true });
    fs.mkdirSync(path.join(root, `${base}@endpoint-0`), { recursive: true });
    fs.mkdirSync(path.join(root, `${base}@remote`), { recursive: true });
    created.push(`${base}@endpoint-0`, `${base}@remote`);

    const found = listProfileCacheDirs(base).map((p) => path.basename(p)).sort();
    expect(found).toEqual([base, `${base}@endpoint-0`, `${base}@remote`].sort());
  });

  it('returns an empty list when no matching dir exists', () => {
    expect(listProfileCacheDirs(uniq('absent'))).toEqual([]);
  });

  it('does not match profiles whose names share a prefix', () => {
    const base = uniq('exact');
    const root = getBrowserRuntimeDir();
    fs.mkdirSync(path.join(root, base), { recursive: true });
    fs.mkdirSync(path.join(root, `${base}-other`), { recursive: true });
    created.push(`${base}-other`);

    const found = listProfileCacheDirs(base).map((p) => path.basename(p));
    expect(found).toEqual([base]);
  });
});

describe('readProfileRuntimeMeta', () => {
  it('returns the full JSON record including daemonPid and spawnedAt', () => {
    const name = uniq('meta');
    writeProfileRuntime(name, {
      pid: process.pid,
      port: 9222,
      command: currentProcessCommand(),
      kind: 'browser',
      userDataDir: '/tmp/nope',
    });
    const meta = readProfileRuntimeMeta(name);
    expect(meta?.pid).toBe(process.pid);
    expect(meta?.kind).toBe('browser');
    expect(meta?.userDataDir).toBe('/tmp/nope');
    expect(meta?.daemonPid).toBe(process.pid);
    expect(typeof meta?.spawnedAt).toBe('number');
  });

  it('returns null when meta.json is missing', () => {
    expect(readProfileRuntimeMeta(uniq('absent'))).toBeNull();
  });
});

describe('reapOrphanedProcesses', () => {
  it('leaves records owned by THIS daemon alone', () => {
    const name = uniq('mine');
    writeProfileRuntime(name, {
      pid: 999999, // dead, but daemonPid is us so we skip
      port: 9222,
      command: 'node',
    });
    const result = reapOrphanedProcesses();
    expect(result.reaped).toBe(0);
    // Meta file still there:
    expect(readProfileRuntimeMeta(name)).not.toBeNull();
  });

  it('reaps records whose daemonPid is dead', () => {
    const name = uniq('orphan');
    // Manually write a meta.json owned by a dead daemon pid.
    const dir = getProfileRuntimeDir(name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        pid: 999998, // dead — kill is a no-op but cleanup must still happen
        port: 9222,
        command: 'node',
        daemonPid: 999997, // also dead
        spawnedAt: Date.now() - 10_000,
      })
    );

    reapOrphanedProcesses();
    // Cleanup should have removed the orphan's runtime files even if the
    // recorded pid was already gone.
    expect(readProfileRuntimeMeta(name)).toBeNull();
  });
});

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns true for the current process when command matches', () => {
    expect(isProcessAlive(process.pid, currentProcessCommand())).toBe(true);
  });

  it('returns false for the current process when command does NOT match', () => {
    expect(isProcessAlive(process.pid, 'NotARealBinary123')).toBe(false);
  });

  it('returns true for pid 0 (sentinel for "attached, not owned")', () => {
    expect(isProcessAlive(0)).toBe(true);
  });

  it('returns false for a definitely-dead pid', () => {
    expect(isProcessAlive(999999)).toBe(false);
  });
});

describe('fork runtime cleanup (RUSH-1528)', () => {
  it('clearProfileRuntime on a fork name removes stale fork entries from snapshots', () => {
    const base = uniq('fork-parent');
    const fork2 = `${base}.2`;
    const fork3 = `${base}.3`;
    created.push(fork2, fork3);

    writeProfileRuntime(fork2, { pid: 999990, command: 'chrome' });
    writeProfileRuntime(fork3, { pid: 999991, command: 'chrome' });

    const beforeClear = listAllProfileSnapshots().filter(
      (s) => s.name === fork2 || s.name === fork3,
    );
    expect(beforeClear).toHaveLength(2);

    clearProfileRuntime(fork2);
    clearProfileRuntime(fork3);

    const afterClear = listAllProfileSnapshots().filter(
      (s) => s.name === fork2 || s.name === fork3,
    );
    expect(afterClear.every((s) => s.meta === null)).toBe(true);
  });

  it('listProfileCacheDirs finds composite forks (.N) alongside composites', () => {
    const base = uniq('forkdir');
    const composite = `${base}@endpoint-0`;
    const fork2 = `${composite}.2`;
    const fork3 = `${composite}.3`;
    const root = getBrowserRuntimeDir();
    for (const name of [base, composite, fork2, fork3]) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      created.push(name);
    }

    const found = listProfileCacheDirs(base).map((p) => path.basename(p)).sort();
    expect(found).toEqual([base, composite, fork2, fork3].sort());
  });

  it('repeated fork write + clear leaves no stale snapshots', () => {
    const base = uniq('repeat');
    const fork = `${base}.2`;
    created.push(fork);

    for (let cycle = 0; cycle < 3; cycle++) {
      writeProfileRuntime(fork, { pid: 999980 + cycle, command: 'chrome' });
      expect(readProfileRuntimeMeta(fork)).not.toBeNull();
      clearProfileRuntime(fork);
      expect(readProfileRuntimeMeta(fork)).toBeNull();
    }

    const stale = listAllProfileSnapshots().filter(
      (s) => s.name === fork && s.meta !== null,
    );
    expect(stale).toHaveLength(0);
  });
});
