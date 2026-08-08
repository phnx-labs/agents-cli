import { resolveAccountLabel } from '../account-labels.js';
import { AGENTS } from '../agents.js';
import { getGlobalDefault } from '../versions.js';
import type { AgentId } from '../types.js';
import { listInstallations } from './store.js';
import type { Installation } from './types.js';

/**
 * Addressing a frozen installation.
 *
 * A selector matches either the installation's stable {@link Installation.label}
 * or the vendor release it currently carries — the label because that is what
 * every persisted reference and every `agents add` invocation uses, the release
 * because after an update the two differ and a user reading `agents view` may
 * name either. Matching both is also precisely what makes duplicate same-release
 * installations addressable at all: two installs can share a release, so the
 * release alone is not an identifier and the ambiguity has to be reported rather
 * than silently resolved to whichever sorted first.
 */

export class InstallationNotFoundError extends Error {
  constructor(
    public readonly agent: AgentId,
    public readonly selector: string | undefined,
    public readonly available: readonly Installation[]
  ) {
    // Nothing installed is a different problem from "your selector missed", and
    // the remedy differs — say which one it is rather than printing an empty list.
    super(
      available.length === 0
        ? `No ${AGENTS[agent].name} installations are managed by agents-cli. Install one with: agents add ${agent}@latest`
        : `No ${AGENTS[agent].name} installation matches '${selector}'. Installed: ${available.map((i) => describeInstallation(i)).join(', ')}`
    );
    this.name = 'InstallationNotFoundError';
  }
}

export class InstallationAmbiguousError extends Error {
  constructor(
    public readonly agent: AgentId,
    public readonly selector: string | undefined,
    public readonly candidates: readonly Installation[]
  ) {
    super(
      `'${selector ?? agent}' matches ${candidates.length} ${AGENTS[agent].name} installations `
      + `(${candidates.map((i) => describeInstallation(i)).join(', ')}). `
      + `Name one by its installation label, or disambiguate with --account <label>.`
    );
    this.name = 'InstallationAmbiguousError';
  }
}

/** `2.0.65` when frozen at its original release, `2.0.65 (release 2.0.71)` after an update. */
export function describeInstallation(installation: Installation): string {
  return installation.releaseVersion === installation.label
    ? installation.label
    : `${installation.label} (release ${installation.releaseVersion})`;
}

export interface ResolveInstallationOptions {
  /**
   * An `agents accounts` label. Narrows to the installation currently signed
   * into that account before the selector is applied.
   */
  account?: string;
}

/**
 * Resolve `<agent>[@<selector>]` to exactly one installation.
 *
 * With no selector: the agent's default installation when one is pinned, else
 * the sole installation. Never a "newest wins" guess — picking for the user
 * across several installs is how an update lands on the wrong one.
 */
export async function resolveInstallation(
  agent: AgentId,
  selector: string | undefined,
  options: ResolveInstallationOptions = {}
): Promise<Installation> {
  const all = listInstallations(agent);
  if (all.length === 0) throw new InstallationNotFoundError(agent, selector, all);

  let candidates = all;
  if (options.account) {
    // resolveAccountLabel answers with the version-dir label of the install that
    // is signed into that account — i.e. an installation label.
    const label = await resolveAccountLabel(agent, options.account);
    candidates = candidates.filter((i) => i.label === label);
    if (candidates.length === 0) throw new InstallationNotFoundError(agent, selector, all);
  }

  if (selector) {
    const byLabel = candidates.filter((i) => i.label === selector);
    // A label is unique by construction (it is a directory name), so a label hit
    // is decisive and never competes with a release hit on another installation.
    if (byLabel.length === 1) return byLabel[0];
    const byRelease = candidates.filter((i) => i.releaseVersion === selector);
    if (byRelease.length === 1) return byRelease[0];
    if (byRelease.length > 1) throw new InstallationAmbiguousError(agent, selector, byRelease);
    throw new InstallationNotFoundError(agent, selector, all);
  }

  if (candidates.length === 1) return candidates[0];

  const defaultLabel = getGlobalDefault(agent);
  const pinned = defaultLabel ? candidates.find((i) => i.label === defaultLabel) : undefined;
  if (pinned) return pinned;

  throw new InstallationAmbiguousError(agent, selector, candidates);
}
