/**
 * Diff two {@link SessionTrajectory} models for `agents sessions trace <a> <b>` —
 * the second selector turns the single-session trajectory into a **compare**.
 *
 * Aligns the two sessions' TOOL steps (thinking steps carry no comparable
 * identity) with a classic LCS edit script keyed on tool name, in order —
 * cheap, deterministic, and matches how a human reads "where did these two
 * runs diverge": the first point their tool sequence stops lining up.
 *
 * Pure and framework-free, exactly like `trajectory.ts`: takes two already-built
 * `SessionTrajectory` models (never re-parses a transcript) and returns a plain
 * diff object the HTML/text/JSON renderers project.
 */
import type { SessionMeta } from './types.js';
import type { SessionTrajectory, TrajectoryStep } from './trajectory.js';

/** Where two sessions' tool sequences first stop lining up. */
export interface TrajectoryDivergence {
  /** Ordinal of the last step both sessions still agree on (0 if none). */
  afterOrdinalA: number;
  afterOrdinalB: number;
  /** ms into each session's own timeline where the divergence begins. */
  startMsA: number;
  startMsB: number;
  /** One-line description of what differs — the next tool step on each side. */
  detail: string;
}

/** Aggregate numbers for one side of a compare — the summary table row. */
export interface TrajectorySummary {
  session: SessionMeta;
  toolCount: number;
  errorCount: number;
  spanMs: number;
  outputTokens: number;
}

/** The result of diffing two trajectories. */
export interface TrajectoryComparison {
  a: SessionTrajectory;
  b: SessionTrajectory;
  /** Undefined only when the tool sequences are identical (or one/both are empty and equal). */
  divergence?: TrajectoryDivergence;
  /** Tool steps present in `b` with no counterpart in `a`, in `b`'s order. */
  added: TrajectoryStep[];
  /** Tool steps present in `a` with no counterpart in `b`, in `a`'s order. */
  removed: TrajectoryStep[];
  summaryA: TrajectorySummary;
  summaryB: TrajectorySummary;
  /** Tool steps dropped from the diff computation by the `maxDiffSteps` cap, per side. */
  truncatedA: number;
  truncatedB: number;
}

export interface DiffTrajectoriesOptions {
  /** Cap on tool steps considered per side (the LCS table is O(n*m)). Default 1000. */
  maxDiffSteps?: number;
}

const DEFAULT_MAX_DIFF_STEPS = 1000;

type EditOp =
  | { type: 'same'; stepA: TrajectoryStep; stepB: TrajectoryStep }
  | { type: 'remove'; stepA: TrajectoryStep }
  | { type: 'add'; stepB: TrajectoryStep };

/**
 * A textbook LCS edit script over two step sequences, equality keyed on tool
 * name. `dp[i][j]` = length of the LCS of `a[i:]` and `b[j:]`; backtracking
 * from `(0, 0)` prefers `same` whenever the tools match, and otherwise walks
 * toward whichever neighbour holds the longer common subsequence — the
 * standard minimal-edit-script tie-break.
 */
function computeEditScript(a: TrajectoryStep[], b: TrajectoryStep[]): EditOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].tool === b[j].tool ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: EditOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].tool === b[j].tool) {
      ops.push({ type: 'same', stepA: a[i], stepB: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'remove', stepA: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', stepB: b[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ type: 'remove', stepA: a[i] }); i++; }
  while (j < m) { ops.push({ type: 'add', stepB: b[j] }); j++; }
  return ops;
}

function describeDivergence(op: EditOp): string {
  if (op.type === 'remove') return `${op.stepA.tool ?? op.stepA.kind} — only in the first session`;
  if (op.type === 'add') return `${op.stepB.tool ?? op.stepB.kind} — only in the second session`;
  return '';
}

function summarize(t: SessionTrajectory): TrajectorySummary {
  return {
    session: t.session,
    toolCount: t.stats.toolCount,
    errorCount: t.errorCount,
    spanMs: t.spanMs,
    outputTokens: t.stats.outputTokens,
  };
}

/**
 * Diff two trajectories: align their tool-step sequences, find the first
 * divergence, and collect the steps each session ran that the other never
 * did. Never mutates either input.
 */
export function diffTrajectories(
  a: SessionTrajectory,
  b: SessionTrajectory,
  options: DiffTrajectoriesOptions = {},
): TrajectoryComparison {
  const maxDiffSteps = options.maxDiffSteps ?? DEFAULT_MAX_DIFF_STEPS;

  const allToolStepsA = a.steps.filter((s) => s.kind === 'tool');
  const allToolStepsB = b.steps.filter((s) => s.kind === 'tool');
  const toolStepsA = allToolStepsA.slice(0, maxDiffSteps);
  const toolStepsB = allToolStepsB.slice(0, maxDiffSteps);
  const truncatedA = allToolStepsA.length - toolStepsA.length;
  const truncatedB = allToolStepsB.length - toolStepsB.length;

  const ops = computeEditScript(toolStepsA, toolStepsB);

  const added: TrajectoryStep[] = [];
  const removed: TrajectoryStep[] = [];
  let divergence: TrajectoryDivergence | undefined;
  let lastSameA: TrajectoryStep | undefined;
  let lastSameB: TrajectoryStep | undefined;

  for (const op of ops) {
    if (op.type === 'same') {
      lastSameA = op.stepA;
      lastSameB = op.stepB;
      continue;
    }
    if (op.type === 'remove') removed.push(op.stepA);
    else added.push(op.stepB);
    if (!divergence) {
      divergence = {
        afterOrdinalA: lastSameA?.ordinal ?? 0,
        afterOrdinalB: lastSameB?.ordinal ?? 0,
        startMsA: op.type === 'remove' ? op.stepA.startMs : (lastSameA?.startMs ?? 0),
        startMsB: op.type === 'add' ? op.stepB.startMs : (lastSameB?.startMs ?? 0),
        detail: describeDivergence(op),
      };
    }
  }

  return {
    a,
    b,
    divergence,
    added,
    removed,
    summaryA: summarize(a),
    summaryB: summarize(b),
    truncatedA,
    truncatedB,
  };
}
