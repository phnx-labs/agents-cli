#!/usr/bin/env bun
/**
 * Benchmark + regression guard for the DISTRIBUTED / cross-fleet session-query
 * path: `agents sessions --active --local` and `agents sessions --host <peer>`.
 * Neither had a bench before this file — sessions-perf.ts covers the local
 * discover/search pipeline only.
 *
 * Two parts, each isolated to a temp directory (no HOME override needed — an
 * explicit base dir is threaded through, same technique as the correctness
 * test `agents.remote-poll.test.ts`) so nothing here touches a real
 * `~/.agents` tree:
 *
 *   A. `--active --local` — the path RUSH-2118 fixed. Builds N synthetic
 *      remote-host teammates on disk (the shape `agents teams add --device`
 *      produces: `hostName`/`hostTarget`/`remoteLog`/`remoteExit` set, no
 *      local pid), mixing RUNNING and terminal statuses, then times
 *      `AgentManager(..., localOnly=true).listAll()` — the exact call
 *      `listTeamsActive`/`getActiveSessions`/`gatherActiveSessions` make for
 *      the CLI's `--active --local` handler. Measured at this layer (not the
 *      full `gatherActiveSessions`) so the number reflects teammate-polling
 *      cost only, not ambient host noise from the other `--active` sources
 *      (tmux pane / process-table scans) that have nothing to do with the fix.
 *      A stub `ssh` shadowing the real binary on PATH turns any dial attempt
 *      into a recorded violation instead of a real network call — RUSH-2118
 *      regressed exactly this: a `--local` query firing real ssh once per
 *      remote-host teammate, on every poll, whether or not the teammate had
 *      already finished (up to 180 ssh execve calls / ~4.3s on a 30-teammate
 *      fixture — see the fix commit and `agents.remote-poll.test.ts` for the
 *      correctness side of this same guard). A positive-control run (same
 *      shim, `localOnly: false` against one still-RUNNING teammate) asserts
 *      the shim DOES observe a real dial when one is supposed to happen —
 *      without it, a shim that silently stopped intercepting would make this
 *      guard pass for the wrong reason (nothing dialed because nothing was
 *      being watched, not because the fix held).
 *
 *   B. `--host <peer>` (the distributed/cross-fleet query) — the real fan-out
 *      (`gatherActiveSessions` -> `gatherRemoteActive` ->
 *      `gatherRemoteAgentsJson`) against N synthetic peers. No live fleet is
 *      reachable in CI, and GitHub-hosted runners don't run sshd, so a
 *      loopback peer isn't an option either — the SSH boundary is mocked by
 *      shimming the `ssh` binary on PATH. The shim sleeps a configurable
 *      per-call latency, then returns a canned `--active --json` payload, so
 *      the bench measures the CLI-side fan-out/merge overhead and confirms it
 *      stays parallel (wall time ~= one round trip, not N — a regression here
 *      would mean the fan-out silently went sequential). `scripts/bench-ssh.mjs`
 *      covers the real-network-latency side of the SSH transport against a
 *      live host; this bench is CI-safe and complements it for the sessions
 *      fan-out specifically.
 *
 * PATH-shimming mechanics: every ssh caller in this codebase spawns the bare
 * command `'ssh'`, resolved via PATH search (`src/lib/ssh-exec.ts`,
 * `src/lib/remote-agents-json.ts`), so a directory prepended to PATH with a
 * same-named executable intercepts it regardless of which module invokes it —
 * PROVIDED the shim is on PATH from process start. Bun's `child_process`
 * (`spawnSync`/`execSync`, used by `sshExec`/`sshExecRaw`) resolves the
 * executable against the environment the process booted with; mutating
 * `process.env.PATH` at runtime does not reach a later `spawnSync('ssh', ...)`
 * call that omits an explicit `env` (verified empirically — a real gap this
 * bench would otherwise have shipped with silently). So this script re-execs
 * itself once, the same way `sessions-perf.ts` re-execs itself for
 * `BENCH_CORPUS=real`, with the shim directory already on `PATH` in the
 * child's `env` at spawn time — which both `spawnSync` and the async `spawn`
 * paths pick up correctly, because it is part of the process's env from
 * bootstrap, not a later mutation. The child then flips shim behavior
 * between parts by writing a small "mode" file the shim reads fresh on every
 * invocation (a plain file read is unaffected by the env quirk above).
 *
 * Both parts assert a threshold and exit 1 on violation — this is the
 * lightweight regression guard `.github/workflows/bench.yml` wires in as a
 * GATING step (unlike the informational, continue-on-error numeric benches
 * elsewhere in that workflow).
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';

const LOCAL_THRESHOLD_MS = Number(process.env.BENCH_LOCAL_THRESHOLD_MS ?? 500);
const REMOTE_TEAMMATES = Number(process.env.BENCH_REMOTE_TEAMMATES ?? 30);
const FAN_OUT_PEERS = Number(process.env.BENCH_FAN_OUT_PEERS ?? 8);
const PEER_LATENCY_MS = Number(process.env.BENCH_PEER_LATENCY_MS ?? 60);
// A regression that serializes the fan-out (N sequential round-trips instead
// of one parallel one) blows well past this multiple of a single round-trip;
// a healthy parallel fan-out stays close to 1x plus process-spawn overhead.
const PARALLELISM_FACTOR = Number(process.env.BENCH_PARALLELISM_FACTOR ?? 3);

const SHIM_ENV = 'BENCH_SESSIONS_SHIM_DIR';

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Re-exec this same script with a shim `ssh` on PATH from process bootstrap
 * (see the file-header comment for why runtime PATH mutation doesn't reach
 * `spawnSync`/`execSync` calls that omit an explicit `env`). Only the parent
 * invocation takes this branch; the child sees `BENCH_SESSIONS_SHIM_DIR` set
 * and runs the real benchmark body.
 */
function reexecWithShimOnPath(): never {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-bench-ssh-shim-'));
  // One dispatcher script for both parts: reads a "mode" file fresh on every
  // invocation (unaffected by the env-snapshot quirk — this is a plain file
  // read done by a freshly spawned `sh`, not an env lookup) so the bun child
  // can flip behavior between Part A (guard) and Part B (peer) without
  // needing to change PATH again.
  const modeFile = path.join(binDir, 'mode');
  const sentinelFile = path.join(binDir, 'ssh-calls.log');
  const latencyFile = path.join(binDir, 'latency-seconds');
  const payloadFile = path.join(binDir, 'peer-payload.json');
  fs.writeFileSync(modeFile, 'guard');
  const shimScript = [
    '#!/bin/sh',
    `MODE=$(cat ${shQuote(modeFile)} 2>/dev/null || echo guard)`,
    'if [ "$MODE" = "peer" ]; then',
    `  sleep "$(cat ${shQuote(latencyFile)} 2>/dev/null || echo 0)"`,
    `  cat ${shQuote(payloadFile)}`,
    '  exit 0',
    'fi',
    `echo "unexpected ssh call: $*" >> ${shQuote(sentinelFile)}`,
    'exit 7',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(binDir, 'ssh'), shimScript, { mode: 0o755 });

  const newPath = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  const child = spawnSync(process.execPath, [process.argv[1]], {
    stdio: 'inherit',
    env: { ...process.env, PATH: newPath, [SHIM_ENV]: binDir },
  });
  process.exit(child.status ?? 1);
}

function setShimMode(binDir: string, mode: 'guard' | 'peer'): void {
  fs.writeFileSync(path.join(binDir, 'mode'), mode);
}

function setShimLatency(binDir: string, ms: number): void {
  fs.writeFileSync(path.join(binDir, 'latency-seconds'), (Math.max(ms, 0) / 1000).toFixed(3));
}

function writeShimPayload(binDir: string, json: string): void {
  fs.writeFileSync(path.join(binDir, 'peer-payload.json'), json);
}

function countSentinelCalls(binDir: string): number {
  const sentinelFile = path.join(binDir, 'ssh-calls.log');
  if (!fs.existsSync(sentinelFile)) return 0;
  return fs.readFileSync(sentinelFile, 'utf8').split('\n').filter(Boolean).length;
}

function resetSentinel(binDir: string): void {
  fs.rmSync(path.join(binDir, 'ssh-calls.log'), { force: true });
}

async function time<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  const ms = performance.now() - t0;
  return { ms, value };
}

// ---------------------------------------------------------------------------
// Part A: `agents sessions --active --local` — RUSH-2118 guard
// ---------------------------------------------------------------------------

async function benchLocalGuard(binDir: string): Promise<{
  teammates: number;
  sessionsSeen: number;
  bestMs: number;
  allRunsMs: number[];
  sshCallsDuringLocalQuery: number;
  positiveControlSshCalls: number;
  pass: boolean;
}> {
  const { AgentManager, AgentProcess, AgentStatus } = await import('../src/lib/teams/agents.js');

  async function addTeammate(base: string, id: string, status: import('../src/lib/teams/agents.js').AgentStatus) {
    const agent = new AgentProcess(
      id, 'bench-dist-team', 'claude', 'benchmark synthetic teammate',
      null, 'plan', null, status, new Date(),
      status === AgentStatus.RUNNING ? null : new Date(), base,
    );
    agent.hostName = `bench-peer-${id}`;
    agent.hostTarget = `bench-peer-${id}.tail1a85a1.ts.net`;
    agent.repoPath = '/home/bench/.agents/repos/bench-dist-team';
    agent.remotePid = 1000;
    agent.remoteLog = '$HOME/.agents/.cache/hosts/bench.log';
    agent.remoteExit = '$HOME/.agents/.cache/hosts/bench.exit';
    agent.remoteLogOffset = 0;
    await agent.saveMeta();
  }

  setShimMode(binDir, 'guard');
  resetSentinel(binDir);

  // Positive control FIRST, on its own throwaway dataset: a still-RUNNING
  // remote teammate polled with localOnly=FALSE must legitimately dial —
  // proving the shim is actually watching before we trust its "0 calls"
  // verdict on the real --local case below (agents.remote-poll.test.ts's
  // "sanity" case, run here against the real `ssh` PATH boundary instead of
  // a vitest module mock).
  const controlBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-bench-teams-control-'));
  await addTeammate(controlBase, 'control-running', AgentStatus.RUNNING);
  const controlMgr = new AgentManager(50, controlBase, undefined, undefined, undefined, false);
  await controlMgr.listAll();
  const positiveControlSshCalls = countSentinelCalls(binDir);
  if (positiveControlSshCalls === 0) {
    throw new Error(
      'Positive control failed: a still-RUNNING remote teammate polled without --local ' +
        'made zero observed ssh calls. The ssh PATH shim is not intercepting — this bench ' +
        'cannot certify the --local guard below. (Expected the shim\'s own sentinel file to ' +
        'record at least one call.)',
    );
  }
  resetSentinel(binDir);

  // The real case: N synthetic remote-host teammates, --local (localOnly=true).
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-bench-teams-'));
  for (let i = 0; i < REMOTE_TEAMMATES; i++) {
    // Half still RUNNING, half already terminal — RUSH-2118 covers both: a
    // --local query must never dial either, and a terminal teammate must
    // never be re-dialed by ANY --active query (see agents.remote-poll.test.ts).
    const status = i % 2 === 0 ? AgentStatus.RUNNING : AgentStatus.COMPLETED;
    await addTeammate(base, `bench-remote-${i}`, status);
  }

  const runs: number[] = [];
  let sessionsSeen = 0;
  for (let i = 0; i < 3; i++) {
    // A fresh AgentManager per run (like the CLI does per invocation) so
    // doInitialize()'s own initial poll — the one RUSH-2118 regressed — is
    // what gets timed, not a warm in-memory cache from a prior run.
    // localOnly=true is the 6th constructor arg — this is the `--local`
    // query path (listTeamsActive -> new AgentManager(..., opts.localOnly)).
    const mgr = new AgentManager(50, base, undefined, undefined, undefined, true);
    const r = await time(() => mgr.listAll());
    runs.push(r.ms);
    sessionsSeen = r.value.length;
  }
  const bestMs = Math.min(...runs);
  const sshCallsDuringLocalQuery = countSentinelCalls(binDir);
  const pass = sshCallsDuringLocalQuery === 0 && bestMs < LOCAL_THRESHOLD_MS;
  return {
    teammates: REMOTE_TEAMMATES,
    sessionsSeen,
    bestMs,
    allRunsMs: runs,
    sshCallsDuringLocalQuery,
    positiveControlSshCalls,
    pass,
  };
}

// ---------------------------------------------------------------------------
// Part B: `agents sessions --host <peer>` — distributed fan-out
// ---------------------------------------------------------------------------

function cannedPeerPayload(): string {
  const sessions = [
    {
      context: 'terminal',
      kind: 'claude',
      sessionId: 'bench-0000-0000-0000-000000000001',
      pid: 4242,
      cwd: '/home/bench/project',
      topic: 'benchmark synthetic session',
      activity: 'working',
    },
    {
      context: 'headless',
      kind: 'codex',
      sessionId: 'bench-0000-0000-0000-000000000002',
      pid: 4243,
      cwd: '/home/bench/project',
      topic: 'benchmark synthetic session 2',
      activity: 'idle',
    },
  ];
  return JSON.stringify(sessions);
}

async function benchDistributedFanOut(binDir: string): Promise<{
  peers: number;
  perPeerLatencyMs: number;
  bestMs: number;
  allRunsMs: number[];
  sessionsSeen: number;
  parallelismThresholdMs: number;
  pass: boolean;
}> {
  const { gatherActiveSessions } = await import('../src/commands/sessions.js');

  setShimMode(binDir, 'peer');
  setShimLatency(binDir, PEER_LATENCY_MS);
  writeShimPayload(binDir, cannedPeerPayload());

  // Ad-hoc `user@ip` tokens resolve as literal peers with no devices-registry
  // entry needed (matchHost's ad-hoc-literal branch — see
  // src/lib/hosts/registry.ts) and each carries a distinct machine id (the ip
  // part), so N peers merge into N distinct rows even though every shimmed
  // ssh call returns byte-identical stdout.
  const hosts = Array.from({ length: FAN_OUT_PEERS }, (_, i) => `bench${i}@10.99.0.${i + 1}`);

  const runs: number[] = [];
  let sessionsSeen = 0;
  for (let i = 0; i < 3; i++) {
    const r = await time(() => gatherActiveSessions({ hosts }));
    runs.push(r.ms);
    sessionsSeen = r.value.sessions.length;
  }
  const bestMs = Math.min(...runs);
  const parallelismThresholdMs = PEER_LATENCY_MS * PARALLELISM_FACTOR;
  const pass = bestMs < parallelismThresholdMs;
  return {
    peers: FAN_OUT_PEERS,
    perPeerLatencyMs: PEER_LATENCY_MS,
    bestMs,
    allRunsMs: runs,
    sessionsSeen,
    parallelismThresholdMs,
    pass,
  };
}

async function main() {
  const binDir = process.env[SHIM_ENV];
  if (!binDir) reexecWithShimOnPath();

  const local = await benchLocalGuard(binDir!);
  console.error(
    `A. --active --local (${local.teammates} synthetic remote-host teammates): ` +
      `best ${local.bestMs.toFixed(1)}ms, ${local.sshCallsDuringLocalQuery} ssh calls ` +
      `(threshold ${LOCAL_THRESHOLD_MS}ms, 0 calls; positive control observed ` +
      `${local.positiveControlSshCalls} call(s)) — ${local.pass ? 'PASS' : 'FAIL'}`,
  );

  const distributed = await benchDistributedFanOut(binDir!);
  console.error(
    `B. --host fan-out (${distributed.peers} synthetic peers, ${distributed.perPeerLatencyMs}ms/call): ` +
      `best ${distributed.bestMs.toFixed(1)}ms (parallelism threshold ${distributed.parallelismThresholdMs}ms) ` +
      `— ${distributed.pass ? 'PASS' : 'FAIL'}`,
  );

  const result = {
    node: process.version,
    timestamp: new Date().toISOString(),
    local,
    distributed,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (!local.pass || !distributed.pass) {
    console.error('\nFAIL: distributed session-query regression guard tripped.');
    if (!local.pass) {
      console.error(
        `  - Part A: ${local.sshCallsDuringLocalQuery} ssh call(s) during a --local query ` +
          `(want 0), best run ${local.bestMs.toFixed(1)}ms (want < ${LOCAL_THRESHOLD_MS}ms). ` +
          'A --local query must never dial a remote-host teammate (RUSH-2118).',
      );
    }
    if (!distributed.pass) {
      console.error(
        `  - Part B: fan-out took ${distributed.bestMs.toFixed(1)}ms for ${distributed.peers} peers ` +
          `at ${distributed.perPeerLatencyMs}ms/call (want < ${distributed.parallelismThresholdMs}ms). ` +
          'The peer fan-out may have gone sequential.',
      );
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
