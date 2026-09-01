/**
 * Shared source-evaluator contract.
 *
 * Every source module exports `evaluate(source)` (the poll model — one snapshot,
 * or null when nothing is observable this tick / the source is push-only) and,
 * where push-based (ws, file-follow), a `subscribe(source, onObs)` returning an
 * unsubscribe fn.
 */

import type { MonitorSource } from '../config.js';

/** One observation of a source: the raw text plus optional structured metadata. */
export interface Observation {
  raw: string;
  meta?: Record<string, unknown>;
  /**
   * The source flagged this snapshot as an OBSERVATION FAILURE (a poll that
   * exited non-zero or emitted a transport/auth/rate-limit error), not a value.
   * The engine skips it: no fire, watched-state untouched, counted as a failed
   * check for drought health (PHNX-3510).
   */
  failed?: boolean;
  /** Short human reason for `failed`, surfaced in drought health and `test`. */
  failureReason?: string;
}

/** Poll-model evaluator: return one observation, or null when none is available. */
export type SourceEvaluator = (source: MonitorSource) => Promise<Observation | null>;

/** Push-model subscriber: call onObs on each frame; return an unsubscribe fn. */
export type SourceSubscriber = (
  source: MonitorSource,
  onObs: (obs: Observation) => void,
) => () => void;
