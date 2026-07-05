/**
 * Runtime wiring for declarative dynamic fan-out (issue #343).
 *
 * The declarative shape (`for_each:` in WORKFLOW.md / routine `run:` blocks) is
 * parsed and expanded by `src/lib/workflows.ts` (`parseForEachBlock`,
 * `expandForEach`). This module is the thin bridge that stages the expanded
 * teammate descriptors into the EXISTING teams substrate — one
 * `AgentManager.spawn` per descriptor, which the DAG supervisor then picks up
 * mid-flight via `rescanFromDisk` / `startReady`
 * (`src/lib/teams/supervisor.ts:98-103`).
 *
 * It deliberately adds NO new orchestration engine: `spawn` with an `--after`
 * chain is the whole mechanism, so cycle detection, wave scheduling, and
 * cross-vendor/rotation dispatch all carry over unchanged.
 */
import type { AgentManager, AgentProcess, EffortLevel } from './agents.js';
import type { AgentType } from './parsers.js';
import { expandForEach, type ForEachSpec, type ForEachTeammate } from '../workflows.js';

export interface RunForEachOptions {
  /** Working directory for the spawned teammates. */
  cwd?: string | null;
  /**
   * Name of the producer teammate the stage teammates should depend on. When
   * set, each stage runs `--after` the producer so it can't start before the
   * list is available.
   */
  producerName?: string;
  /** Default effort for spawned teammates (per-item overrides live in the spec). */
  effort?: EffortLevel;
  /** Concurrency cap for the wave; falls back to the spec's `concurrency`. */
  concurrency?: number;
}

export interface RunForEachResult {
  /** The expanded descriptors (stage + verify), in spawn order. */
  teammates: ForEachTeammate[];
  /** The AgentProcess handles returned by `spawn`, aligned to `teammates`. */
  spawned: AgentProcess[];
  /** Items the producer emitted (pre-cap). */
  producedCount: number;
  /** Items actually fanned out (post-cap). */
  usedCount: number;
  /** How many items the runaway guard dropped. */
  truncated: number;
}

/**
 * Expand a `for_each` spec against a producer's output and stage every
 * resulting teammate into the given team via the dynamic-add path.
 *
 * Returns the descriptors and the spawned handles so a caller can drive the
 * supervisor and later gather results (e.g. to evaluate a `verify` panel's
 * `keep_if` gate — that vote-counting lives downstream, not here).
 */
export async function runForEach(
  mgr: AgentManager,
  teamName: string,
  spec: ForEachSpec,
  items: string[],
  opts: RunForEachOptions = {},
): Promise<RunForEachResult> {
  const { teammates, producedCount, usedCount, truncated } = expandForEach(spec, items, {
    producerName: opts.producerName,
  });

  const effort: EffortLevel = opts.effort ?? 'medium';
  const spawned: AgentProcess[] = [];
  for (const t of teammates) {
    const agent = await mgr.spawn(
      teamName,
      t.agentType as AgentType,
      t.prompt,
      opts.cwd ?? null,
      null, // mode: inherit team default
      effort,
      null, // parentSessionId
      null, // workspaceDir
      null, // version
      t.name,
      t.after,
    );
    spawned.push(agent);
  }

  return { teammates, spawned, producedCount, usedCount, truncated };
}
