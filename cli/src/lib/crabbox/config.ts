/**
 * The repo-local crabbox config (`.crabbox.yaml` at the repo root).
 *
 * crabbox itself reads this file when warming a box (the `profile:` key becomes
 * the box's `profile` label). `agents run --lease` deliberately does NOT inherit
 * that repo/CI label: leases share the default pool unless `leaseProfile:` opts
 * the repo into a dedicated hot box.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

/**
 * The profile label a box warm pool shares. Matches sandbox.sh's
 * `PROFILE="${PROFILE:-default}"`: a run with no configured profile and a box
 * with no `profile` label both normalize here, so they still match each other.
 */
export const DEFAULT_CRABBOX_PROFILE = 'default';

function readCrabboxRepoConfig(repoRoot: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(repoRoot, '.crabbox.yaml'), 'utf-8');
  } catch {
    return undefined; // no repo crabbox config — crabbox's own default applies
  }
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch {
    return undefined;
  }
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
}

/**
 * Pool label for `agents run --lease`. The generic `profile:` key remains owned
 * by repo sandbox/CI scripts; only the explicit `leaseProfile:` key opts lease
 * runs out of the shared default pool.
 */
export function readCrabboxLeaseProfile(repoRoot: string): string {
  const profile = readCrabboxRepoConfig(repoRoot)?.leaseProfile;
  return typeof profile === 'string' && profile.length > 0 ? profile : DEFAULT_CRABBOX_PROFILE;
}
