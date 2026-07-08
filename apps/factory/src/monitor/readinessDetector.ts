// Leader-side, pid-keyed terminal-readiness detector (#68).
//
// The elected monitor runs ONE of these. It is fed the union of every window's
// shell pids (from the host's tuple snapshot) and runs the same ps/pgrep probes
// terminalReadiness runs today — but once per pid instead of once per
// (window, terminal). As each milestone is reached it emits a fact the host
// broadcasts; followers map the pid back to their own terminal and resolve the
// existing `waitFor` against it.
//
// vscode-free: it operates purely on pids, reuses the shared probe primitives
// (probes.ts) and session roots (sessionParse.ts), and is driven by the host —
// so it runs and tests in a plain process against real subprocesses.

import * as fs from 'fs';
import * as path from 'path';
import {
  AgentLauncherKey,
  detectAgentKeyFromArgs,
  extractSessionIdFromArgs,
} from '../core/terminalReadiness';
import { agentSessionRoots } from './sessionParse';
import {
  ReadinessEventName,
  ReadinessFactPayload,
  ShellAdoptionFactPayload,
} from './protocol';
import {
  SHELL_PROBE_BASE_MS,
  IDLE_PROBE_BASE_MS,
  PS_TIMEOUT_MS,
  PROMPT_IDLE_WINDOW_MS,
  PROMPT_FALLBACK_GRACE_MS,
  AGENT_IDLE_WINDOW_MS,
  AGENT_MIN_CHILD_RUNTIME_MS,
  backoffMs,
  probeIsKnownShell,
  probeChildPids,
  probeStat,
  probeArgs,
  probeStartMs,
} from './probes';

// --- Shell-adoption constants + tree walk (shared with the local fallback) -

export const SHELL_ADOPTION_POLL_MS = 2000;
export const SHELL_ADOPTION_MAX_LIFETIME_MS = 10 * 60 * 1000;
export const SHELL_ADOPTION_TREE_DEPTH = 5;
export const SHELL_ADOPTION_SESSION_LOOKBACK_MS = 60 * 1000;

export const SESSION_UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const READINESS_ORDER: readonly ReadinessEventName[] = [
  'tabReady',
  'shellReady',
  'promptReady',
  'agentReady',
];

export interface AgentInTreeMatch {
  agentKey: AgentLauncherKey;
  childPid: number;
  sessionId?: string;
}

/** Walk the descendant tree of `rootPid` for a known agent CLI. */
export async function findAgentInTree(
  rootPid: number,
  maxDepth: number,
): Promise<AgentInTreeMatch | null> {
  let frontier = [rootPid];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const childrenResults = await Promise.all(frontier.map((pid) => probeChildPids(pid)));
    const nextFrontier = childrenResults.flat().filter((n) => Number.isFinite(n));
    for (const childPid of nextFrontier) {
      try {
        const args = await probeArgs(childPid);
        const agentKey = detectAgentKeyFromArgs(args);
        if (agentKey) {
          return { agentKey, childPid, sessionId: extractSessionIdFromArgs(args) };
        }
      } catch {
        // child may have exited; skip
      }
    }
    frontier = nextFrontier;
  }
  return null;
}

async function collectRecentSessionFiles(
  root: string,
  sinceMs: number,
): Promise<Array<{ filename: string; mtimeMs: number }>> {
  const out: Array<{ filename: string; mtimeMs: number }> = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        const stat = await fs.promises.stat(full);
        if (e.isDirectory()) {
          if (stat.mtimeMs >= sinceMs - 1000) await walk(full, depth + 1);
        } else if (stat.mtimeMs >= sinceMs - 1000) {
          out.push({ filename: e.name, mtimeMs: stat.mtimeMs });
        }
      } catch {
        // ignore stat errors
      }
    }
  };

  await walk(root, 0);
  return out;
}

/** Resolve a session id for an adopted agent by scanning its recent session files. */
export async function locateSessionIdForAgent(
  agentKey: AgentLauncherKey,
  childPid: number,
): Promise<string | undefined> {
  let childStartMs = Date.now() - SHELL_ADOPTION_SESSION_LOOKBACK_MS;
  const start = await probeStartMs(childPid);
  if (start !== undefined) childStartMs = start - 1000;

  const roots = agentSessionRoots(agentKey);
  let best: { sessionId: string; mtimeMs: number } | null = null;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const found = await collectRecentSessionFiles(root, childStartMs);
    for (const f of found) {
      const m = f.filename.match(SESSION_UUID_RE);
      if (!m) continue;
      if (!best || f.mtimeMs > best.mtimeMs) {
        best = { sessionId: m[0], mtimeMs: f.mtimeMs };
      }
    }
  }
  return best?.sessionId;
}

// --- The detector ---------------------------------------------------------

export interface ReadinessDetectorOptions {
  emit: (fact: ReadinessFactPayload) => void;
  emitAdoption: (fact: ShellAdoptionFactPayload) => void;
}

interface PidEntry {
  pid: number;
  disposed: boolean;
  fired: Set<ReadinessEventName>;
  timers: Set<NodeJS.Timeout>;
  agentArmed: boolean;
  agentKey?: string;
  sessionIdLower?: string;
  fastPathMatched: boolean;
  adoptionArmed: boolean;
  adoptionStartedAt: number;
}

interface PendingArm {
  agentKey?: string;
  sessionId?: string;
}

export class ReadinessDetector {
  private readonly emit: (fact: ReadinessFactPayload) => void;
  private readonly emitAdoption: (fact: ShellAdoptionFactPayload) => void;
  private readonly entries = new Map<number, PidEntry>();
  // Arms that arrived before the pid was reported in a snapshot.
  private readonly pendingAgentArms = new Map<number, PendingArm>();
  private readonly pendingAdoptionArms = new Set<number>();
  private stopped = false;

  constructor(options: ReadinessDetectorOptions) {
    this.emit = options.emit;
    this.emitAdoption = options.emitAdoption;
  }

  /** The current set of pids under observation (test introspection). */
  get pidCount(): number {
    return this.entries.size;
  }

  /** Reconcile the observed pid set with the latest snapshot. */
  setPids(pids: Iterable<number>): void {
    if (this.stopped) return;
    const next = new Set<number>();
    for (const pid of pids) {
      if (typeof pid !== 'number' || !Number.isFinite(pid)) continue;
      next.add(pid);
      if (!this.entries.has(pid)) this.addPid(pid);
    }
    for (const pid of [...this.entries.keys()]) {
      if (!next.has(pid)) this.disposePid(pid);
    }
  }

  /** Arm agentReady detection for a shell pid (mirrors armAgentReady). */
  armAgent(pid: number, agentKey?: string, sessionId?: string): void {
    if (this.stopped) return;
    const entry = this.entries.get(pid);
    if (!entry) {
      this.pendingAgentArms.set(pid, { agentKey, sessionId });
      return;
    }
    this.applyAgentArm(entry, { agentKey, sessionId });
  }

  /** Arm shell-adoption detection for a shell pid (mirrors armShellAdoption). */
  armShellAdoption(pid: number): void {
    if (this.stopped) return;
    const entry = this.entries.get(pid);
    if (!entry) {
      this.pendingAdoptionArms.add(pid);
      return;
    }
    this.applyAdoptionArm(entry);
  }

  /**
   * Session-file fast path: a new session file appeared. Any armed pid whose
   * sessionId is in the filename reaches agentReady immediately (mirrors
   * armSessionFileFastPath).
   */
  noteSessionFile(filename: string): void {
    if (this.stopped) return;
    const base = filename.toLowerCase();
    for (const entry of this.entries.values()) {
      if (!entry.agentArmed || entry.fastPathMatched || !entry.sessionIdLower) continue;
      if (base.includes(entry.sessionIdLower)) {
        entry.fastPathMatched = true;
        this.fire(entry, 'agentReady');
      }
    }
  }

  stop(): void {
    this.stopped = true;
    for (const pid of [...this.entries.keys()]) this.disposePid(pid);
    this.pendingAgentArms.clear();
    this.pendingAdoptionArms.clear();
  }

  private addPid(pid: number): void {
    const entry: PidEntry = {
      pid,
      disposed: false,
      fired: new Set(),
      timers: new Set(),
      agentArmed: false,
      fastPathMatched: false,
      adoptionArmed: false,
      adoptionStartedAt: 0,
    };
    this.entries.set(pid, entry);
    // pid resolving == tabReady, exactly as terminalReadiness fires it.
    this.fire(entry, 'tabReady');
    this.startShellProbe(entry);
    this.startPromptProbe(entry);

    const pendingArm = this.pendingAgentArms.get(pid);
    if (pendingArm) {
      this.pendingAgentArms.delete(pid);
      this.applyAgentArm(entry, pendingArm);
    }
    if (this.pendingAdoptionArms.delete(pid)) {
      this.applyAdoptionArm(entry);
    }
  }

  private disposePid(pid: number): void {
    const entry = this.entries.get(pid);
    if (!entry) return;
    entry.disposed = true;
    for (const t of entry.timers) clearTimeout(t);
    entry.timers.clear();
    this.entries.delete(pid);
  }

  private fired(entry: PidEntry, event: ReadinessEventName): boolean {
    return entry.fired.has(event);
  }

  // Mark `event` and (internally) all lower milestones, emitting the reached
  // milestone. The follower's markEvent cascades, so emitting the top is enough.
  private fire(entry: PidEntry, event: ReadinessEventName): void {
    if (entry.disposed || entry.fired.has(event)) return;
    const idx = READINESS_ORDER.indexOf(event);
    for (let i = 0; i <= idx; i++) entry.fired.add(READINESS_ORDER[i]);
    this.emit({ pid: entry.pid, event });
  }

  private schedule(entry: PidEntry, fn: () => void, delay: number): void {
    if (entry.disposed) return;
    const t = setTimeout(() => {
      entry.timers.delete(t);
      if (!entry.disposed) fn();
    }, delay);
    entry.timers.add(t);
  }

  private startShellProbe(entry: PidEntry): void {
    const startedAt = Date.now();
    let attempt = 0;
    const tick = async () => {
      if (entry.disposed || this.fired(entry, 'shellReady')) return;
      try {
        if (await probeIsKnownShell(entry.pid)) {
          this.fire(entry, 'shellReady');
          return;
        }
      } catch {
        return; // process died
      }
      if (Date.now() - startedAt > PS_TIMEOUT_MS) {
        this.fire(entry, 'shellReady');
        return;
      }
      this.schedule(entry, tick, backoffMs(SHELL_PROBE_BASE_MS, attempt++));
    };
    void tick();
  }

  private startPromptProbe(entry: PidEntry): void {
    if (this.fired(entry, 'promptReady')) return;
    let idleSince: number | null = null;
    let attempt = 0;
    const tick = async () => {
      if (entry.disposed || this.fired(entry, 'promptReady')) return;
      const idle = (await probeChildPids(entry.pid)).length === 0;
      let accumulating = false;
      if (idle) {
        if (idleSince === null) idleSince = Date.now();
        if (Date.now() - idleSince >= PROMPT_IDLE_WINDOW_MS) {
          this.fire(entry, 'promptReady');
          return;
        }
        accumulating = true;
      } else {
        idleSince = null;
      }
      const delay = accumulating
        ? IDLE_PROBE_BASE_MS
        : backoffMs(IDLE_PROBE_BASE_MS, attempt++);
      this.schedule(entry, tick, delay);
    };
    this.schedule(entry, tick, PROMPT_FALLBACK_GRACE_MS);
  }

  private applyAgentArm(entry: PidEntry, arm: PendingArm): void {
    if (entry.agentArmed || this.fired(entry, 'agentReady')) return;
    entry.agentArmed = true;
    entry.agentKey = arm.agentKey;
    if (arm.agentKey && arm.sessionId) {
      entry.sessionIdLower = arm.sessionId.toLowerCase();
    }
    this.startAgentProbe(entry);
  }

  private startAgentProbe(entry: PidEntry): void {
    if (this.fired(entry, 'agentReady')) return;
    let idleSince: number | null = null;
    let childFirstSeenAt: number | null = null;
    let attempt = 0;
    const tick = async () => {
      if (entry.disposed || this.fired(entry, 'agentReady')) return;
      let accumulating = false;
      try {
        const childPid = (await probeChildPids(entry.pid))[0];
        if (childPid === undefined) {
          idleSince = null;
          childFirstSeenAt = null;
        } else {
          if (childFirstSeenAt === null) childFirstSeenAt = Date.now();
          const idle = (await probeStat(childPid)).startsWith('S');
          if (idle) {
            if (idleSince === null) idleSince = Date.now();
            const runtimeMs = Date.now() - childFirstSeenAt;
            if (
              Date.now() - idleSince >= AGENT_IDLE_WINDOW_MS &&
              runtimeMs >= AGENT_MIN_CHILD_RUNTIME_MS
            ) {
              this.fire(entry, 'agentReady');
              return;
            }
            accumulating = true;
          } else {
            idleSince = null;
          }
        }
      } catch {
        idleSince = null;
      }
      const delay = accumulating
        ? IDLE_PROBE_BASE_MS
        : backoffMs(IDLE_PROBE_BASE_MS, attempt++);
      this.schedule(entry, tick, delay);
    };
    void tick();
  }

  private applyAdoptionArm(entry: PidEntry): void {
    if (entry.adoptionArmed) return;
    entry.adoptionArmed = true;
    entry.adoptionStartedAt = Date.now();
    this.startAdoptionLoop(entry);
  }

  private startAdoptionLoop(entry: PidEntry): void {
    const tick = async () => {
      if (entry.disposed || !entry.adoptionArmed) return;
      if (Date.now() - entry.adoptionStartedAt > SHELL_ADOPTION_MAX_LIFETIME_MS) {
        entry.adoptionArmed = false;
        return;
      }
      try {
        const match = await findAgentInTree(entry.pid, SHELL_ADOPTION_TREE_DEPTH);
        if (match) {
          entry.adoptionArmed = false;
          const sessionId =
            match.sessionId ??
            (await locateSessionIdForAgent(match.agentKey, match.childPid));
          this.emitAdoption({
            pid: entry.pid,
            agentKey: match.agentKey,
            sessionId,
            childPid: match.childPid,
          });
          return;
        }
      } catch {
        // transient probe failure; keep polling
      }
      this.schedule(entry, tick, SHELL_ADOPTION_POLL_MS);
    };
    this.schedule(entry, tick, SHELL_ADOPTION_POLL_MS);
  }
}
