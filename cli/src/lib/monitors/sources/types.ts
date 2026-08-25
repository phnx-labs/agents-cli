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
}

/** Poll-model evaluator: return one observation, or null when none is available. */
export type SourceEvaluator = (source: MonitorSource) => Promise<Observation | null>;

/** Push-model subscriber: call onObs on each frame; return an unsubscribe fn. */
export type SourceSubscriber = (
  source: MonitorSource,
  onObs: (obs: Observation) => void,
) => () => void;
