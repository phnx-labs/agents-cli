/**
 * Shared version resolution for the exec-time config-dir env pin. Every
 * config-dir harness branch in the old buildExecEnv computed this identically:
 * an explicit `--version` is used unconditionally; an auto-resolved version is
 * only pinned when it is actually installed on disk.
 */
import { getVersionHomePath, isVersionInstalled, resolveVersion } from '../installations/versions.js';
import type { ExecConfigEnvCtx } from './adapter.js';

export interface ResolvedConfigVersion {
  /** The version to pin, or null when unresolved / not installed. */
  version: string | null;
  /** The version home for that version, or null. */
  versionHome: string | null;
}

export function resolveConfigVersion(ctx: ExecConfigEnvCtx): ResolvedConfigVersion {
  const resolvedVersion = ctx.optionsVersion ?? resolveVersion(ctx.agent, ctx.cwd);
  const version = ctx.optionsVersion
    ? resolvedVersion
    : (resolvedVersion && isVersionInstalled(ctx.agent, resolvedVersion) ? resolvedVersion : null);
  const versionHome = version ? getVersionHomePath(ctx.agent, version) : null;
  return { version: version ?? null, versionHome };
}
