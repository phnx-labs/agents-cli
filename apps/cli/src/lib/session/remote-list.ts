/**
 * Cross-machine fan-out for the default `agents sessions` listing.
 *
 * `discoverSessions()` only scans the local disk. To browse the whole fleet in
 * one list — without syncing anything — we run `agents sessions <same query>
 * --json` on each peer over SSH and merge the parsed `SessionMeta[]`, tagging
 * every row with the machine it came from so the picker/table can label and
 * group by computer.
 *
 * This is the browse-listing sibling of `remote-active.ts` (which fans out
 * `--active`): same transport, same device set, same recursion guard. The peer
 * runs with `AGENTS_SESSIONS_LOCAL=1` so it answers only for itself and the
 * sweep never recurses. A dead or slow host is skipped with a stderr note,
 * never fatal — one asleep laptop must not blank the list.
 */
import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import chalk from 'chalk';
import { SSH_OPTS, controlOpts, assertValidSshTarget, shellQuote } from '../ssh-exec.js';
import { sshTargetFor } from '../devices/connect.js';
import { resolveExplicitTargetSet } from '../devices/resolve-target.js';
import { loadDevices, isControlDevice, isDialableDevice, type DeviceProfile } from '../devices/registry.js';
import { remoteShellFor, buildWindowsAgentsCommand } from '../hosts/remote-cmd.js';
import { machineId, normalizeHost } from './sync/config.js';
import { NO_FANOUT_ENV } from './remote-active.js';
import { terminalWidth } from './width.js';
import { sanitizeForTerminal } from '../redact.js';
import { mapBounded } from '../concurrency.js';
import type { SessionMeta } from './types.js';
import {
  TOOL_QUERY_MAX_CLAUSE_BYTES,
  TOOL_QUERY_MAX_CALL_ROWS,
  TOOL_QUERY_MAX_CLAUSES,
  TOOL_QUERY_MAX_RESULT_SESSIONS,
  TOOL_QUERY_MAX_SERIALIZED_BYTES,
  serializedToolSearchEnvelopeBytes,
  type ToolCallEvidence,
  type ToolSearchEnvelope,
  type ToolSessionEvidence,
} from './tool-index.js';
import {
  TOOL_ERROR_OUTPUT_MAX_BYTES,
  TOOL_INPUT_MAX_BYTES,
  TOOL_SUCCESS_OUTPUT_MAX_BYTES,
  sanitizeToolEvidenceText,
} from './tool-calls.js';

/** Per-host SSH budget. Slightly above SSH_OPTS' ConnectTimeout=10 so a
 * reachable-but-slow remote still answers before we give up. */
const REMOTE_LIST_TIMEOUT_MS = 12_000;
const REMOTE_TOOL_TIMEOUT_MS = 60_000;
export const REMOTE_STDOUT_MAX_BYTES = 16 * 1024 * 1024;
export const REMOTE_TOOL_AGGREGATE_MAX_BYTES = TOOL_QUERY_MAX_SERIALIZED_BYTES;

export interface RemoteToolByteBudget {
  remainingBytes: number;
  exhausted: boolean;
}

/** Preserve UTF-8 code points when SSH splits them across stdout chunks. */
export class RemoteUtf8Accumulator {
  private readonly decoder = new StringDecoder('utf8');
  private value = '';

  write(chunk: Buffer): void {
    this.value += this.decoder.write(chunk);
  }

  end(): string {
    this.value += this.decoder.end();
    return this.value;
  }

  current(): string {
    return this.value;
  }
}

/** Claim received bytes against one fleet-query budget before retaining them. */
export function consumeRemoteToolByteBudget(budget: RemoteToolByteBudget, bytes: number): boolean {
  if (budget.exhausted || bytes > budget.remainingBytes) {
    budget.remainingBytes = 0;
    budget.exhausted = true;
    return false;
  }
  budget.remainingBytes -= bytes;
  if (budget.remainingBytes === 0) budget.exhausted = true;
  return true;
}

/** Charge sanitized, machine-stamped evidence because redaction may expand it. */
export function consumeParsedRemoteToolSearchBudget(
  budget: RemoteToolByteBudget,
  envelope: ToolSearchEnvelope,
): boolean {
  return consumeRemoteToolByteBudget(budget, serializedToolSearchEnvelopeBytes(envelope));
}

/**
 * The command run on each peer: answer for itself, as JSON, without recursing.
 * `forwardedArgs` carry the caller's own query/filters (already including the
 * leading `sessions` and a `--json`) so each peer returns a comparable slice.
 * A Windows peer gets a PowerShell invocation (ssh lands in cmd.exe/PowerShell
 * there, where `bash -lc` is not a command); every other OS keeps `bash -lc`.
 */
export function remoteListCommand(forwardedArgs: string[], os?: string): string {
  if (remoteShellFor(os) === 'powershell') {
    return buildWindowsAgentsCommand({
      args: forwardedArgs,
      env: { [NO_FANOUT_ENV]: '1' },
    });
  }
  const inner = [`${NO_FANOUT_ENV}=1`, 'agents', ...forwardedArgs].map((t, i) =>
    i === 0 ? t : shellQuote(t),
  ).join(' ');
  return `bash -lc ${shellQuote(inner)}`;
}

/**
 * Parse a peer's `sessions --json` stdout into `SessionMeta[]`, tagging each
 * with `machine`. Defensive against version skew / partial output: non-JSON or
 * a non-array yields `[]`, and non-object entries are dropped rather than
 * throwing. The `machine` we dialed always wins over any value the peer set on
 * its own rows, so grouping keys off the computer we asked. Exported for unit
 * testing without a live tailnet.
 */
export function parseRemoteList(stdout: string, machine: string): SessionMeta[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value) => value && typeof value === 'object' && !Array.isArray(value)
    ? [{ ...(value as SessionMeta), machine, _remote: true }]
    : []);
}

/** Strict parser used at the live peer boundary. A successful process with
 * malformed/non-array JSON is an incomplete source, not an empty machine. */
const SAFE_RESOLVER_KEYS = new Set([
  'id', 'shortId', 'agent', 'origin', 'timestamp', 'lastActivity', 'project',
  'version', 'label', 'topic', 'machine',
]);

function isSafeResolverRow(value: Record<string, unknown>): boolean {
  if (typeof value.id !== 'string' || typeof value.shortId !== 'string'
    || typeof value.agent !== 'string' || typeof value.timestamp !== 'string') return false;
  return Object.keys(value).every(key => SAFE_RESOLVER_KEYS.has(key));
}

export function parseRemoteListPayload(stdout: string, machine: string, safeResolver = false): {
  sessions: SessionMeta[];
  valid: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { sessions: [], valid: false };
  }
  if (!Array.isArray(parsed)) return { sessions: [], valid: false };
  const out: SessionMeta[] = [];
  for (const x of parsed) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { sessions: [], valid: false };
    if (safeResolver && !isSafeResolverRow(x as Record<string, unknown>)) {
      return { sessions: [], valid: false };
    }
    // `_remote` marks these as living on the peer's disk (not a local mirror),
    // so the picker routes read/resume back over SSH instead of the local FS.
    out.push({ ...(x as SessionMeta), machine, _remote: true });
  }
  return { sessions: out, valid: true };
}

/** Convert one completed peer process into the exact aggregation result. This
 * is the production parent/peer seam and is exercised with real child output. */
export function remoteListCaptureResult(
  code: number | null,
  stdout: string,
  machine: string,
  display: string,
  safeResolver = false,
): { sessions: SessionMeta[]; unreachable?: string } {
  if (code !== 0) return { sessions: [], unreachable: display };
  const parsed = parseRemoteListPayload(stdout, machine, safeResolver);
  return parsed.valid ? { sessions: parsed.sessions } : { sessions: [], unreachable: display };
}

/** Run one remote `agents sessions … --json` and capture stdout. Resolves
 * `{ code: null }` on spawn error or timeout (host treated as dead). */
export function sshCapture(
  target: string,
  remoteCmd: string,
  timeoutMs: number,
  aggregateBudget?: RemoteToolByteBudget,
  options: { multiplex?: boolean; port?: number; hostKeyOpts?: string[] } = {},
): Promise<{ code: number | null; stdout: string; aggregateBudgetExceeded?: boolean }> {
  assertValidSshTarget(target);
  return new Promise((resolve) => {
    const args = [
      ...(options.hostKeyOpts ?? []),
      ...SSH_OPTS,
      ...(options.multiplex === false ? [] : controlOpts()),
      ...(options.port === undefined ? [] : ['-p', String(options.port)]),
      target,
      remoteCmd,
    ];
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const decoded = new RemoteUtf8Accumulator();
    let stdoutBytes = 0;
    let aggregateBudgetExceeded = false;
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = code === null ? decoded.current() : decoded.end();
      resolve({ code, stdout, aggregateBudgetExceeded: aggregateBudgetExceeded || undefined });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(null); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (stdoutBytes + d.byteLength > REMOTE_STDOUT_MAX_BYTES) {
        child.kill('SIGKILL');
        done(null);
        return;
      }
      if (aggregateBudget && !consumeRemoteToolByteBudget(aggregateBudget, d.byteLength)) {
        aggregateBudgetExceeded = true;
        child.kill('SIGKILL');
        done(null);
        return;
      }
      stdoutBytes += d.byteLength;
      decoded.write(d);
    });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });
}

async function fetchByTarget(
  target: string,
  machine: string,
  display: string,
  forwardedArgs: string[],
  os?: string
): Promise<{ sessions: SessionMeta[]; unreachable?: string }> {
  const { code, stdout } = await sshCapture(target, remoteListCommand(forwardedArgs, os), REMOTE_LIST_TIMEOUT_MS);
  const safeResolver = forwardedArgs.includes('--resolve-safe-v1');
  const result = remoteListCaptureResult(code, stdout, machine, display, safeResolver);
  if (result.unreachable) {
    process.stderr.write(chalk.gray(`  ${display}: unreachable or no agents CLI — skipped\n`));
  }
  return result;
}

export interface RemoteListResult {
  sessions: SessionMeta[];
  /** How many peer machines we attempted to reach (drives the empty-fleet tip). */
  deviceCount: number;
  /**
   * Peers that failed to answer, by display name. The stderr note above is
   * enough for a printed listing, but the interactive browser repaints over it —
   * so callers rendering a full-screen UI need the outcome as data to tell
   * "that box is asleep" apart from "that box has no matching sessions".
   */
  unreachable: string[];
}

/** Keep browse and tool-search fan-out on the same automatic peer set. */
export function isAutomaticSessionPeer(d: DeviceProfile, self: string): boolean {
  if (!isDialableDevice(d)) return false;
  if (normalizeHost(d.name) === self || isControlDevice(d)) return false;
  return d.platform === 'windows' || d.platform === 'linux' || d.platform === 'macos';
}

/**
 * Gather listing sessions from other machines. With an explicit `hosts` list
 * (from `--host`), fan out to exactly those. Otherwise sweep the registered,
 * online devices from `ag devices`, excluding this machine and any without an
 * address. `forwardedArgs` are the caller's own sessions args (query + filters,
 * already `--json`) so every peer returns the same slice this machine asked for.
 */
export async function gatherRemoteList(forwardedArgs: string[], hosts?: string[]): Promise<RemoteListResult> {
  const self = machineId();
  const targets: Array<{ target: string; machine: string; name: string; os?: string }> = [];
  const unresolved: string[] = [];

  if (hosts && hosts.length > 0) {
    // Resolve each token through the device registry so an explicit --host/--device
    // dials the exact same address (and machine id) as the auto-discovery sweep.
    const resolved = await resolveExplicitTargetSet(hosts);
    targets.push(...resolved.targets);
    unresolved.push(...resolved.unresolved);
  } else {
    let reg: Record<string, DeviceProfile>;
    try {
      reg = await loadDevices();
    } catch {
      return { sessions: [], deviceCount: 0, unreachable: ['device registry'] };
    }
    for (const d of Object.values(reg)) {
      // Live SSH-probe verdict first, cached tailscale snapshot only as a
      // fallback — see isDialableDevice. A manually-registered device has no
      // tailscale peer entry, so gating on `online` alone hid its sessions.
      if (!isAutomaticSessionPeer(d, self)) continue;
      // Control-only devices (a phone/tablet running the cockpit) drive the fleet
      // but never run agents — never dial them, whatever their platform reads as.
      // Only machines that can actually run the CLI. iOS/tablet nodes register as
      // `unknown` platform and can never answer, so skip them rather than burn a
      // full ConnectTimeout on each.
      try {
        targets.push({ target: sshTargetFor(d), machine: normalizeHost(d.name), name: d.name, os: d.platform });
      } catch {
        // No address on the profile — nothing to dial; skip silently.
      }
    }
  }

  const results = await Promise.all(targets.map((t) => fetchByTarget(t.target, t.machine, t.name, forwardedArgs, t.os)));
  return {
    sessions: results.flatMap((r) => r.sessions),
    deviceCount: targets.length,
    unreachable: [...unresolved, ...results.map((r) => r.unreachable).filter((n): n is string => !!n)],
  };
}

export interface RemoteToolSearchResult {
  envelopes: Array<{ machine: string; envelope: ToolSearchEnvelope }>;
  deviceCount: number;
  unreachable: string[];
  truncated: string[];
}

function boundedRemoteString(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) return undefined;
  return sanitizeToolEvidenceText(value, maxBytes);
}

function optionalRemoteString(value: unknown, maxBytes: number): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return boundedRemoteString(value, maxBytes) ?? null;
}

function parseRemoteCall(value: unknown): ToolCallEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const call = value as Record<string, unknown>;
  const id = boundedRemoteString(call.id, 512);
  const timestamp = boundedRemoteString(call.timestamp, 128);
  const tool = boundedRemoteString(call.tool, 512);
  const input = boundedRemoteString(call.input, TOOL_INPUT_MAX_BYTES);
  const sourceCallId = optionalRemoteString(call.sourceCallId, 512);
  const output = optionalRemoteString(call.output, TOOL_SUCCESS_OUTPUT_MAX_BYTES);
  const error = optionalRemoteString(call.error, TOOL_ERROR_OUTPUT_MAX_BYTES);
  const errorCode = optionalRemoteString(call.errorCode, 512);
  const parseError = optionalRemoteString(call.parseError, 1024);
  if (call.programs !== undefined
    && (!Array.isArray(call.programs) || call.programs.length > 128)) return undefined;
  const programs = Array.isArray(call.programs)
    ? call.programs.map((program) => boundedRemoteString(program, 512))
    : [];
  if (!id || !timestamp || !tool || input === undefined
    || !Number.isSafeInteger(call.ordinal) || (call.ordinal as number) < 0
    || !['ok', 'error', 'unknown'].includes(String(call.outcome))
    || sourceCallId === null || output === null || error === null || errorCode === null || parseError === null
    || programs.some((program) => program === undefined)) return undefined;
  for (const code of [call.exitCode, call.statusCode]) {
    if (code !== undefined && (!Number.isSafeInteger(code) || (code as number) < 0)) return undefined;
  }
  return {
    id,
    ordinal: call.ordinal as number,
    sourceCallId,
    timestamp,
    tool,
    programs: programs as string[],
    input,
    outcome: call.outcome as ToolCallEvidence['outcome'],
    exitCode: call.exitCode as number | undefined,
    statusCode: call.statusCode as number | undefined,
    errorCode,
    output,
    error,
    parseError,
  };
}

function parseRemoteToolSession(value: unknown, machine: string): ToolSessionEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const session = value as Record<string, unknown>;
  const id = boundedRemoteString(session.id, 512);
  const shortId = boundedRemoteString(session.shortId, 128);
  const agent = boundedRemoteString(session.agent, 128);
  const timestamp = boundedRemoteString(session.timestamp, 128);
  const project = optionalRemoteString(session.project, 4096);
  const cwd = optionalRemoteString(session.cwd, 4096);
  const topic = optionalRemoteString(session.topic, 4096);
  const label = optionalRemoteString(session.label, 4096);
  const safeMachine = boundedRemoteString(machine, 512);
  if (!id || !shortId || !agent || !timestamp || !safeMachine || project === null || cwd === null || topic === null || label === null
    || !Array.isArray(session.calls) || session.calls.length > TOOL_QUERY_MAX_CALL_ROWS) return undefined;
  const calls = session.calls.map(parseRemoteCall);
  if (calls.some((call) => call === undefined)) return undefined;
  return { id, shortId, agent, machine: safeMachine, timestamp, project, cwd, topic, label, calls: calls as ToolCallEvidence[] };
}

export function parseRemoteToolSearch(
  stdout: string,
  machine: string,
  expectedClauses?: string[],
): ToolSearchEnvelope | undefined {
  if (Buffer.byteLength(stdout) > REMOTE_STDOUT_MAX_BYTES) return undefined;
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const coverage = parsed?.coverage as Record<string, unknown> | undefined;
    const query = parsed?.query as Record<string, unknown> | undefined;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.sessions)
      || parsed.sessions.length > TOOL_QUERY_MAX_RESULT_SESSIONS || !coverage || !query
      || !Array.isArray(query.clauses) || query.clauses.length > TOOL_QUERY_MAX_CLAUSES
      || query.clauses.some((clause) => boundedRemoteString(clause, TOOL_QUERY_MAX_CLAUSE_BYTES) === undefined)) return undefined;
    let totalCalls = 0;
    for (const sessionValue of parsed.sessions) {
      if (!sessionValue || typeof sessionValue !== 'object' || Array.isArray(sessionValue)) return undefined;
      const calls = (sessionValue as Record<string, unknown>).calls;
      if (!Array.isArray(calls) || calls.length > TOOL_QUERY_MAX_CALL_ROWS) return undefined;
      totalCalls += calls.length;
      if (totalCalls > TOOL_QUERY_MAX_CALL_ROWS) return undefined;
    }
    const clauses = query.clauses.map((clause) => sanitizeForTerminal(clause as string));
    const expected = expectedClauses?.map((clause) => sanitizeForTerminal(clause));
    if (expected && (clauses.length !== expected.length
      || clauses.some((clause, index) => clause !== expected[index]))) return undefined;
    const coverageNumbers = ['indexedFiles', 'indexedCalls', 'skippedFiles', 'limitedFiles', 'remainingFiles'] as const;
    if (coverageNumbers.some((key) => !Number.isSafeInteger(coverage[key]) || (coverage[key] as number) < 0)
      || typeof coverage.complete !== 'boolean') return undefined;
    const sessions = parsed.sessions.map((session) => parseRemoteToolSession(session, machine));
    const generatedAt = boundedRemoteString(parsed.generatedAt, 128);
    if (!generatedAt || sessions.some((session) => session === undefined)) return undefined;
    return {
      schemaVersion: 1,
      generatedAt,
      query: { clauses },
      coverage: {
        indexedFiles: coverage.indexedFiles as number,
        indexedCalls: coverage.indexedCalls as number,
        skippedFiles: coverage.skippedFiles as number,
        limitedFiles: coverage.limitedFiles as number,
        remainingFiles: coverage.remainingFiles as number,
        complete: coverage.complete,
      },
      sessions: sessions as ToolSessionEvidence[],
    };
  } catch {
    return undefined;
  }
}

/**
 * Fleet sibling of {@link gatherRemoteList} for the versioned tool-search
 * envelope. Each peer executes the same local-only query against its own
 * SQLite index; only compact matches cross SSH.
 */
export async function gatherRemoteToolSearch(
  forwardedArgs: string[],
  hosts?: string[],
  maxAggregateBytes = REMOTE_TOOL_AGGREGATE_MAX_BYTES,
  expectedClauses: string[] = [],
): Promise<RemoteToolSearchResult> {
  const self = machineId();
  const targets: Array<{ target: string; machine: string; name: string; os?: string }> = [];
  const unresolved: string[] = [];
  if (hosts && hosts.length > 0) {
    const resolved = await resolveExplicitTargetSet(hosts);
    targets.push(...resolved.targets);
    unresolved.push(...resolved.unresolved);
  } else {
    let reg: Record<string, DeviceProfile>;
    try {
      reg = await loadDevices();
    } catch {
      return { envelopes: [], deviceCount: 0, unreachable: ['device registry'], truncated: [] };
    }
    for (const d of Object.values(reg)) {
      if (!isAutomaticSessionPeer(d, self)) continue;
      try {
        targets.push({ target: sshTargetFor(d), machine: normalizeHost(d.name), name: d.name, os: d.platform });
      } catch {
        // A registered control record without a dialable address is not a query target.
      }
    }
  }

  const remainingBytes = Math.max(0, Math.min(REMOTE_TOOL_AGGREGATE_MAX_BYTES, maxAggregateBytes));
  const aggregateBudget: RemoteToolByteBudget = {
    remainingBytes,
    exhausted: remainingBytes === 0,
  };
  const parsedBudget: RemoteToolByteBudget = {
    remainingBytes,
    exhausted: remainingBytes === 0,
  };
  const results = await mapBounded(targets, async (target) => {
      if (aggregateBudget.exhausted) return { target, truncated: target.name };
      const capture = await sshCapture(
        target.target,
        remoteListCommand(forwardedArgs, target.os),
        REMOTE_TOOL_TIMEOUT_MS,
        aggregateBudget,
        // A tool-index deadline must own the SSH connection. Killing a
        // multiplexed child would leave its remote command running on the
        // persistent control master.
        { multiplex: false },
      );
      if (capture.aggregateBudgetExceeded) return { target, truncated: target.name };
      if (capture.code !== 0) return { target, unreachable: target.name };
      const envelope = parseRemoteToolSearch(capture.stdout, target.machine, expectedClauses);
      if (!envelope) return { target, unreachable: target.name };
      if (!consumeParsedRemoteToolSearchBudget(parsedBudget, envelope)) {
        return { target, truncated: target.name };
      }
      return { target, envelope };
    }, { concurrency: 6 });
  for (const result of results) {
    if (result.unreachable) {
      process.stderr.write(chalk.gray(`  ${result.unreachable}: unreachable, incompatible, or no agents CLI — skipped\n`));
    }
    if (result.truncated) {
      process.stderr.write(chalk.gray(`  ${result.truncated}: fleet tool-result budget exhausted — skipped\n`));
    }
  }
  return {
    envelopes: results.flatMap((result) => result.envelope
      ? [{ machine: result.target.machine, envelope: result.envelope }]
      : []),
    deviceCount: targets.length,
    unreachable: [...unresolved, ...results.map((result) => result.unreachable).filter((name): name is string => !!name)],
    truncated: results.map((result) => result.truncated).filter((name): name is string => !!name),
  };
}

/** Resolve a peer's SSH target (and OS) from the device registry by its
 * normalized machine id — the same id the fan-out tags rows with. Returns
 * undefined when no registered device with an address matches. */
export async function resolvePeerTarget(machine: string): Promise<{ target: string; os?: string } | undefined> {
  let reg: Record<string, DeviceProfile>;
  try {
    reg = await loadDevices();
  } catch {
    return undefined;
  }
  for (const d of Object.values(reg)) {
    if (normalizeHost(d.name) !== machine) continue;
    try {
      return { target: sshTargetFor(d), os: d.platform };
    } catch {
      return undefined; // matched the machine, but it has no address to dial
    }
  }
  return undefined;
}

/**
 * Run `agents <args>` ON a peer over SSH, attached to this terminal (inherited
 * stdio). `args` is the full arg vector after the binary — callers pass e.g.
 * `['sessions', id, '--markdown']` or `['sessions', 'resume', id]`. Used when a
 * picked session lives on another machine: its transcript and agent binary are
 * there, so both reading (no TTY) and resuming (TTY) must execute on the peer —
 * not via a local `--host` hop, which would discover locally and dead-end for a
 * session that exists only on the peer. Resolves 'no-target' when the machine
 * isn't a dialable registered device; the caller surfaces a clear message.
 */
export async function runOnPeer(args: string[], machine: string, opts: { tty?: boolean } = {}): Promise<'ok' | 'no-target'> {
  const peer = await resolvePeerTarget(machine);
  if (!peer) return 'no-target';
  assertValidSshTarget(peer.target); // registry-sourced, but validate like the fan-out does

  const cols = terminalWidth();
  const remoteCmd = remoteShellFor(peer.os) === 'powershell'
    ? buildWindowsAgentsCommand({ args, env: cols > 0 ? { COLUMNS: String(cols) } : undefined })
    : `bash -lc ${shellQuote((cols > 0 ? [`COLUMNS=${cols}`] : []).concat(['agents', ...args].map(shellQuote)).join(' '))}`;

  const sshArgs = [...SSH_OPTS, ...controlOpts()];
  if (opts.tty) sshArgs.push('-tt'); // force a PTY so the resumed agent is interactive
  sshArgs.push(peer.target, remoteCmd);

  return new Promise((resolve) => {
    const child = spawn('ssh', sshArgs, { stdio: 'inherit' });
    // ssh prints its own connection errors to the inherited stderr; a spawn
    // failure (e.g. ssh not on PATH) has no such output, so name it. Either way
    // we resolve once it settles so the picker flow completes.
    child.on('error', (err: any) => {
      process.stderr.write(chalk.red(`Failed to reach ${machine}: ${err?.message ?? 'ssh failed to launch'}\n`));
      resolve('ok');
    });
    child.on('close', () => resolve('ok'));
  });
}
