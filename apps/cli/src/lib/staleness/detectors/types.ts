/**
 * Per-(kind, agent) detector contract.
 *
 * A detector inspects a version home and reports which resource names of a
 * given kind are materialized there. The aggregator at
 * `getActuallySyncedResources` calls one detector per kind/agent pair to build
 * the "what is actually on disk" view, which is then diffed against
 * "what is available" to drive the resource prompt in `agents view`.
 */
import type { AgentId } from '../../types.js';
import type { ResourceKind } from '../writers/kinds.js';

export interface DetectArgs {
  version: string;
  versionHome: string;
  /** Working directory — needed by detectors that resolve project state. */
  cwd: string;
}

export interface ResourceDetector {
  readonly kind: ResourceKind;
  readonly agent: AgentId;
  list(args: DetectArgs): string[];
}
