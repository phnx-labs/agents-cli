// OS-process probe primitives — the canonical, vscode-free implementations of
// the `ps`/`pgrep` one-shots the readiness pipeline depends on.
//
// These were previously inlined in `src/vscode/terminalReadiness.ts`. Migration
// #68 centralizes readiness probing in the monitor's `ReadinessDetector`, which
// runs in a plain process (no vscode). To avoid two copies drifting apart, the
// primitives live here and BOTH the leader-side detector and the window-local
// fallback in terminalReadiness import them. Pure child_process — no vscode,
// no module state beyond the shared concurrency gate.

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const KNOWN_SHELLS = new Set([
  'zsh', '-zsh', 'bash', '-bash', 'fish', '-fish', 'sh', '-sh',
]);

// Probe polling uses exponential backoff instead of a fixed tight interval.
// Each probe starts at its base cadence (the fast case is unchanged) and
// doubles the delay on every non-firing tick up to PROBE_BACKOFF_CAP_MS, so an
// idle machine with many terminals stops spinning `ps`/`pgrep` every 50-150ms.
export const SHELL_PROBE_BASE_MS = 50;     // shellReady: first poll cadence
export const IDLE_PROBE_BASE_MS = 150;     // prompt/agent: first poll cadence
export const PROBE_BACKOFF_CAP_MS = 1000;  // never poll slower than this
export const PS_TIMEOUT_MS = 2000;

// Debounce windows are wall-clock so backoff (variable poll cadence) never
// changes when the event fires — only how often we sample.
export const PROMPT_IDLE_WINDOW_MS = 150;  // continuous "no children" before promptReady
export const PROMPT_READY_TIMEOUT_MS = 30_000;
export const AGENT_READY_TIMEOUT_MS = 60_000;

// Prefer the shell-integration event for promptReady; only poll if it hasn't
// fired within this grace window.
export const PROMPT_FALLBACK_GRACE_MS = 300;

// The agent process (Node-based TUIs like Claude/Codex/Gemini) sits in 'S'
// state during ANY I/O wait — including auto-update network calls that fire
// before the TUI renders. We defend with a minimum wall-clock floor since the
// child appeared, and a longer continuous idle window than promptReady uses.
export const AGENT_IDLE_WINDOW_MS = 1500;       // continuous S-state before agentReady
export const AGENT_MIN_CHILD_RUNTIME_MS = 2500; // child has existed at least 2.5s

// Hard cap on concurrent ps/pgrep probe subprocesses across every probe, so a
// burst of terminal opens can't fork dozens of probes at once.
export const MAX_CONCURRENT_PROBES = 8;

export function backoffMs(base: number, attempt: number): number {
  return Math.min(base * 2 ** attempt, PROBE_BACKOFF_CAP_MS);
}

let activeProbeCount = 0;
const probeWaiters: Array<() => void> = [];

/** Run `fn` under the shared concurrency gate so probes never fork unbounded. */
export async function withProbeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeProbeCount >= MAX_CONCURRENT_PROBES) {
    await new Promise<void>((res) => probeWaiters.push(res));
  }
  activeProbeCount++;
  try {
    return await fn();
  } finally {
    activeProbeCount--;
    probeWaiters.shift()?.();
  }
}

/** True when `pid`'s command is a known interactive shell. Throws if pid is gone. */
export async function probeIsKnownShell(pid: number): Promise<boolean> {
  const { stdout } = await withProbeSlot(() => execAsync(`ps -p ${pid} -o comm=`));
  const comm = stdout.trim().split('/').pop() || '';
  return KNOWN_SHELLS.has(comm);
}

/** Direct child pids of `pid` (`pgrep -P`). Empty array when there are none. */
export async function probeChildPids(pid: number): Promise<number[]> {
  try {
    const { stdout } = await withProbeSlot(() => execAsync(`pgrep -P ${pid}`));
    return stdout.trim().split(/\s+/).filter(Boolean).map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    // pgrep exits 1 with no matches — promisified exec rejects. Zero children.
    return [];
  }
}

/** `ps -p <pid> -o stat=` — the kernel scheduler state (e.g. 'S', 'R'). */
export async function probeStat(pid: number): Promise<string> {
  const { stdout } = await withProbeSlot(() => execAsync(`ps -p ${pid} -o stat=`));
  return stdout.trim();
}

/** `ps -p <pid> -o args=` — the full argv of a process. */
export async function probeArgs(pid: number): Promise<string> {
  const { stdout } = await withProbeSlot(() => execAsync(`ps -p ${pid} -o args=`));
  return stdout.trim();
}

/** `ps -p <pid> -o lstart=` parsed to epoch ms, or undefined if unavailable. */
export async function probeStartMs(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await withProbeSlot(() => execAsync(`ps -p ${pid} -o lstart=`));
    const parsed = Date.parse(stdout.trim());
    return Number.isNaN(parsed) ? undefined : parsed;
  } catch {
    return undefined;
  }
}
