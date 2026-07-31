import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as path from 'path';
import { spawn } from 'child_process';
import { describe, it, expect } from 'vitest';
import type { SecretsBundle } from './bundles.js';
import { handleAgentRequest, isRequestAuthorized, makeConnectionHandler, shouldSelfHealForUpgrade, shouldTeardownVersionSkewedBroker, realBundleCount, shouldWipeOnWatchEvent, agentEvictSync, startHostedBroker, runSecretsAgent, agentPing, secretsAgentServiceInstalled, retireLegacySecretsAgentService, clampHoldMs, syncClientLaunch, lastLine, runAgentLockSync, DEFAULT_TTL_MS, MIN_HOLD_MS, MAX_HOLD_MS, META_CACHE_PREFIX, type StoredBundle, type Response, type Request } from './agent.js';

/**
 * These tests target the broker's store semantics — the part with real bug
 * surface (lazy expiry on read, lock-one vs lock-all, TTL math, status hiding
 * expired entries). They drive `handleAgentRequest` directly with a controlled
 * `now`, so they're deterministic and need no socket or spawned process. The
 * socket transport itself is thin (newline-framed JSON) and exercised live by
 * the E2E flow; the logic that can corrupt state lives here.
 */

function bundle(name: string): SecretsBundle {
  return { name, vars: {} };
}

function freshStore(): Map<string, StoredBundle> {
  return new Map<string, StoredBundle>();
}

const loadReq = (name: string, env: Record<string, string>, ttlMs: number): Request => ({
  cmd: 'load',
  name,
  bundle: bundle(name),
  env,
  ttlMs,
});

describe('handleAgentRequest', () => {
  it('load then get returns the cached env (a hit, no expiry)', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq('prod', { K: 'v' }, 60_000), 1_000);
    const r = handleAgentRequest(store, { cmd: 'get', name: 'prod' }, 2_000);
    expect(r).toEqual({ ok: true, cmd: 'get', hit: true, bundle: bundle('prod'), env: { K: 'v' } });
  });

  it('get on an unknown bundle is a miss', () => {
    const r = handleAgentRequest(freshStore(), { cmd: 'get', name: 'nope' }, 0);
    expect(r).toEqual({ ok: true, cmd: 'get', hit: false });
  });

  it('expires a bundle exactly at its TTL boundary and drops it from the store', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq('prod', { K: 'v' }, 1_000), 0); // expiresAt = 1000
    // Just before the boundary: still a hit.
    expect(handleAgentRequest(store, { cmd: 'get', name: 'prod' }, 999)).toMatchObject({ hit: true });
    // At the boundary (now >= expiresAt): a miss, and the entry is evicted.
    expect(handleAgentRequest(store, { cmd: 'get', name: 'prod' }, 1_000)).toMatchObject({ hit: false });
    expect(store.has('prod')).toBe(false);
  });

  it('lock with a name wipes only that bundle', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq('a', { K: '1' }, 60_000), 0);
    handleAgentRequest(store, loadReq('b', { K: '2' }, 60_000), 0);
    const r = handleAgentRequest(store, { cmd: 'lock', name: 'a' }, 0);
    expect(r).toEqual({ ok: true, cmd: 'lock', wiped: 1 });
    expect(store.has('a')).toBe(false);
    expect(store.has('b')).toBe(true);
  });

  it('lock with no name wipes everything and reports the count', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq('a', { K: '1' }, 60_000), 0);
    handleAgentRequest(store, loadReq('b', { K: '2' }, 60_000), 0);
    const r = handleAgentRequest(store, { cmd: 'lock' }, 0);
    expect(r).toEqual({ ok: true, cmd: 'lock', wiped: 2 });
    expect(store.size).toBe(0);
  });

  it('lock of an absent bundle wipes nothing', () => {
    const r = handleAgentRequest(freshStore(), { cmd: 'lock', name: 'ghost' }, 0);
    expect(r).toEqual({ ok: true, cmd: 'lock', wiped: 0 });
  });

  it('status lists live bundles with key counts and hides expired ones', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq('live', { A: '1', B: '2' }, 10_000), 0); // expiresAt 10000
    handleAgentRequest(store, loadReq('dead', { C: '3' }, 1_000), 0);          // expiresAt 1000
    const r = handleAgentRequest(store, { cmd: 'status' }, 5_000);
    expect(r.ok).toBe(true);
    if (r.ok && r.cmd === 'status') {
      expect(r.entries).toEqual([{ name: 'live', expiresAt: 10_000, keyCount: 2 }]);
    }
  });

  it('load overwrites an existing bundle and resets its TTL', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq('prod', { K: 'old' }, 1_000), 0);   // expiresAt 1000
    handleAgentRequest(store, loadReq('prod', { K: 'new' }, 10_000), 500); // expiresAt 10500
    // Past the original TTL but inside the new one → still a hit with the new value.
    const r = handleAgentRequest(store, { cmd: 'get', name: 'prod' }, 2_000);
    expect(r).toMatchObject({ hit: true, env: { K: 'new' } });
  });

  it('ping reports the protocol version and the running CLI version', () => {
    const r = handleAgentRequest(freshStore(), { cmd: 'ping' }, 0);
    expect(r).toMatchObject({ ok: true, cmd: 'ping' });
    if (r.ok && r.cmd === 'ping') {
      expect(typeof r.version).toBe('number');
      // cliVersion drives staleness detection — a client compares it to its own
      // fresh on-disk read and restarts the broker on mismatch.
      expect(typeof r.cliVersion).toBe('string');
    }
  });
});

describe('secrets list metadata cache (broker-held snapshot)', () => {
  const metaKey = `${META_CACHE_PREFIX}abc123`;

  it('round-trips a metadata snapshot through the same load/get transport', () => {
    const store = freshStore();
    const snapshot = JSON.stringify([{ name: 'prod', vars: {} }, { name: 'stage', vars: {} }]);
    handleAgentRequest(store, loadReq(metaKey, { __snapshot__: snapshot }, 60_000), 0);
    const r = handleAgentRequest(store, { cmd: 'get', name: metaKey }, 1_000);
    expect(r).toMatchObject({ hit: true, env: { __snapshot__: snapshot } });
  });

  it('hides the internal metadata-cache entry from status (not a user bundle)', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq('prod', { K: 'v' }, 60_000), 0);
    handleAgentRequest(store, loadReq(metaKey, { __snapshot__: '[]' }, 60_000), 0);
    const r = handleAgentRequest(store, { cmd: 'status' }, 1_000);
    if (r.ok && r.cmd === 'status') {
      expect(r.entries.map((e) => e.name)).toEqual(['prod']); // metaKey excluded
    }
  });

  it('lock-all still wipes the metadata cache (sleep / explicit lock drops it too)', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq(metaKey, { __snapshot__: '[]' }, 60_000), 0);
    handleAgentRequest(store, { cmd: 'lock' }, 0);
    expect(handleAgentRequest(store, { cmd: 'get', name: metaKey }, 0)).toMatchObject({ hit: false });
  });

  it('realBundleCount excludes the metadata cache so it cannot pin the broker on old code (#435)', () => {
    const store = freshStore();
    // A metadata-only store must read as empty for self-heal / idle-exit.
    handleAgentRequest(store, loadReq(metaKey, { __snapshot__: '[]' }, 60_000), 0);
    expect(store.size).toBe(1);
    expect(realBundleCount(store)).toBe(0);
    // A real unlock counts; the meta entry still does not.
    handleAgentRequest(store, loadReq('prod', { K: 'v' }, 60_000), 0);
    expect(realBundleCount(store)).toBe(1);
  });
});

describe('shouldSelfHealForUpgrade (#435: never wipe a hot cache on upgrade)', () => {
  it('defers the restart while bundles are unlocked, even on a version change', () => {
    // The bug: an in-place `npm i -g` bumped the version, the broker self-healed
    // immediately, wiped the in-memory unlocks, and the next read re-prompted.
    expect(shouldSelfHealForUpgrade(true, 1, '1.20.21', '1.20.22')).toBe(false);
    expect(shouldSelfHealForUpgrade(true, 5, '1.20.21', '1.20.22')).toBe(false);
  });

  it('self-heals once the store is empty and the version changed', () => {
    expect(shouldSelfHealForUpgrade(true, 0, '1.20.21', '1.20.22')).toBe(true);
  });

  it('does not restart when the version is unchanged', () => {
    expect(shouldSelfHealForUpgrade(true, 0, '1.20.22', '1.20.22')).toBe(false);
  });

  it('never self-heals a non-persistent (one-off) broker', () => {
    expect(shouldSelfHealForUpgrade(false, 0, '1.20.21', '1.20.22')).toBe(false);
  });

  it('does not restart on an unknown version on either side (no spurious flap)', () => {
    expect(shouldSelfHealForUpgrade(true, 0, 'unknown', '1.20.22')).toBe(false);
    expect(shouldSelfHealForUpgrade(true, 0, '1.20.22', 'unknown')).toBe(false);
  });
});

describe('shouldWipeOnWatchEvent (screen-lock survives, sleep wipes)', () => {
  it('wipes on SLEEP', () => {
    expect(shouldWipeOnWatchEvent('SLEEP')).toBe(true);
    expect(shouldWipeOnWatchEvent('SLEEP\n')).toBe(true);
  });

  it('does NOT wipe on a bare screen-lock', () => {
    // The whole point of the ~7d hold: locking the screen must not re-prompt.
    expect(shouldWipeOnWatchEvent('LOCK')).toBe(false);
    expect(shouldWipeOnWatchEvent('LOCK\n')).toBe(false);
  });

  it('ignores unrelated / empty helper chatter', () => {
    expect(shouldWipeOnWatchEvent('')).toBe(false);
    expect(shouldWipeOnWatchEvent('UNLOCK')).toBe(false);
    expect(shouldWipeOnWatchEvent('ASLEEPING')).toBe(false); // word-boundary guarded
  });

  it('still wipes when SLEEP arrives batched with a LOCK line', () => {
    expect(shouldWipeOnWatchEvent('LOCK\nSLEEP\n')).toBe(true);
  });
});

// Unlike the store tests above, this one exercises the real socket transport:
// agentEvictSync is the synchronous write-path eviction (writeBundle calls it
// after a mutating write), and its failure mode — silently never evicting —
// is exactly the stale-broker bug it exists to fix. The broker stand-in must
// be a SEPARATE process (like the real broker): agentEvictSync is spawnSync
// and blocks the caller's event loop, so an in-process server could never
// reply. It records each request to a file this test then reads. Darwin-only,
// like the production path (agentEvictSync no-ops off darwin).
const RECORDING_BROKER = `
const net = require('net'); const fs = require('fs');
const sock = process.argv[1], out = process.argv[2];
net.createServer((c) => {
  c.setEncoding('utf-8'); let buf = '';
  c.on('data', (d) => {
    buf += d;
    const nl = buf.indexOf('\\n');
    if (nl < 0) return;
    fs.appendFileSync(out, buf.slice(0, nl) + '\\n');
    c.write(JSON.stringify({ ok: true, cmd: 'lock', wiped: 0 }) + '\\n');
  });
}).listen(sock);
`;

describe.skipIf(process.platform !== 'darwin')('agentEvictSync (real socket round-trip)', () => {
  // The bug surface here is the REQUEST SHAPE: a lock-by-name, never a
  // name-less lock (which wipes every held bundle and re-prompts Touch ID for
  // all of them). This drives `runAgentLockSync` — the exact body the spawned
  // `secrets _agent-lock` subcommand runs — against a real recording broker
  // over a real socket, so the framing and the shape are genuinely exercised.
  //
  // It deliberately does not go through `agentEvictSync`'s spawn hop: that
  // spawns the `agents` CLI, and under vitest `getAgentsBinPath()` resolves
  // process.argv[1] to the vitest runner rather than the CLI, so the child
  // could never answer. The spawn hop is covered instead by the launch-shape
  // tests below, which assert the argv the old `-e` code got wrong.
  it('sends one lock-by-name request to the broker socket', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-evict-test-'));
    const prevDir = process.env.AGENTS_SECRETS_AGENT_DIR;
    process.env.AGENTS_SECRETS_AGENT_DIR = dir;
    const sock = path.join(dir, 'agent.sock');
    const out = path.join(dir, 'received.jsonl');
    const broker = spawn(process.execPath, ['-e', RECORDING_BROKER, sock, out], { stdio: 'ignore' });
    try {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(sock)) {
        if (Date.now() > deadline) throw new Error('recording broker never bound its socket');
        await new Promise((r) => setTimeout(r, 25));
      }
      await runAgentLockSync('prod');
      const received = fs.readFileSync(out, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Request);
      expect(received).toEqual([{ cmd: 'lock', name: 'prod' }]);
    } finally {
      broker.kill();
      if (prevDir === undefined) delete process.env.AGENTS_SECRETS_AGENT_DIR;
      else process.env.AGENTS_SECRETS_AGENT_DIR = prevDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a silent no-op when no broker socket exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-evict-test-'));
    const prevDir = process.env.AGENTS_SECRETS_AGENT_DIR;
    process.env.AGENTS_SECRETS_AGENT_DIR = dir;
    try {
      expect(() => agentEvictSync('prod')).not.toThrow();
    } finally {
      if (prevDir === undefined) delete process.env.AGENTS_SECRETS_AGENT_DIR;
      else process.env.AGENTS_SECRETS_AGENT_DIR = prevDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== 'darwin')('retireLegacySecretsAgentService (#416 step 2: retire the standalone service)', () => {
  const SERVICE_PLIST = 'com.phnx-labs.agents-secrets-agent.plist';

  function withRelocatedLaunchAgents<T>(fn: (dir: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-launchagents-'));
    const prev = process.env.AGENTS_SECRETS_LAUNCHAGENTS_DIR;
    process.env.AGENTS_SECRETS_LAUNCHAGENTS_DIR = dir;
    try {
      return fn(dir);
    } finally {
      if (prev === undefined) delete process.env.AGENTS_SECRETS_LAUNCHAGENTS_DIR;
      else process.env.AGENTS_SECRETS_LAUNCHAGENTS_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('detects a legacy plist and removes it on retire', () => {
    withRelocatedLaunchAgents((dir) => {
      const plist = path.join(dir, SERVICE_PLIST);
      fs.writeFileSync(plist, '<plist/>');
      expect(secretsAgentServiceInstalled()).toBe(true);

      retireLegacySecretsAgentService();

      // The plist is gone, so the service reads as retired. (A relocated dir is
      // not launchd-managed, so retire is a pure file removal here.)
      expect(fs.existsSync(plist)).toBe(false);
      expect(secretsAgentServiceInstalled()).toBe(false);
    });
  });

  it('is an idempotent no-op when no legacy plist is present', () => {
    withRelocatedLaunchAgents(() => {
      expect(secretsAgentServiceInstalled()).toBe(false);
      expect(() => retireLegacySecretsAgentService()).not.toThrow();
      expect(() => retireLegacySecretsAgentService()).not.toThrow();
      expect(secretsAgentServiceInstalled()).toBe(false);
    });
  });
});

describe.skipIf(process.platform !== 'darwin')('startHostedBroker (#416: broker hosted in the daemon)', () => {
  it('binds the socket, answers agentPing over the wire, and close() tears it down', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-hosted-broker-'));
    const prevDir = process.env.AGENTS_SECRETS_AGENT_DIR;
    process.env.AGENTS_SECRETS_AGENT_DIR = dir;
    const sock = path.join(dir, 'agent.sock');
    let broker: { close(): void } | null = null;
    try {
      broker = await startHostedBroker();
      // Real socket bound on the isolated temp dir — same wire protocol as the
      // standalone broker, so agentPing (a real socket round-trip) succeeds.
      expect(broker).not.toBeNull();
      expect(fs.existsSync(sock)).toBe(true);
      expect((await agentPing()).reachable).toBe(true);

      // Daemon-safe teardown: no process.exit — close() just releases the socket.
      broker!.close();
      broker = null;
      expect(fs.existsSync(sock)).toBe(false);
      expect((await agentPing()).reachable).toBe(false);
    } finally {
      broker?.close();
      if (prevDir === undefined) delete process.env.AGENTS_SECRETS_AGENT_DIR;
      else process.env.AGENTS_SECRETS_AGENT_DIR = prevDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never clobbers a live broker — a second startHostedBroker returns null', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-hosted-broker2-'));
    const prevDir = process.env.AGENTS_SECRETS_AGENT_DIR;
    process.env.AGENTS_SECRETS_AGENT_DIR = dir;
    let first: { close(): void } | null = null;
    try {
      first = await startHostedBroker();
      expect(first).not.toBeNull();
      expect((await agentPing()).reachable).toBe(true);
      // A second host attempt while the first is live must back off (EADDRINUSE
      // + the socket answers agentPing) rather than unlink + steal the socket.
      const second = await startHostedBroker();
      expect(second).toBeNull();
      // The first broker is still serving — not orphaned.
      expect((await agentPing()).reachable).toBe(true);
    } finally {
      first?.close();
      if (prevDir === undefined) delete process.env.AGENTS_SECRETS_AGENT_DIR;
      else process.env.AGENTS_SECRETS_AGENT_DIR = prevDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a persistent loser quiescent, then takes over after the hosted broker stops', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-hosted-then-standalone-'));
    const prevDir = process.env.AGENTS_SECRETS_AGENT_DIR;
    process.env.AGENTS_SECRETS_AGENT_DIR = dir;
    const sock = path.join(dir, 'agent.sock');
    const pid = path.join(dir, 'agent.pid');
    let hosted: { close(): void } | null = null;
    let standalone: { close(): void } | null = null;
    try {
      hosted = await startHostedBroker();
      expect(hosted).not.toBeNull();
      expect((await agentPing()).reachable).toBe(true);

      // Reproduces postinstall ownership order: the daemon has already bound
      // the broker and launchd then starts the installed standalone service.
      const starting = runSecretsAgent({ service: true });
      const state = await Promise.race([
        starting.then(() => 'returned'),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 600)),
      ]);

      // Returning would make launchd KeepAlive restart the loser forever. It
      // must stay alive as the single pid-file owner without touching the live
      // daemon socket.
      expect(state).toBe('waiting');
      expect(fs.existsSync(sock)).toBe(true);
      expect(fs.readFileSync(pid, 'utf-8')).toBe(String(process.pid));
      expect((await agentPing()).reachable).toBe(true);

      // If the daemon owner stops, the quiescent service becomes the broker
      // instead of leaving the socket unavailable until launchd retries it.
      hosted.close();
      hosted = null;
      standalone = await new Promise<{ close(): void } | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('standalone takeover timed out')), 3000);
        starting.then((handle) => {
          clearTimeout(timer);
          resolve(handle);
        }, reject);
      });
      expect(standalone).not.toBeNull();
      expect((await agentPing()).reachable).toBe(true);
    } finally {
      standalone?.close();
      hosted?.close();
      if (prevDir === undefined) delete process.env.AGENTS_SECRETS_AGENT_DIR;
      else process.env.AGENTS_SECRETS_AGENT_DIR = prevDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases the standby pid file when launchd terminates the waiting process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-standby-sigterm-'));
    const prevDir = process.env.AGENTS_SECRETS_AGENT_DIR;
    process.env.AGENTS_SECRETS_AGENT_DIR = dir;
    const pid = path.join(dir, 'agent.pid');
    let hosted: { close(): void } | null = null;
    let child: ReturnType<typeof spawn> | null = null;
    let stderr = '';
    try {
      hosted = await startHostedBroker();
      expect(hosted).not.toBeNull();

      const agentModule = new URL('./agent.ts', import.meta.url).href;
      const childProgram = `import { runSecretsAgent } from ${JSON.stringify(agentModule)}; await runSecretsAgent({ service: true });`;
      child = spawn(process.execPath, [
        '--import', 'tsx',
        '--input-type=module',
        '--eval', childProgram,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, AGENTS_SECRETS_AGENT_DIR: dir },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr?.setEncoding('utf-8');
      child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (fs.existsSync(pid) && fs.readFileSync(pid, 'utf-8') === String(child.pid)) break;
        if (child.exitCode !== null) throw new Error(`standby exited before readiness: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(fs.readFileSync(pid, 'utf-8')).toBe(String(child.pid));

      child.kill('SIGTERM');
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child!.once('close', (code, signal) => resolve({ code, signal }));
      });
      expect(exit, stderr).toEqual({ code: 0, signal: null });
      expect(fs.existsSync(pid)).toBe(false);
    } finally {
      if (child?.exitCode === null) child.kill('SIGKILL');
      hosted?.close();
      if (prevDir === undefined) delete process.env.AGENTS_SECRETS_AGENT_DIR;
      else process.env.AGENTS_SECRETS_AGENT_DIR = prevDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('shouldTeardownVersionSkewedBroker (client-side #435 twin: never wipe a hot cache)', () => {
  it('keeps a version-skewed broker that holds real unlocks', () => {
    // Tearing it down would wipe every held bundle and re-prompt Touch ID for
    // each — the storm on machines where installed versions churn (dev builds
    // stamping a new 0.0.0-dev.<sha> per install, npm + dev copies alternating).
    expect(shouldTeardownVersionSkewedBroker(1)).toBe(false);
    expect(shouldTeardownVersionSkewedBroker(5)).toBe(false);
  });

  it('tears down an empty version-skewed broker so it relaunches on new code', () => {
    expect(shouldTeardownVersionSkewedBroker(0)).toBe(true);
  });
});

describe('clampHoldMs (configurable 24h hold cap)', () => {
  it('passes a valid value through (24h stays 24h)', () => {
    expect(clampHoldMs(24 * 60 * 60 * 1000)).toBe(24 * 60 * 60 * 1000);
  });

  it('falls back to the 7d default for absent / non-numeric / non-positive values', () => {
    for (const v of [undefined, null, NaN, 0, -5, '86400000', {}]) {
      expect(clampHoldMs(v)).toBe(DEFAULT_TTL_MS);
    }
  });

  it('clamps below the floor up to MIN_HOLD_MS and above the ceiling down to MAX_HOLD_MS', () => {
    expect(clampHoldMs(1000)).toBe(MIN_HOLD_MS);                 // 1s -> 1m floor
    expect(clampHoldMs(999 * 24 * 60 * 60 * 1000)).toBe(MAX_HOLD_MS); // 999d -> 30d ceiling
  });

  it('floors fractional milliseconds', () => {
    expect(clampHoldMs(MIN_HOLD_MS + 0.9)).toBe(MIN_HOLD_MS);
  });
});

describe('isRequestAuthorized (RUSH-1760: authorization gate)', () => {
  it('always allows ping, with or without a token expected', () => {
    expect(isRequestAuthorized({ cmd: 'ping' }, 'tok')).toBe(true);
    expect(isRequestAuthorized({ cmd: 'ping' }, null)).toBe(true);
  });

  it('rejects load/get/lock/status without a matching token', () => {
    expect(isRequestAuthorized({ cmd: 'get', name: 'p' }, 'tok')).toBe(false);
    expect(isRequestAuthorized({ cmd: 'get', name: 'p', token: 'wrong' }, 'tok')).toBe(false);
    expect(isRequestAuthorized(loadReq('p', {}, 1000), 'tok')).toBe(false);
    expect(isRequestAuthorized({ cmd: 'lock' }, 'tok')).toBe(false);
    expect(isRequestAuthorized({ cmd: 'status' }, 'tok')).toBe(false);
  });

  it('allows a command carrying the correct token', () => {
    expect(isRequestAuthorized({ cmd: 'get', name: 'p', token: 'tok' }, 'tok')).toBe(true);
    expect(isRequestAuthorized({ ...loadReq('p', {}, 1000), token: 'tok' }, 'tok')).toBe(true);
    expect(isRequestAuthorized({ cmd: 'status', token: 'tok' }, 'tok')).toBe(true);
  });

  it('fails closed when no token is expected (token file missing)', () => {
    expect(isRequestAuthorized({ cmd: 'get', name: 'p', token: 'anything' }, null)).toBe(false);
    expect(isRequestAuthorized({ cmd: 'status', token: 'x' }, '')).toBe(false);
  });
});

// Unix-domain sockets on a filesystem path are POSIX-only here; skip on Windows.
(process.platform === 'win32' ? describe.skip : describe)(
  'makeConnectionHandler — auth gate over a real socket (RUSH-1760)',
  () => {
    function roundtrip(sock: string, req: unknown): Promise<any> {
      return new Promise((resolve, reject) => {
        const c = net.createConnection(sock);
        let buf = '';
        c.on('error', reject);
        c.on('connect', () => c.write(JSON.stringify(req) + '\n'));
        c.setEncoding('utf-8');
        c.on('data', (d: string) => {
          buf += d;
          const nl = buf.indexOf('\n');
          if (nl < 0) return;
          try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
          try { c.destroy(); } catch { /* ignore */ }
        });
      });
    }

    it('rejects unauthenticated load/get (store untouched) and accepts tokenized ones', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-gate-'));
      const sock = path.join(dir, 'g.sock');
      const store = freshStore();
      const TOKEN = 'cap-token-xyz';
      const handle = (req: Request): Response => handleAgentRequest(store, req);
      const server = net.createServer(makeConnectionHandler(handle, () => TOKEN));
      await new Promise<void>((res) => server.listen(sock, () => res()));

      try {
        // The RUSH-1760 hole: an unauthenticated `load` must be rejected and must
        // NOT mutate the store.
        const bad = await roundtrip(sock, { cmd: 'load', name: 'prod', bundle: bundle('prod'), env: { K: 'v' }, ttlMs: 60_000 });
        expect(bad).toEqual({ ok: false, error: 'unauthorized' });
        expect(store.has('prod')).toBe(false);

        // Wrong token is likewise rejected.
        expect(await roundtrip(sock, { cmd: 'get', name: 'prod', token: 'nope' }))
          .toEqual({ ok: false, error: 'unauthorized' });

        // Correct token: load lands, and an authorized get reads it back.
        expect(await roundtrip(sock, { cmd: 'load', name: 'prod', bundle: bundle('prod'), env: { K: 'v' }, ttlMs: 60_000, token: TOKEN }))
          .toEqual({ ok: true, cmd: 'load' });
        expect(store.has('prod')).toBe(true);
        expect(await roundtrip(sock, { cmd: 'get', name: 'prod', token: TOKEN }))
          .toMatchObject({ ok: true, cmd: 'get', hit: true, env: { K: 'v' } });
      } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('answers ping without a token even when one is expected', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-gate-'));
      const sock = path.join(dir, 'p.sock');
      const server = net.createServer(makeConnectionHandler(
        (req) => handleAgentRequest(freshStore(), req),
        () => 'some-token',
      ));
      await new Promise<void>((res) => server.listen(sock, () => res()));
      try {
        expect(await roundtrip(sock, { cmd: 'ping' })).toMatchObject({ ok: true, cmd: 'ping' });
      } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

/**
 * Regression guard for the Touch-ID-on-every-read bug.
 *
 * The three synchronous broker clients (agentGetSync / agentReachableSync /
 * agentEvictSync) used to spawn `process.execPath -e <inline node program>`.
 * That is only valid when `process.execPath` is node. On the bun-compiled
 * standalone binary shipped since 1.20.53 it resolves to the CLI itself, so the
 * spawn became `agents -e …`, commander rejected it with `unknown option '-e'`,
 * and every client took its failure path — which reads as "broker down". The
 * cache was therefore never hit on the shipped binary, the `daily` policy's
 * one-prompt-per-7d never applied, and every bundle read re-popped Touch ID.
 *
 * These assert the launch shape directly, because the failure was silent: the
 * old code still "worked" (returned null) and no test noticed.
 */
describe('sync broker clients launch correctly on both install shapes', () => {
  const subs = [
    ['secrets', '_agent-get', 'prod'],
    ['secrets', '_agent-ping'],
    ['secrets', '_agent-lock', 'prod'],
  ];

  it('never spawns with -e on the bun standalone binary', () => {
    for (const sub of subs) {
      const { command, args } = syncClientLaunch(sub, '/$bunfs/root/agents');
      // The exact bug: '-e' as argv[0] of the child, which commander rejects.
      expect(args).not.toContain('-e');
      // The bunfs virtual path is not exec-able and must never be command or argv.
      expect(command.includes('$bunfs')).toBe(false);
      expect(args.some((a) => a.includes('$bunfs'))).toBe(false);
      // The subcommand must arrive intact, or the child can't answer.
      expect(args.slice(-sub.length)).toEqual(sub);
    }
  });

  it('never spawns with -e on a plain JS install', () => {
    for (const sub of subs) {
      const { args } = syncClientLaunch(sub, '/usr/local/lib/agents-cli/dist/index.js');
      expect(args).not.toContain('-e');
      expect(args.slice(-sub.length)).toEqual(sub);
    }
  });
});

describe('lastLine', () => {
  // The child is now the full CLI, so startup chatter can share stdout with the
  // payload. Parsing the whole stream would throw and silently degrade every
  // cache hit into a miss — i.e. reintroduce the bug above.
  it('returns the payload line even when startup chatter precedes it', () => {
    const payload = '{"bundle":{"name":"prod"},"env":{"K":"v"}}';
    expect(lastLine(`agents-cli: ~/.agents/ is 4 commits behind origin/main\n${payload}\n`)).toBe(payload);
    expect(JSON.parse(lastLine(`some notice\n\n${payload}\n\n`))).toMatchObject({ env: { K: 'v' } });
  });

  it('returns the payload when it is the only line, with or without a trailing newline', () => {
    const payload = '{"env":{}}';
    expect(lastLine(payload)).toBe(payload);
    expect(lastLine(`${payload}\n`)).toBe(payload);
  });

  it('returns empty string for empty or whitespace-only stdout', () => {
    expect(lastLine('')).toBe('');
    expect(lastLine('\n  \n')).toBe('');
  });
});
