// VS Code glue for the terminalReadiness state machine.
//
// One global registry keyed by vscode.Terminal instance. Each entry owns its
// own probes/watchers/listeners and is torn down when the terminal closes.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Diagnostic file logger for shell adoption — VS Code's console.log doesn't
// land in any persisted log file, so we mirror adoption events to disk for
// post-hoc debugging. Path: ~/.cache/swarmify/shell-adoption.log
const ADOPTION_LOG_PATH = path.join(os.homedir(), '.cache', 'swarmify', 'shell-adoption.log');
let adoptionLogReady = false;
function adoptLog(msg: string): void {
  try {
    if (!adoptionLogReady) {
      fs.mkdirSync(path.dirname(ADOPTION_LOG_PATH), { recursive: true });
      adoptionLogReady = true;
    }
    fs.appendFileSync(ADOPTION_LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore */ }
}
import {
  ReadinessEntry,
  ReadinessEvent,
  createEntry,
  markEvent,
  resetFrom,
  waitFor as coreWaitFor,
  dispose as coreDispose,
  hasFired,
  AgentLauncherKey,
  detectAgentKeyFromArgs,
  extractSessionIdFromArgs,
} from '../core/terminalReadiness';
import {
  SHELL_PROBE_BASE_MS,
  IDLE_PROBE_BASE_MS,
  PS_TIMEOUT_MS,
  PROMPT_IDLE_WINDOW_MS,
  PROMPT_READY_TIMEOUT_MS,
  AGENT_READY_TIMEOUT_MS,
  PROMPT_FALLBACK_GRACE_MS,
  AGENT_IDLE_WINDOW_MS,
  AGENT_MIN_CHILD_RUNTIME_MS,
  backoffMs,
  probeIsKnownShell,
  probeChildPids,
  probeStat,
} from '../monitor/probes';
import { agentSessionRoots, __clearRootCacheForTests } from '../monitor/sessionParse';
import {
  SHELL_ADOPTION_POLL_MS,
  SHELL_ADOPTION_MAX_LIFETIME_MS,
  SHELL_ADOPTION_TREE_DEPTH,
  findAgentInTree,
  locateSessionIdForAgent,
} from '../monitor/readinessDetector';

interface Registered {
  entry: ReadinessEntry;
  terminal: vscode.Terminal;
  pid: number | null;
  disposables: vscode.Disposable[];
  timers: NodeJS.Timeout[];
  watchers: fs.FSWatcher[];
  fastPathDisposers: Array<() => void>;
  agentArmed: boolean;
}

const registry = new Map<vscode.Terminal, Registered>();

// Singleton watcher per session-root path. Without this, every terminal would
// mount its own recursive fs.watch on ~/.claude/projects (and per-version
// homes), and on macOS each subscription re-arms FSEvents over a multi-GB
// tree. With 20+ terminals open, the duplication caused observable system
// load. Refcounted: the watcher closes when the last callback unregisters.
interface SharedReadinessWatcher {
  watcher: fs.FSWatcher;
  callbacks: Set<(filename: string) => void>;
}
const sharedWatchers = new Map<string, SharedReadinessWatcher>();

function addSharedWatcher(
  root: string,
  callback: (filename: string) => void,
): () => void {
  let entry = sharedWatchers.get(root);
  if (!entry) {
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const name = filename.toString();
        const e = sharedWatchers.get(root);
        if (!e) return;
        for (const cb of e.callbacks) {
          try { cb(name); } catch { /* ignore */ }
        }
      });
    } catch {
      return () => { /* noop */ };
    }
    entry = { watcher, callbacks: new Set() };
    sharedWatchers.set(root, entry);
  }
  entry.callbacks.add(callback);
  return () => {
    const e = sharedWatchers.get(root);
    if (!e) return;
    e.callbacks.delete(callback);
    if (e.callbacks.size === 0) {
      try { e.watcher.close(); } catch { /* ignore */ }
      sharedWatchers.delete(root);
    }
  };
}

// --- Monitor follower routing (#68) ---------------------------------------
//
// When this window is connected to the centralized monitor, the leader runs the
// ps/pgrep probes once per pid and broadcasts readiness facts; this window then
// resolves each fact to its own terminal and feeds the SAME state machine via
// markEvent. Local probing is therefore SUPPRESSED while connected, and the arm
// intents are forwarded to the monitor. When disconnected (election race, leader
// loss) everything falls back to local probing — nothing breaks.

export interface MonitorArmSink {
  armAgent(pid: number, agentKey: string | undefined, sessionId: string | undefined): void;
  armShellAdoption(pid: number): void;
}

let monitorConnected: () => boolean = () => false;
let monitorArmSink: MonitorArmSink | undefined;

/** Wire the predicate the gating consults to decide local-vs-broadcast. */
export function setMonitorConnectivity(fn: () => boolean): void {
  monitorConnected = fn;
}

/** Wire the sink that forwards arm intents to the monitor. */
export function setMonitorArmSink(sink: MonitorArmSink | undefined): void {
  monitorArmSink = sink;
}

function useMonitor(pid: number | null): pid is number {
  return pid !== null && monitorConnected() && monitorArmSink !== undefined;
}

/** Apply a broadcast readiness fact to every local terminal on that pid. */
export function ingestReadinessFact(pid: number, event: ReadinessEvent): void {
  for (const r of registry.values()) {
    if (r.pid === pid) markEvent(r.entry, event);
  }
}

/** Apply a broadcast shell-adoption fact: fire the armed callback for that pid. */
export function ingestShellAdoptionFact(pid: number, info: ShellAdoptionInfo): void {
  for (const [terminal, r] of registry.entries()) {
    if (r.pid !== pid) continue;
    const state = shellAdoptions.get(terminal);
    if (!state || !state.armed) continue;
    state.armed = false;
    shellAdoptions.delete(terminal);
    try {
      state.onAdopted(info);
    } catch (err) {
      console.error('[READINESS] shell adoption callback threw', err);
    }
  }
}

// On leadership loss / disconnect, restart local probing for any terminal still
// waiting on an event it would otherwise only learn via broadcast.
export function onMonitorDisconnected(): void {
  for (const [terminal, r] of registry.entries()) {
    if (r.pid === null) continue;
    if (!hasFired(r.entry, 'shellReady')) startShellReadyProbe(r);
    if (!hasFired(r.entry, 'promptReady')) startPromptReadyFallbackProbe(r);
    if (r.agentArmed && !hasFired(r.entry, 'agentReady')) startAgentReadyProbe(r);
    const state = shellAdoptions.get(terminal);
    if (state && state.armed) startLocalShellAdoption(terminal, r, state);
  }
}

let shellIntegrationDisposable: vscode.Disposable | null = null;
let closeDisposable: vscode.Disposable | null = null;

// Call once during extension activation.
export function initReadiness(context: vscode.ExtensionContext): void {
  if (shellIntegrationDisposable) return;

  shellIntegrationDisposable = vscode.window.onDidChangeTerminalShellIntegration(
    ({ terminal }) => {
      const r = registry.get(terminal);
      if (!r) return;
      markEvent(r.entry, 'promptReady');
    }
  );

  closeDisposable = vscode.window.onDidCloseTerminal((terminal) => {
    disposeTerminal(terminal);
  });

  context.subscriptions.push(shellIntegrationDisposable);
  context.subscriptions.push(closeDisposable);
}

export interface RegisterOptions {
  // When true, the terminal was restored after an IDE reload and its agent is
  // already running. Mark all events as fired immediately; do not probe.
  restored?: boolean;
}

// Register a terminal at creation time. Kicks off tabReady + shellReady probes.
// Idempotent: calling twice on the same terminal is a no-op.
export function registerTerminal(
  terminal: vscode.Terminal,
  opts: RegisterOptions = {}
): void {
  if (registry.has(terminal)) return;

  const r: Registered = {
    entry: createEntry(),
    terminal,
    pid: null,
    disposables: [],
    timers: [],
    watchers: [],
    fastPathDisposers: [],
    agentArmed: opts.restored === true,
  };
  registry.set(terminal, r);

  if (opts.restored) {
    // Resolve pid for completeness but skip all probes — the agent is up.
    Promise.resolve(terminal.processId).then((pid) => {
      if (pid) r.pid = pid;
    }, () => { /* ignore */ });
    markEvent(r.entry, 'agentReady');
    return;
  }

  // tabReady: resolves as soon as the pty is allocated.
  Promise.resolve(terminal.processId).then((pid) => {
    if (!pid) return;
    r.pid = pid;
    markEvent(r.entry, 'tabReady');
    // When connected to the monitor, the leader probes this pid once and
    // broadcasts shellReady/promptReady (resolved via ingestReadinessFact);
    // skip the local ps/pgrep probes. The follower already reports this pid.
    if (useMonitor(r.pid)) return;
    startShellReadyProbe(r);
    startPromptReadyFallbackProbe(r);
  }, () => {
    // Terminal was disposed before pid resolved.
  });
}

// Called by Resume/Reload flows after ^C^C: we want to re-await promptReady
// fresh because the agent CLI needs to release the pty and the shell prompt
// needs to reappear.
export function resetAfterAgentExit(terminal: vscode.Terminal): void {
  const r = registry.get(terminal);
  if (!r) return;
  r.agentArmed = false;
  resetFrom(r.entry, 'promptReady');
  startPromptReadyFallbackProbe(r);
}

// Arm agentReady detection. Call this right after sending the agent launch
// command.
//
// Two detection paths run in parallel; whichever fires first wins:
//   1) Process-state probe: stable 'S' state + minimum child runtime.
//   2) Session-file fast path: if agentKey + sessionId provided, fs.watch
//      for the agent's session file to appear. Claude/Codex/Gemini/OpenCode
//      all write a session file when the TUI is up.
export type FastPathAgentKey = AgentLauncherKey;
export { detectAgentKeyFromArgs, extractSessionIdFromArgs };

export interface ArmAgentOptions {
  // Any string is accepted for ergonomics; only known agent keys get the
  // session-file fast path. Unknown keys (e.g. 'shell') fall through to the
  // process-state probe.
  agentKey?: string;
  sessionId?: string;
  cwd?: string;
}

const FAST_PATH_KEYS = new Set<FastPathAgentKey>([
  'claude', 'codex', 'gemini', 'cursor', 'opencode',
]);

function isFastPathKey(k: string | undefined): k is FastPathAgentKey {
  return k !== undefined && FAST_PATH_KEYS.has(k as FastPathAgentKey);
}

export function armAgentReady(terminal: vscode.Terminal, opts: ArmAgentOptions = {}): void {
  const r = registry.get(terminal);
  if (!r) return;
  if (r.agentArmed) return;
  if (hasFired(r.entry, 'agentReady')) return;
  r.agentArmed = true;

  // Connected: forward the arm to the monitor (which runs the process-state
  // probe + session-file fast path once per pid) and resolve via broadcast.
  if (useMonitor(r.pid)) {
    monitorArmSink!.armAgent(r.pid, opts.agentKey, opts.sessionId);
    return;
  }

  if (isFastPathKey(opts.agentKey) && opts.sessionId) {
    armSessionFileFastPath(r, opts.agentKey, opts.sessionId, opts.cwd);
  }
  startAgentReadyProbe(r);
}

// Public wait. If timeoutMs is undefined, sensible defaults are picked per event.
export function waitFor(
  terminal: vscode.Terminal,
  event: ReadinessEvent,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const r = registry.get(terminal);
  if (!r) {
    return Promise.reject(new Error(`terminal not registered for readiness: ${terminal.name}`));
  }

  const timeoutMs = opts.timeoutMs ?? defaultTimeoutFor(event);
  return coreWaitFor(r.entry, event, { timeoutMs });
}

function defaultTimeoutFor(event: ReadinessEvent): number | undefined {
  switch (event) {
    case 'tabReady': return 10_000;
    case 'shellReady': return 10_000;
    case 'promptReady': return PROMPT_READY_TIMEOUT_MS;
    case 'agentReady': return AGENT_READY_TIMEOUT_MS;
  }
}

export function disposeTerminal(terminal: vscode.Terminal): void {
  const r = registry.get(terminal);
  if (!r) return;
  registry.delete(terminal);
  shellAdoptions.delete(terminal);
  for (const d of r.disposables) d.dispose();
  for (const t of r.timers) clearTimeout(t);
  for (const w of r.watchers) {
    try { w.close(); } catch { /* ignore */ }
  }
  for (const d of r.fastPathDisposers) {
    try { d(); } catch { /* ignore */ }
  }
  coreDispose(r.entry, 'terminal closed');
}

// --- Shell adoption ------------------------------------------------------
//
// Polls the descendant process tree of an SH terminal looking for known
// agent CLIs. Fires `onAdopted` once with the detected agent and its
// session id (when resolvable). Stops itself after firing.
//
// Detection handles:
//   - direct invocation: `claude`, `codex`, `gemini`, `cursor-agent`, `opencode`
//   - node-wrapped binaries (where comm shows `node`) via args inspection
//   - `agents run <agent>` wrappers from agents-cli
//
// Session id resolution:
//   1. Inspect the agent process args for `--session-id <uuid>`
//   2. Fall back to scanning the agent's session-file root for a file with
//      mtime >= the agent process start time

export interface ShellAdoptionInfo {
  agentKey: FastPathAgentKey;
  sessionId: string | undefined;
  childPid: number;
}

export type ShellAdoptionCallback = (info: ShellAdoptionInfo) => void;

interface ShellAdoptionState {
  startedAt: number;
  armed: boolean;
  onAdopted: ShellAdoptionCallback;
}

const shellAdoptions = new WeakMap<vscode.Terminal, ShellAdoptionState>();

export function armShellAdoption(
  terminal: vscode.Terminal,
  onAdopted: ShellAdoptionCallback
): void {
  const r = registry.get(terminal);
  if (!r) {
    adoptLog(`armShellAdoption: terminal "${terminal.name}" not in readiness registry — bailing`);
    return;
  }
  if (shellAdoptions.has(terminal)) {
    adoptLog(`armShellAdoption: terminal "${terminal.name}" already armed — skipping`);
    return;
  }
  const state: ShellAdoptionState = { startedAt: Date.now(), armed: true, onAdopted };
  shellAdoptions.set(terminal, state);
  adoptLog(`armShellAdoption: armed for terminal "${terminal.name}" (pid=${r.pid})`);

  // Connected: the monitor walks this pid's tree once and broadcasts the
  // ShellAdoptionInfo (resolved via ingestShellAdoptionFact). Forward the arm.
  if (useMonitor(r.pid)) {
    adoptLog(`armShellAdoption: forwarding to monitor for "${terminal.name}" (pid=${r.pid})`);
    monitorArmSink!.armShellAdoption(r.pid);
    return;
  }

  startLocalShellAdoption(terminal, r, state);
}

function startLocalShellAdoption(
  terminal: vscode.Terminal,
  r: Registered,
  state: ShellAdoptionState,
): void {
  const onAdopted = state.onAdopted;
  let tickCount = 0;
  const tick = async () => {
    tickCount++;
    if (!state.armed) return;
    if (r.entry.disposed) {
      adoptLog(`tick #${tickCount} for "${terminal.name}": entry disposed, stopping`);
      shellAdoptions.delete(terminal);
      return;
    }
    if (Date.now() - state.startedAt > SHELL_ADOPTION_MAX_LIFETIME_MS) {
      adoptLog(`tick #${tickCount} for "${terminal.name}": max lifetime exceeded, dropping`);
      shellAdoptions.delete(terminal);
      return;
    }
    if (r.pid === null) {
      adoptLog(`tick #${tickCount} for "${terminal.name}": pid not yet resolved, retrying`);
      const t = setTimeout(tick, SHELL_ADOPTION_POLL_MS);
      r.timers.push(t);
      return;
    }

    try {
      const match = await findAgentInTree(r.pid, SHELL_ADOPTION_TREE_DEPTH);
      if (match) {
        adoptLog(`tick #${tickCount} for "${terminal.name}" (shellPid=${r.pid}): MATCH agentKey=${match.agentKey} childPid=${match.childPid} sessionIdFromArgs=${match.sessionId}`);
        const sessionId = match.sessionId
          ?? await locateSessionIdForAgent(match.agentKey, match.childPid);
        adoptLog(`tick #${tickCount} for "${terminal.name}": resolved sessionId=${sessionId}`);
        state.armed = false;
        shellAdoptions.delete(terminal);
        try {
          onAdopted({ agentKey: match.agentKey, sessionId, childPid: match.childPid });
          adoptLog(`tick #${tickCount} for "${terminal.name}": onAdopted callback returned cleanly`);
        } catch (err) {
          adoptLog(`tick #${tickCount} for "${terminal.name}": onAdopted callback threw: ${err}`);
          console.error('[READINESS] shell adoption callback threw', err);
        }
        return;
      } else if (tickCount % 5 === 1) {
        // log every ~10s while idle so we can see polling is alive
        adoptLog(`tick #${tickCount} for "${terminal.name}" (shellPid=${r.pid}): no agent CLI in descendant tree`);
      }
    } catch (err) {
      adoptLog(`tick #${tickCount} for "${terminal.name}": probe threw ${err}`);
    }

    const t = setTimeout(tick, SHELL_ADOPTION_POLL_MS);
    r.timers.push(t);
  };

  const first = setTimeout(tick, SHELL_ADOPTION_POLL_MS);
  r.timers.push(first);
}

// --- Probes ---------------------------------------------------------------

function startShellReadyProbe(r: Registered): void {
  const pid = r.pid;
  if (pid === null) return;
  const startedAt = Date.now();
  let attempt = 0;

  const tick = async () => {
    if (r.entry.disposed) return;
    if (hasFired(r.entry, 'shellReady')) return;

    try {
      if (await probeIsKnownShell(pid)) {
        markEvent(r.entry, 'shellReady');
        return;
      }
    } catch {
      // Process may have died; nothing to do.
      return;
    }

    if (Date.now() - startedAt > PS_TIMEOUT_MS) {
      // Give up and assume shellReady — whatever's in the pty is what the user
      // picked. Don't block the pipeline forever.
      markEvent(r.entry, 'shellReady');
      return;
    }

    const t = setTimeout(tick, backoffMs(SHELL_PROBE_BASE_MS, attempt++));
    r.timers.push(t);
  };
  tick();
}

function startPromptReadyFallbackProbe(r: Registered): void {
  const pid = r.pid;
  if (pid === null) return;
  if (hasFired(r.entry, 'promptReady')) return;

  let idleSince: number | null = null;
  let attempt = 0;

  const tick = async () => {
    if (r.entry.disposed) return;
    // Shell-integration event (initReadiness) is the preferred signal; if it
    // already fired we never poll again.
    if (hasFired(r.entry, 'promptReady')) return;

    const idle = (await probeChildPids(pid)).length === 0;

    let accumulating = false;
    if (idle) {
      if (idleSince === null) idleSince = Date.now();
      if (Date.now() - idleSince >= PROMPT_IDLE_WINDOW_MS) {
        markEvent(r.entry, 'promptReady');
        return;
      }
      accumulating = true;
    } else {
      idleSince = null;
    }

    // Sample at base cadence while accumulating the idle window so we fire on
    // time; back off only while there's no idle signal to chase.
    const delay = accumulating ? IDLE_PROBE_BASE_MS : backoffMs(IDLE_PROBE_BASE_MS, attempt++);
    const t = setTimeout(tick, delay);
    r.timers.push(t);
  };

  // Give shell integration a chance first; only fall back to polling if it
  // hasn't fired by the grace deadline.
  const first = setTimeout(tick, PROMPT_FALLBACK_GRACE_MS);
  r.timers.push(first);
}

function startAgentReadyProbe(r: Registered): void {
  const pid = r.pid;
  if (pid === null) return;
  if (hasFired(r.entry, 'agentReady')) return;

  let idleSince: number | null = null;
  let childFirstSeenAt: number | null = null;
  let attempt = 0;

  const tick = async () => {
    if (r.entry.disposed) return;
    if (hasFired(r.entry, 'agentReady')) return;

    let accumulating = false;
    try {
      const childPid = (await probeChildPids(pid))[0];
      if (childPid === undefined) {
        // No child yet — agent CLI hasn't started. Reset both signals.
        idleSince = null;
        childFirstSeenAt = null;
      } else {
        if (childFirstSeenAt === null) {
          childFirstSeenAt = Date.now();
        }

        const idle = (await probeStat(childPid)).startsWith('S');
        if (idle) {
          if (idleSince === null) idleSince = Date.now();
          const runtimeMs = Date.now() - childFirstSeenAt;
          if (
            Date.now() - idleSince >= AGENT_IDLE_WINDOW_MS &&
            runtimeMs >= AGENT_MIN_CHILD_RUNTIME_MS
          ) {
            markEvent(r.entry, 'agentReady');
            return;
          }
          accumulating = true;
        } else {
          // Any R/D/Z state breaks continuity. This is the main defense against
          // mistaking network-I/O sleep for TUI-idle sleep.
          idleSince = null;
        }
      }
    } catch {
      idleSince = null;
    }

    // Sample at base cadence while the idle window accumulates; back off while
    // the agent is actively working so an idle machine isn't probed every 150ms.
    const delay = accumulating ? IDLE_PROBE_BASE_MS : backoffMs(IDLE_PROBE_BASE_MS, attempt++);
    const t = setTimeout(tick, delay);
    r.timers.push(t);
  };

  tick();
}

// Watch the agent's session file roots. As soon as a file named
// `{sessionId}.*` (jsonl/json) appears, the TUI has booted far enough to
// write its session metadata — a deterministic signal even when the
// process-state probe is still being fooled by network I/O.
// Hard timeout to tear down the fast-path callback even if agentReady never
// fires. Without this, an agent that fails to start leaks the watcher for the
// full terminal lifetime — death by a thousand cuts as terminals accumulate.
const FAST_PATH_SAFETY_TIMEOUT_MS = 30_000;

function armSessionFileFastPath(
  r: Registered,
  agentKey: FastPathAgentKey,
  sessionId: string,
  _cwd: string | undefined,
): void {
  const roots = sessionRootsForAgent(agentKey);
  const sessionIdLower = sessionId.toLowerCase();

  const checkFilename = (filename: string): boolean => {
    const base = filename.toLowerCase();
    // Claude/Codex/Gemini/OpenCode: filename contains sessionId (jsonl or json).
    // Cursor: {chatId}/store.db; sessionId is the chatId dir name.
    return base.includes(sessionIdLower);
  };

  const tearDown = (): void => {
    while (r.fastPathDisposers.length > 0) {
      const d = r.fastPathDisposers.pop();
      if (d) { try { d(); } catch { /* ignore */ } }
    }
  };

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dispose = addSharedWatcher(root, (filename) => {
      if (hasFired(r.entry, 'agentReady')) return;
      if (checkFilename(filename)) {
        markEvent(r.entry, 'agentReady');
        tearDown();
      }
    });
    r.fastPathDisposers.push(dispose);
  }

  const safetyTimer = setTimeout(tearDown, FAST_PATH_SAFETY_TIMEOUT_MS);
  r.timers.push(safetyTimer);
}

// The per-agent session roots are shared with the monitor's session watcher;
// `agentSessionRoots` (sessionParse.ts) is the single source of truth.
function sessionRootsForAgent(agentKey: FastPathAgentKey): string[] {
  return agentSessionRoots(agentKey);
}


// --- Test-only helpers ---------------------------------------------------

export function __clearRegistryForTests(): void {
  for (const [terminal, r] of registry.entries()) {
    shellAdoptions.delete(terminal);
    for (const d of r.disposables) d.dispose();
    for (const t of r.timers) clearTimeout(t);
    for (const w of r.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    for (const d of r.fastPathDisposers) {
      try { d(); } catch { /* ignore */ }
    }
  }
  registry.clear();
  for (const [, sw] of sharedWatchers) {
    try { sw.watcher.close(); } catch { /* ignore */ }
  }
  sharedWatchers.clear();
  __clearRootCacheForTests();
}
