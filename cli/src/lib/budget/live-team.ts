/**
 * Live budget kill-switch for `agents teams` supervisor (issue #399).
 *
 * Follow-up to #346, which wired `makeLiveSpendWatcher` into local `agents run`
 * only. Teams spawns each teammate as its own `agents run --headless --json`
 * process, so per-teammate `per_run` caps already fire from those child
 * watchers. What was still missing was aggregate cross-teammate enforcement
 * (`per_project` / `per_day` / `per_agent` combined), because the ledger only
 * gets written on child close — a long-running teammate would blow the shared
 * cap without any single child watcher noticing.
 *
 * This module reuses `makeLiveSpendWatcher` verbatim: on each supervisor wave
 * we tail every running teammate's stdout.log through `extractUsageEvents`
 * (the same primitive the local run path uses in src/lib/exec.ts), feed the
 * usage events into ONE shared watcher, and expose `breached()` so the
 * supervisor can call `stopByTask` to terminate the whole team.
 *
 * Dormant (returns null) when no caps are configured — same zero-cost contract
 * as the local watcher.
 */
import * as fs from 'fs';
import type { AgentManager } from '../teams/agents.js';
import {
  capsFromConfig,
  extractUsageEvents,
  makeLiveSpendWatcher,
  type BreachInfo,
  type LiveSpendWatcher,
} from './enforce.js';
import { resolveBudgetConfig, hasAnyCap } from './config.js';
import { loadLedger, localDay, spendForDay, spendForProject } from './ledger.js';

/** Public surface of the team-scoped budget watcher. */
export interface TeamBudgetWatcher {
  /** Feed any new usage events from every running teammate's stdout.log. */
  poll(): Promise<void>;
  /** True once any cap has been crossed (mirrors LiveSpendWatcher). */
  breached(): boolean;
  /** The first breach seen, or null if none yet. */
  breach(): BreachInfo | null;
  /** Release references and stop tapping streams. Idempotent. */
  dispose(): void;
}

/** Per-teammate cursor tracking how far we've read the stdout.log. */
interface StreamCursor {
  offset: number;
  pending: string;
}

/**
 * Build a team-scoped budget watcher for the given team. Returns null when the
 * effective budget config has no caps — matching the local watcher's dormant
 * contract so callers pay nothing when the feature is off.
 *
 * The watcher is seeded with prior-day and prior-project spend from the ledger
 * so a partway-through day counts today's earlier runs against `per_day`.
 * Each `poll()` reads new bytes from every running teammate's stdout.log and
 * feeds parsed usage events into the shared watcher — `onBreach` fires exactly
 * once, mirroring `makeLiveSpendWatcher`.
 */
export function createTeamBudgetWatcher(args: {
  manager: AgentManager;
  team: string;
  /** Project/cwd used to (a) resolve budget config and (b) seed project spend. */
  cwd: string;
  onBreach: (breach: BreachInfo) => void;
}): TeamBudgetWatcher | null {
  const cfg = resolveBudgetConfig(args.cwd);
  if (!hasAnyCap(cfg)) return null;

  const today = localDay();
  const entries = loadLedger();
  const caps = capsFromConfig(cfg, {
    daySpend: spendForDay(today, entries),
    projectSpend: spendForProject(args.cwd, entries),
  });

  let firstBreach: BreachInfo | null = null;
  const watcher: LiveSpendWatcher = makeLiveSpendWatcher({
    caps,
    onBreach: (b) => {
      firstBreach = b;
      args.onBreach(b);
    },
  });

  const cursors = new Map<string, StreamCursor>();
  let disposed = false;

  return {
    async poll(): Promise<void> {
      if (disposed || watcher.breached()) return;
      const teammates = await args.manager.listByTask(args.team);
      for (const agent of teammates) {
        // Only tap running local teammates: PENDING has no output yet, cloud
        // teammates emit through a different channel (their own SSE stream),
        // and terminal states produce no new bytes.
        if (agent.status !== 'running') continue;
        if (agent.cloudProvider) continue;

        const stdoutPath = await agent.getStdoutPath();
        let stat: fs.Stats;
        try {
          stat = fs.statSync(stdoutPath);
        } catch {
          continue; // File not yet created — nothing to read.
        }

        const cursor = cursors.get(agent.agentId) ?? { offset: 0, pending: '' };
        if (stat.size <= cursor.offset) {
          cursors.set(agent.agentId, cursor);
          continue;
        }

        const fd = fs.openSync(stdoutPath, 'r');
        try {
          const toRead = stat.size - cursor.offset;
          const buffer = Buffer.alloc(toRead);
          const bytesRead = fs.readSync(fd, buffer, 0, toRead, cursor.offset);
          const chunk = buffer.toString('utf-8', 0, bytesRead);
          cursor.offset += bytesRead;

          const { events, rest } = extractUsageEvents(
            chunk,
            cursor.pending,
            undefined,
            agent.agentType,
          );
          cursor.pending = rest;
          for (const ev of events) {
            watcher.feedUsage(ev);
            if (watcher.breached()) break;
          }
        } finally {
          fs.closeSync(fd);
        }
        cursors.set(agent.agentId, cursor);
        if (watcher.breached()) return;
      }
    },
    breached: () => watcher.breached(),
    breach: () => firstBreach,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      watcher.dispose();
      cursors.clear();
    },
  };
}
