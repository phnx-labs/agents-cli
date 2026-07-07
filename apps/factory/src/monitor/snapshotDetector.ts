// Leader-side panel/floor snapshot detector (#71).
//
// The elected monitor runs ONE of these. Each window ARMS it with the
// (workspaceRoot, cwd, agentType) tuples its visible panel/floor needs; the
// detector runs the SAME global per-tick work every window's 4s panel poll ran
// today — `git branch --show-current` + `git diff --numstat HEAD` per workspace,
// `git worktree list --porcelain`, `agents view <type> --json` usage per agent,
// and `agents teams list` per cwd — but ONCE machine-wide instead of once per
// (window, panel). It broadcasts a single merged `panel-snapshot` fact the host
// pushes to followers, which render from it instead of forking the subprocesses.
//
// An IN-FLIGHT GUARD (`tickInFlight`) drops a tick that starts while the prior
// one is still computing, so a slow `agents view` (self-documented 4-6s) can
// never stack overlapping ticks — the bug the per-window poll had no guard for.
//
// vscode-free: git/worktree/usage default fetchers are pure child_process; the
// teams fetcher is injected (it is vscode-coupled) so this module + host.ts stay
// vscode-free and testable against real git repos and subprocesses.

import { execFile } from 'child_process';
import * as path from 'path';
import { AgentsViewJsonAgent } from '../core/resumeInBest';
import { parseWorktreeListPorcelain, WorktreeRef } from '../core/panel.helpers';
import { GitNumstat, PanelSnapshotPayload, SnapshotWatch } from './protocol';

/** How often the detector recomputes the merged snapshot. Matches the old 4s poll. */
export const SNAPSHOT_TICK_MS = 4000;

interface RunOptions {
  cwd?: string;
  maxBuffer?: number;
}

/** Run a command, resolving stdout, or null on any error (never throws). */
function run(file: string, args: string[], opts: RunOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: opts.cwd, maxBuffer: opts.maxBuffer }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

/**
 * `git branch --show-current` + `git diff --numstat HEAD` for one workspace.
 * Mirrors terminals.getWorkspaceGitInfo's parsing exactly (numstat keyed by both
 * the relative and the resolved absolute path) so floor parity holds.
 */
export async function fetchGitInfo(workspaceRoot: string): Promise<GitNumstat> {
  const [branchOut, numstatOut] = await Promise.all([
    run('git', ['branch', '--show-current'], { cwd: workspaceRoot }),
    run('git', ['diff', '--numstat', 'HEAD'], { cwd: workspaceRoot, maxBuffer: 4 * 1024 * 1024 }),
  ]);

  const branch = branchOut !== null ? branchOut.trim() || null : null;
  const numstat: Record<string, { added: number; removed: number }> = {};
  if (numstatOut !== null) {
    for (const line of numstatOut.split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const added = parseInt(parts[0], 10);
      const removed = parseInt(parts[1], 10);
      const relPath = parts[2];
      if (!Number.isFinite(added) || !Number.isFinite(removed) || !relPath) continue;
      const absPath = path.resolve(workspaceRoot, relPath);
      const stat = { added, removed };
      numstat[absPath] = stat;
      numstat[relPath] = stat;
    }
  }
  return { branch, numstat };
}

/**
 * `git worktree list --porcelain` for one workspace, parsed into WorktreeRefs.
 * Mirrors agentPanel.listWorktrees. Returns [] when not a repo / git missing.
 */
export async function fetchWorktrees(
  workspaceRoot: string,
  activeCwd?: string,
): Promise<WorktreeRef[]> {
  const out = await run('git', ['-C', workspaceRoot, 'worktree', 'list', '--porcelain'], {
    maxBuffer: 1024 * 1024,
  });
  if (out === null) return [];
  return parseWorktreeListPorcelain(
    out,
    activeCwd ? path.resolve(activeCwd) : undefined,
    path.resolve(workspaceRoot),
    path.basename,
    path.resolve,
  );
}

/**
 * `agents view <agentType> --json`, parsed. Mirrors agentPanel.readUsageStatus's
 * fetch but returns the full view so the consumer applies the same version-match
 * selection locally. Returns null when the binary/JSON is unavailable.
 */
export async function fetchUsage(agentType: string): Promise<AgentsViewJsonAgent | null> {
  const out = await run('agents', ['view', agentType, '--json'], { maxBuffer: 4 * 1024 * 1024 });
  if (out === null) return null;
  try {
    const parsed = JSON.parse(out) as AgentsViewJsonAgent;
    if (!parsed || !Array.isArray(parsed.versions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface SnapshotDetectorOptions {
  emit: (fact: PanelSnapshotPayload) => void;
  /** Recompute cadence (tests). */
  tickMs?: number;
  /** Inject the git fetcher (tests); defaults to the real `git` CLI. */
  fetchGit?: (workspaceRoot: string) => Promise<GitNumstat>;
  /** Inject the worktree fetcher (tests); defaults to the real `git` CLI. */
  fetchWorktrees?: (workspaceRoot: string, activeCwd?: string) => Promise<WorktreeRef[]>;
  /** Inject the usage fetcher (tests); defaults to the real `agents` CLI. */
  fetchUsage?: (agentType: string) => Promise<AgentsViewJsonAgent | null>;
  /** Inject the teams fetcher (vscode-coupled — supplied by the wiring layer). */
  fetchTeams?: (cwd: string) => Promise<unknown[]>;
  /** Inject the clock (tests). */
  now?: () => number;
}

export class SnapshotDetector {
  private readonly emit: (fact: PanelSnapshotPayload) => void;
  private readonly tickMs: number;
  private readonly fetchGit: (workspaceRoot: string) => Promise<GitNumstat>;
  private readonly fetchWorktrees: (workspaceRoot: string, activeCwd?: string) => Promise<WorktreeRef[]>;
  private readonly fetchUsage: (agentType: string) => Promise<AgentsViewJsonAgent | null>;
  private readonly fetchTeams?: (cwd: string) => Promise<unknown[]>;
  private readonly now: () => number;

  // windowId -> that window's last-reported watch slice. Merged across windows so
  // the same (workspaceRoot, cwd, agentType) tuple is computed only once per tick.
  private readonly slices = new Map<string, SnapshotWatch[]>();
  private timer?: NodeJS.Timeout;
  private tickInFlight = false;
  private stopped = false;

  constructor(options: SnapshotDetectorOptions) {
    this.emit = options.emit;
    this.tickMs = options.tickMs ?? SNAPSHOT_TICK_MS;
    this.fetchGit = options.fetchGit ?? fetchGitInfo;
    this.fetchWorktrees = options.fetchWorktrees ?? fetchWorktrees;
    this.fetchUsage = options.fetchUsage ?? fetchUsage;
    this.fetchTeams = options.fetchTeams;
    this.now = options.now ?? Date.now;
  }

  /** Number of distinct (workspaceRoot, cwd, agentType) tuples watched (tests). */
  get watchedKeyCount(): number {
    return this.mergedWatches().length;
  }

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Replace one window's watch slice; the union drives the central tick. */
  setWatches(windowId: string, watches: SnapshotWatch[]): void {
    if (this.stopped) return;
    if (watches.length === 0) this.slices.delete(windowId);
    else this.slices.set(windowId, watches);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.slices.clear();
  }

  /** Run one snapshot pass immediately (tests); normally the timer drives it. */
  async tick(): Promise<void> {
    // IN-FLIGHT GUARD: a tick that starts while the prior one is still computing
    // is dropped, so a slow `agents view` can never stack overlapping passes.
    if (this.stopped || this.tickInFlight) return;
    const watches = this.mergedWatches();
    if (watches.length === 0) return;

    this.tickInFlight = true;
    try {
      const roots = new Set<string>();
      const cwds = new Set<string>();
      const agents = new Set<string>();
      // First cwd seen per root drives the worktree `isActive` flag.
      const cwdForRoot = new Map<string, string | undefined>();
      for (const w of watches) {
        roots.add(w.workspaceRoot);
        const cwd = w.cwd ?? w.workspaceRoot;
        cwds.add(cwd);
        if (w.agentType) agents.add(w.agentType);
        if (!cwdForRoot.has(w.workspaceRoot)) cwdForRoot.set(w.workspaceRoot, w.cwd);
      }

      const gitByRoot: Record<string, GitNumstat> = {};
      const worktreesByRoot: Record<string, WorktreeRef[]> = {};
      const teamsByCwd: Record<string, unknown[]> = {};
      const usageByAgent: Record<string, AgentsViewJsonAgent> = {};

      await Promise.all([
        ...[...roots].map(async (r) => {
          gitByRoot[r] = await this.fetchGit(r).catch(() => ({ branch: null, numstat: {} }));
        }),
        ...[...roots].map(async (r) => {
          worktreesByRoot[r] = await this.fetchWorktrees(r, cwdForRoot.get(r)).catch(() => []);
        }),
        ...[...cwds].map(async (c) => {
          if (!this.fetchTeams) return;
          teamsByCwd[c] = await this.fetchTeams(c).catch(() => []);
        }),
        ...[...agents].map(async (a) => {
          const view = await this.fetchUsage(a).catch(() => null);
          if (view) usageByAgent[a] = view;
        }),
      ]);

      if (this.stopped) return;
      this.emit({ gitByRoot, worktreesByRoot, teamsByCwd, usageByAgent, ts: this.now() });
    } finally {
      this.tickInFlight = false;
    }
  }

  // Collapse every window's slice to one watch per (workspaceRoot, cwd, agentType).
  private mergedWatches(): SnapshotWatch[] {
    const merged = new Map<string, SnapshotWatch>();
    for (const slice of this.slices.values()) {
      for (const w of slice) {
        const key = `${w.workspaceRoot} ${w.cwd ?? ''} ${w.agentType ?? ''}`;
        if (!merged.has(key)) merged.set(key, w);
      }
    }
    return [...merged.values()];
  }
}
