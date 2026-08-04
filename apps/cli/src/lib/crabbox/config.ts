/**
 * The repo-local crabbox config (`.crabbox.yaml` at the repo root).
 *
 * crabbox itself reads this file when warming a box (the `profile:` key becomes
 * the box's `profile` label). `agents run --lease` reads it too so the warm-pool
 * reuse check matches on the SAME profile the warmup would have used — a reused
 * box is then interchangeable with a fresh one (scripts/sandbox.sh's
 * `pick_ready_box` resolves the pool the same way).
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

/**
 * The `profile:` declared by `<repoRoot>/.crabbox.yaml`, or undefined when the
 * file is missing, unreadable, or has no profile key (crabbox then applies its
 * own default, which the pool matcher treats as DEFAULT_CRABBOX_PROFILE).
 */
export function readCrabboxRepoProfile(repoRoot: string): string | undefined {
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
  if (!parsed || typeof parsed !== 'object') return undefined;
  const profile = (parsed as Record<string, unknown>).profile;
  return typeof profile === 'string' && profile.length > 0 ? profile : undefined;
}
