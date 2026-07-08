/**
 * Per-(kind, agent) writer contract.
 *
 * The aggregator in `syncResourcesToVersion` (versions.ts) selects names per
 * kind, then dispatches into a writer from `../registry.ts`. The writer owns
 * everything kind-specific: the agent's storage format, the layered source
 * search, the conversion/copy step. Writers MUST be reached only after a
 * `supports(agent, kind, version).ok === true` precheck — they throw when
 * called on a (kind, agent) pair that the capability matrix says is false.
 *
 * The shape is intentionally narrow. Writers don't accept ambient state; the
 * caller passes the names already resolved against availability. Selection is
 * a string[] for most kinds, a PermissionsSelection object for permissions,
 * and a RulesSelection object for rules — see kind-specific writer modules.
 */
import type { AgentId } from '../../types.js';
import type { ResourceKind } from './kinds.js';

export interface WriteArgs<Sel> {
  /** Agent version (e.g. "1.2.3") — passed for version-gated capability checks and side files. */
  version: string;
  /** Absolute path to the version's home dir, i.e. `~/.agents/.history/versions/<agent>/<version>/home`. */
  versionHome: string;
  /** Kind-specific selection payload. */
  selection: Sel;
  /** Current working directory — used by writers that consult project-layer state. */
  cwd: string;
}

export interface WriteResult {
  /** Names actually written. Empty array = write produced nothing (not an error). */
  synced: string[];
}

export interface ResourceWriter<Sel = string[]> {
  readonly kind: ResourceKind;
  readonly agent: AgentId;
  write(args: WriteArgs<Sel>): WriteResult;
}
