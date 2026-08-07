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
import { execFileSync, spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import {
  addAlwaysFreshRepo,
  computeNetMode,
  decideCopyCredsGate,
  gitToplevel,
  hostTargetGiven,
  isAlwaysFreshRepo,
  isInsideGitWorkTree,
  parseRunAccountPickerRequest,
  runAccountPickerConflicts,
  runAutoDefaultsToAffinity,
  hostInteractiveNeedsCorrelationId,
  RUN_AUTO_KEYWORD,
} from './exec.js';
import { isHostPinned, recordScannedKeys } from '../lib/devices/known-hosts.js';
import { ALL_AGENT_IDS } from '../lib/agents.js';

describe('degraded run governance mode', () => {
  it('records the resolved writable mode in the audit chain', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-audit-mode-'));
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', '.system', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'agents.yaml'), 'agents: {}\n');
    // Antigravity has no read-only plan mode, so --mode plan degrades to edit.
    // Cursor now supports plan (RUSH-2101), so it can no longer exercise this path.
    const agy = path.join(binDir, process.platform === 'win32' ? 'agy.cmd' : 'agy');
    fs.writeFileSync(
      agy,
      process.platform === 'win32'
        ? '@echo {"type":"result","subtype":"success","is_error":false,"result":"OK"}\r\n'
        : '#!/bin/sh\nprintf \'{"type":"result","subtype":"success","is_error":false,"result":"OK"}\\n\'\n',
      { mode: 0o755 },
    );
    try {
      // `node` cannot resolve the CLI's `.js` ESM specifiers to .ts sources on its
      // own — spawn through the tsx loader, the same way every other CLI-spawning
      // test does (commands/routines.test.ts:19-26,75). `--import` needs a module
      // specifier, not a bare path, or Windows dies on ERR_UNSUPPORTED_ESM_URL_SCHEME.
      const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const result = spawnSync(
        'node',
        ['--import', tsxImport, path.resolve(import.meta.dirname, '..', 'index.ts'), 'run', 'antigravity', 'probe', '--mode', 'plan', '--quiet', '--cwd', root],
        {
          cwd: path.resolve(import.meta.dirname, '..', '..'),
          env: { ...process.env, HOME: root, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const lines = fs.readFileSync(path.join(root, '.agents', '.history', 'audit', 'log.jsonl'), 'utf8').trim().split('\n');
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ agent: 'antigravity', mode: 'edit', outcome: 'ok', exit: 0 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI0000000000000000000000000000000000000000000';

describe('trailing-@ account picker request', () => {
  it('distinguishes a terminal picker marker from a concrete version pin', () => {
    expect(parseRunAccountPickerRequest('claude@')).toEqual({
      requested: true,
      normalizedAgentSpec: 'claude',
      valid: true,
    });
    expect(parseRunAccountPickerRequest('claude@2.1.207')).toEqual({
      requested: false,
      normalizedAgentSpec: 'claude@2.1.207',
      valid: true,
    });
    expect(parseRunAccountPickerRequest('claude@@')).toMatchObject({
      requested: true,
      valid: false,
    });
  });

  it('fails loud for every routing option that would override the selected account', () => {
    expect(runAccountPickerConflicts({
      resume: true,
      strategy: 'balanced',
      balanced: true,
      lease: true,
      box: 'warm-one',
      device: 'yosemite-s0',
    })).toEqual(['--resume', '--strategy', '--balanced', '--lease', '--box', '--host/--device']);
    expect(runAccountPickerConflicts({})).toEqual([]);
  });
});

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

describe('isInsideGitWorkTree — the --lease/--box pre-flight sync guard', () => {
  it('is true inside a real git work tree', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-git-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-q']);
      expect(isInsideGitWorkTree(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is false in a plain directory that is not a git repo', () => {
    // crabbox builds its sync file list with `git ls-files`, which exits 128
    // here; the guard must catch that before a box is provisioned and billed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-nogit-'));
    try {
      expect(isInsideGitWorkTree(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gitToplevel — always-fresh repo keying', () => {
  it('returns the absolute toplevel of a real repo, null outside one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-top-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-q']);
      const top = gitToplevel(dir);
      expect(top).not.toBeNull();
      // macOS /tmp symlinks to /private/tmp, and on Windows os.tmpdir() hands
      // back the 8.3 short form (C:\Users\RUNNER~1\...) while git reports the
      // long one — realpathSync.native normalizes both, plain realpathSync
      // only the symlink.
      expect(fs.realpathSync.native(top!)).toBe(fs.realpathSync.native(dir));
      const nogit = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-notop-'));
      try {
        expect(gitToplevel(nogit)).toBeNull();
      } finally {
        fs.rmSync(nogit, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('computeNetMode — F5 tailscale vs public (RUSH-1924)', () => {
  it('a solo one-shot --lease (no reuse context) stays public', () => {
    expect(computeNetMode({ tailscale: undefined, reuseContext: false })).toBe('public');
  });

  it('a reuse context (--reuse/--box/picked box) defaults to the tailnet', () => {
    expect(computeNetMode({ tailscale: undefined, reuseContext: true })).toBe('tailscale');
  });

  it('--tailscale forces the tailnet even without a reuse context', () => {
    expect(computeNetMode({ tailscale: true, reuseContext: false })).toBe('tailscale');
  });

  it('--no-tailscale forces public even in a reuse context', () => {
    expect(computeNetMode({ tailscale: false, reuseContext: true })).toBe('public');
  });
});

describe('always-fresh repo set (F3 picker "remember for this repo")', () => {
  it('membership check is exact-path', () => {
    expect(isAlwaysFreshRepo(['/a/b'], '/a/b')).toBe(true);
    expect(isAlwaysFreshRepo(['/a/b'], '/a/c')).toBe(false);
    expect(isAlwaysFreshRepo([], '/a/b')).toBe(false);
  });

  it('add is idempotent and immutable', () => {
    const base = ['/repo/one'];
    const added = addAlwaysFreshRepo(base, '/repo/two');
    expect(added).toEqual(['/repo/one', '/repo/two']);
    expect(base).toEqual(['/repo/one']); // original untouched
    // Re-adding returns the SAME array reference (no duplicate).
    expect(addAlwaysFreshRepo(added, '/repo/two')).toBe(added);
  });
});

describe('hostTargetGiven — the --host alias family (the --terminal reject guard)', () => {
  // Regression: the --terminal handoff guard checked only `options.host`, so
  // `agents run <agent> --terminal --device box` (or --on/--computer) silently
  // opened a LOCAL tab and dropped the remote target instead of rejecting the
  // combination. Every alias must count as a host target.
  it('detects each --host alias, not just --host', () => {
    expect(hostTargetGiven({ host: 'box' })).toEqual(['box']);
    expect(hostTargetGiven({ device: 'box' })).toEqual(['box']);
    expect(hostTargetGiven({ on: 'box' })).toEqual(['box']);
    expect(hostTargetGiven({ computer: 'box' })).toEqual(['box']);
  });

  it('is empty when no host target is given (a local --terminal run is allowed)', () => {
    expect(hostTargetGiven({})).toEqual([]);
    expect(hostTargetGiven({ host: undefined })).toEqual([]);
  });

  it('returns every target when several aliases are set at once', () => {
    expect(hostTargetGiven({ host: 'a', device: 'b', on: 'c', computer: 'd' })).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});

describe('agents run auto — the reserved harness keyword (RUSH-2132)', () => {
  it('runAutoDefaultsToAffinity: no host flag → affinity default; any host flag pins the host layer', () => {
    expect(runAutoDefaultsToAffinity({})).toBe(true);
    expect(runAutoDefaultsToAffinity({ host: 'yosemite-s0' })).toBe(false);
    expect(runAutoDefaultsToAffinity({ device: 'yosemite-s0' })).toBe(false);
    expect(runAutoDefaultsToAffinity({ on: 'yosemite-s0' })).toBe(false);
    expect(runAutoDefaultsToAffinity({ computer: 'yosemite-s0' })).toBe(false);
  });

  it('runAutoDefaultsToAffinity: a host-dispatched run never re-runs affinity (no chain-hopping)', () => {
    expect(runAutoDefaultsToAffinity({}, { AGENTS_RUN_AUTO_HOST_RESOLVED: '1' })).toBe(false);
  });

  it('the keyword does not collide with a real harness id today', () => {
    expect(RUN_AUTO_KEYWORD).toBe('auto');
    // If this ever fails, a harness registered the id `auto` and the run-auto
    // keyword must be renamed — the action fails loud on the collision.
    expect(ALL_AGENT_IDS).not.toContain('auto');
  });

  it('agents run auto with zero installed harnesses exits nonzero with the no-healthy contract message', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-auto-empty-'));
    try {
      // Fresh HOME → no installed harness versions → the harness layer finds
      // zero candidates and must fail loud instead of launching anything. The
      // .agents/.system fixture gets past the first-run setup gate (same shape
      // as the governance-mode test above).
      fs.mkdirSync(path.join(root, '.agents', '.system', '.git'), { recursive: true });
      fs.writeFileSync(path.join(root, '.agents', 'agents.yaml'), 'agents: {}\n');
      const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const result = spawnSync(
        'node',
        ['--import', tsxImport, path.resolve(import.meta.dirname, '..', 'index.ts'), 'run', 'auto', 'probe', '--mode', 'plan', '--quiet', '--cwd', root],
        {
          cwd: path.resolve(import.meta.dirname, '..', '..'),
          env: { ...process.env, HOME: root },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(1);
      // The watchdog contract: literal `no healthy` + `resets` on the error line.
      expect(result.stderr).toContain('no healthy');
      expect(result.stderr).toContain('resets');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('interactive host dispatch — run auto session correlation (RUSH-2132 review #5)', () => {
  it('run auto ALWAYS mints a correlation launch id, even with an explicit --session-id', () => {
    // The harness is picked on the remote; the explicit id is only adopted by a
    // claude pick. Pre-registering it would strand a stale index entry when the
    // pick lands elsewhere — so the launch-id join must resolve the REAL id.
    expect(hostInteractiveNeedsCorrelationId('auto', 'explicit-id', undefined)).toBe(true);
    expect(hostInteractiveNeedsCorrelationId('auto', undefined, undefined)).toBe(true);
  });

  it('resume never mints (the id is already known), for auto and named harnesses alike', () => {
    expect(hostInteractiveNeedsCorrelationId('auto', 'explicit-id', 'resume-id')).toBe(false);
    expect(hostInteractiveNeedsCorrelationId('claude', undefined, 'resume-id')).toBe(false);
  });

  it('named harnesses keep the existing matrix: claude trusts its forced id, tracked agents join, untracked skip', () => {
    expect(hostInteractiveNeedsCorrelationId('claude', 'forced-id', undefined)).toBe(false);
    expect(hostInteractiveNeedsCorrelationId('codex', undefined, undefined)).toBe(true);
    expect(hostInteractiveNeedsCorrelationId('amp', undefined, undefined)).toBe(false);
  });
});

describe('cost tier on a profile run is discarded, not resolved against the host harness', () => {
  it('warns loud and drops the tier so the host-harness catalog model never reaches the profile endpoint', () => {
    // A profile's model comes from its endpoint (ANTHROPIC_MODEL), not the host
    // harness catalog. `--model cheap` used to resolve against the HOST harness
    // (claude -> claude-haiku-*) and forward that id to the profile's endpoint,
    // which doesn't ship it. The guard must discard the tier with a standout
    // warning BEFORE the host binary is spawned, leaving the profile's own model.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-profile-tier-'));
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', '.system', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'agents.yaml'), 'agents: {}\n');
    fs.writeFileSync(
      path.join(root, '.agents', 'profiles', 'kimiprofile.yml'),
      [
        'name: kimiprofile',
        'host:',
        '  agent: claude',
        'env:',
        '  ANTHROPIC_MODEL: kimi-k2-thinking',
        '  ANTHROPIC_BASE_URL: https://example.invalid',
        'provider: claude',
        'forkedFrom: claude',
        '',
      ].join('\n'),
    );
    // Fake `claude` host binary: record the model-bearing env + argv it was spawned
    // with (into $HOME/spawn.json), then emit a benign success line so the run ends.
    const spawnLog = path.join(root, 'spawn.json');
    const claudeBin = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    fs.writeFileSync(
      claudeBin,
      process.platform === 'win32'
        ? '@echo {"type":"result","subtype":"success","is_error":false,"result":"OK"}\r\n'
        : '#!/bin/sh\n'
          + 'node -e \'require("fs").writeFileSync(process.env.HOME + "/spawn.json", JSON.stringify({argv: process.argv.slice(2), model: process.env.ANTHROPIC_MODEL}))\'\n'
          + 'printf \'{"type":"result","subtype":"success","is_error":false,"result":"OK"}\\n\'\n',
      { mode: 0o755 },
    );
    try {
      const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const result = spawnSync(
        'node',
        ['--import', tsxImport, path.resolve(import.meta.dirname, '..', 'index.ts'), 'run', 'kimiprofile', 'probe', '--model', 'cheap', '--mode', 'plan', '--cwd', root],
        {
          cwd: path.resolve(import.meta.dirname, '..', '..'),
          env: { ...process.env, HOME: root, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        },
      );
      // The guard runs before any spawn, so the standout warning is the invariant.
      expect(result.stderr).toContain("cost tiers don't apply to custom harness 'kimiprofile'");
      // When the host binary is reached, it must carry the profile's own model, never
      // a claude tier id resolved from the host harness catalog.
      if (fs.existsSync(spawnLog)) {
        const spawned = JSON.parse(fs.readFileSync(spawnLog, 'utf8')) as { argv: string[]; model?: string };
        expect(spawned.model).toBe('kimi-k2-thinking');
        expect(JSON.stringify(spawned.argv)).not.toMatch(/claude-(haiku|sonnet|opus)/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * RUSH-2339 — `agents run <agent>` on a machine without that harness.
 *
 * Before the fix the launch fell through to the bare `cliCommand` and died as
 * `sh: 1: exec: cursor-agent: not found` (exit 127), after a `⚠ cursor looks
 * logged out` banner that was also wrong — it is not logged out, it is absent.
 *
 * These drive the REAL `agents run` command in a subprocess against a planted
 * HOME (`.agents/.system` git-inited so `ensureInitialized` passes) and a PATH
 * holding only what the test plants. No mocks: the second case genuinely
 * launches the harness stub, which is the whole point — a self-installed
 * harness with no version home MUST still run, so the guard cannot be a
 * "does agents-cli manage a version" check.
 */
describe.skipIf(process.platform === 'win32')('agents run — harness not installed (RUSH-2339)', () => {
  const bunBin = execFileSync('sh', ['-c', 'command -v bun'], { encoding: 'utf-8' }).trim();
  // Anchor on this file, not process.cwd() — vitest inherits the invoking shell's
  // cwd, so a run started from the repo root would not find src/index.ts.
  const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

  function runAgentsRun(home: string, pathDir: string) {
    return spawnSync(bunBin, [path.join(appRoot, 'src', 'index.ts'), 'run', 'cursor', 'hi', '--mode', 'plan', '--quiet'], {
      cwd: appRoot,
      env: { ...process.env, HOME: home, PATH: [pathDir, '/usr/bin', '/bin'].join(path.delimiter) },
      encoding: 'utf-8',
      timeout: 180_000,
    });
  }

  function plantHome(): { home: string; pathDir: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'run-not-installed-home-'));
    const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-not-installed-path-'));
    fs.mkdirSync(path.join(home, '.agents', '.system'), { recursive: true });
    execFileSync('git', ['-C', path.join(home, '.agents', '.system'), 'init', '-q']);
    return { home, pathDir };
  }

  it('fails loud with an actionable message instead of exiting 127', () => {
    const { home, pathDir } = plantHome();
    try {
      const res = runAgentsRun(home, pathDir);
      const out = `${res.stdout}${res.stderr}`;

      expect(res.status).toBe(1);
      expect(res.status).not.toBe(127);
      expect(out).toContain('cursor is not installed on this machine');
      expect(out).toContain('agents add cursor');
      // The two wrong messages the bug produced must be gone.
      expect(out).not.toContain('looks logged out');
      expect(out).not.toContain('not found');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(pathDir, { recursive: true, force: true });
    }
  });

  it('still launches a harness installed manually on PATH with no version home', () => {
    const { home, pathDir } = plantHome();
    try {
      const stub = path.join(pathDir, 'cursor-agent');
      fs.writeFileSync(stub, '#!/bin/sh\necho STUB_CURSOR_RAN\nexit 0\n');
      fs.chmodSync(stub, 0o755);
      expect(fs.existsSync(path.join(home, '.agents', '.history', 'versions', 'cursor'))).toBe(false);

      const res = runAgentsRun(home, pathDir);
      const out = `${res.stdout}${res.stderr}`;

      expect(out).toContain('STUB_CURSOR_RAN');
      expect(out).not.toContain('is not installed on this machine');
      expect(res.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(pathDir, { recursive: true, force: true });
    }
  });
});
