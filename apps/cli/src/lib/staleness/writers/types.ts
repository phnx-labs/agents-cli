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
  /**
   * Per-item failures the writer could not complete, as user-facing sentences.
   *
   * `synced: []` alone cannot distinguish "nothing to do" from "refused to
   * write and said why", which is how an unwritable harness reported success
   * for its whole life (RUSH-2677). A writer that declines MUST say so here.
   */
  errors?: string[];
}

/**
 * Inverse of a write: locate and delete the materialized artifact for one
 * resource `name` from a version home. Used only by the manifest-bounded prune
 * pass (RUSH-2438), which supplies names it has already proven were
 * agents-installed and are gone from source — the writer just owns the layout
 * knowledge (native file vs command-skill dir vs recipe) so prune never
 * re-derives it.
 */
export interface RemoveArgs {
  /** Agent version (e.g. "1.2.3"). */
  version: string;
  /** Absolute path to the version's home dir. */
  versionHome: string;
  /** Resource name to remove (no extension). */
  name: string;
  /** Current working directory — used by writers that consult project-layer state. */
  cwd: string;
}

export interface RemoveResult {
  /** True when an artifact owned by this writer was found and deleted. */
  removed: boolean;
}

export interface ResourceWriter<Sel = string[]> {
  readonly kind: ResourceKind;
  readonly agent: AgentId;
  write(args: WriteArgs<Sel>): WriteResult;
  /**
   * Optional inverse of `write` for the prune pass. Only the name-keyed
   * file/dir kinds implement it (commands, skills, hooks); kinds whose sync is
   * a wholesale rewrite (rules, permissions) or that carry their own
   * reconciliation (plugins via cleanOrphanedPluginSkills) leave it undefined.
   * Absence is not a silent skip: `pruneRemovedResources` only iterates
   * `PRUNABLE_KINDS`, and a registry completeness test asserts every writer for
   * those kinds implements `remove`.
   */
  remove?(args: RemoveArgs): RemoveResult;
}
