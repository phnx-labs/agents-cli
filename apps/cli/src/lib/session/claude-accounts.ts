/**
 * Which Claude account produced a transcript.
 *
 * A Claude `.jsonl` records `sessionId`, `cwd`, `version`, `gitBranch` and per-message
 * `usage`, but carries **no account identity** — no `accountUuid`, no
 * `organizationUuid`, no email. What agents-cli does have is the version layout: every
 * installed version gets its own home with its own `.claude.json` (`CLAUDE_CONFIG_DIR`
 * is swapped per version, see lib/exec.ts), so a home identifies an account.
 *
 * This matters because the default run strategy is `balanced` (lib/rotate.ts), which
 * sprays sessions across every signed-in account. Before this module the scanner
 * resolved ONE email process-globally and stamped it on every Claude session, so a
 * machine with several accounts reported all of its history under whichever one
 * happened to resolve first.
 *
 * Grouping is keyed on the **org** (`usageKey`), never the email: two orgs under one
 * email (a Team seat and a personal Max plan) are separate quota buckets and must stay
 * distinct — the same invariant `candidateIdentity` enforces in lib/rotate.ts.
 *
 * ## Evidence tiers
 *
 * Attribution is a pure function of (path, recorded version). It performs no per-file
 * I/O and does not need the transcript to still exist, which is what lets the v33
 * migration backfill already-indexed rows without re-parsing anything.
 *
 * 1. **The path names a version home.** Strongest: the file physically lives in that
 *    home, including a retired `trash/` snapshot, which keeps its `.claude.json`.
 * 2. **The path is under the `~/.claude` symlink, and the row records a version.**
 *    The symlink's target moves with `agents use`, so "whatever it points at now" is
 *    weak evidence for old rows — on the machine this was developed against, only 684
 *    of 1,334 such rows were written by the version the symlink currently names, and
 *    322 came from versions belonging to a *different* org. The recorded version is
 *    resolved to its own home instead.
 * 3. **Neither.** An explicitly dark bucket, labelled with why. Never folded into a
 *    real account and never dropped.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { readClaudeHomeConfig } from '../agents.js';
import { getAgentsDir, getHistoryDir } from '../state.js';

const HOME = os.homedir();
const VERSIONS_ROOTS = [getHistoryDir(), getAgentsDir()];

/** The account a transcript is attributed to. */
export interface ClaudeAccountBucket {
  /**
   * Stable grouping key. For an attributed bucket this is the org-scoped `usageKey`
   * (e.g. `claude:org=<uuid>`). For an unattributed one it is `unattributed:<reason>`
   * so distinct dark sources never merge into each other or into a real account.
   */
  key: string;
  /** True when the key came from a real `oauthAccount`. */
  attributed: boolean;
  email: string | null;
  orgName: string | null;
  /** "Team", "Max", "Pro", … derived from `organizationType`. */
  plan: string | null;
  /** Display string: org and email, or the reason a bucket is dark. */
  label: string;
  /** Which evidence tier produced this attribution. */
  evidence: 'version-home' | 'recorded-version' | 'symlink-target' | 'none';
}

interface HomeEntry {
  /** Literal path prefix a transcript must start with to belong to this home. */
  prefix: string;
  bucket: ClaudeAccountBucket;
}

/** Resolver over the Claude homes present on this machine. */
export interface ClaudeAccountIndex {
  /** Version- and trash-home prefixes, longest first. Excludes the `~/.claude` symlink. */
  entries: HomeEntry[];
  /**
   * Claude CLI version → the account that version ran as. `'ambiguous'` when retired
   * snapshots of one version disagree and no live home settles it, which is reported
   * as dark rather than guessed.
   */
  byVersion: Map<string, ClaudeAccountBucket | 'ambiguous'>;
  /** Whatever `~/.claude` points at right now; tier-3 evidence only. */
  symlinkBucket: ClaudeAccountBucket | null;
  /** Literal prefix of the live symlinked config dir. */
  symlinkPrefix: string;
}

/** `claude_team` → "Team", `claude_max` → "Max". Mirrors lib/agents.ts's label logic. */
function planFromOrgType(orgType: string | null): string | null {
  if (!orgType) return null;
  const m = /^claude_(.+)$/.exec(orgType);
  if (!m) return orgType;
  return m[1].charAt(0).toUpperCase() + m[1].slice(1);
}

function bucketForHome(
  home: string,
  evidence: ClaudeAccountBucket['evidence'],
): ClaudeAccountBucket | null {
  const cfg = readClaudeHomeConfig(home);
  if (!cfg) return null;
  const { email, organizationName: orgName, usageKey, accountKey, organizationType } = cfg.identity;
  // No org uuid means no quota bucket to key on. Fall back to the narrower account key,
  // then the email — an identity we cannot key is not one we should guess at.
  const key = usageKey ?? accountKey ?? (email ? `claude:email=${email}` : null);
  if (!key) return null;
  return {
    key,
    attributed: true,
    email,
    orgName,
    plan: planFromOrgType(organizationType),
    label: orgName && email ? `${orgName} <${email}>` : (orgName ?? email ?? key),
    evidence,
  };
}

/** A dark bucket, labelled by why it is dark so two dark sources never merge. */
function unattributed(reason: string): ClaudeAccountBucket {
  return {
    key: `unattributed:${reason}`,
    attributed: false,
    email: null,
    orgName: null,
    plan: null,
    label: `unattributed (${reason})`,
    evidence: 'none',
  };
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Enumerate every Claude home that could own an indexed transcript. Includes retired
 * `trash/` snapshots: they keep their `.claude.json`, so a transcript indexed before
 * its version was rotated out stays attributable.
 */
export function buildClaudeAccountIndex(): ClaudeAccountIndex {
  const entries: HomeEntry[] = [];
  const liveByVersion = new Map<string, ClaudeAccountBucket>();
  const trashByVersion = new Map<string, ClaudeAccountBucket[]>();

  const addHome = (home: string, version: string | null, retired: boolean): void => {
    const bucket = bucketForHome(home, 'version-home');
    if (!bucket) return;
    entries.push({ prefix: path.join(home, '.claude'), bucket });
    if (!version) return;
    if (retired) {
      const list = trashByVersion.get(version) ?? [];
      list.push(bucket);
      trashByVersion.set(version, list);
    } else {
      liveByVersion.set(version, bucket);
    }
  };

  for (const root of VERSIONS_ROOTS) {
    const versionsBase = path.join(root, 'versions', 'claude');
    for (const version of listDirs(versionsBase)) {
      addHome(path.join(versionsBase, version, 'home'), version, false);
    }
  }

  // Retired homes: <historyDir>/trash/versions/claude/<version>/<timestamp>/home
  const trashBase = path.join(getHistoryDir(), 'trash', 'versions', 'claude');
  for (const version of listDirs(trashBase)) {
    for (const stamp of listDirs(path.join(trashBase, version))) {
      addHome(path.join(trashBase, version, stamp, 'home'), version, true);
    }
  }

  // A live home is authoritative for its version. Otherwise the retired snapshots
  // decide, but only when they agree — disagreement is reported, not resolved.
  const byVersion = new Map<string, ClaudeAccountBucket | 'ambiguous'>();
  for (const [version, list] of trashByVersion) {
    const keys = new Set(list.map((b) => b.key));
    byVersion.set(
      version,
      keys.size === 1 ? { ...list[0], evidence: 'recorded-version' } : 'ambiguous',
    );
  }
  for (const [version, bucket] of liveByVersion) {
    byVersion.set(version, { ...bucket, evidence: 'recorded-version' });
  }

  // Longest prefix first so a nested home beats a shorter ancestor.
  entries.sort((a, b) => b.prefix.length - a.prefix.length);

  return {
    entries,
    byVersion,
    symlinkBucket: bucketForHome(HOME, 'symlink-target'),
    symlinkPrefix: path.join(HOME, '.claude'),
  };
}

/** Version segment of a versions/ or trash/ path, for labelling dark buckets. */
function versionFromPath(filePath: string): string | null {
  const m = /[/\\]versions[/\\]claude[/\\]([^/\\]+)[/\\]/.exec(filePath);
  return m ? m[1] : null;
}

/**
 * The account bucket a transcript belongs to. `recordedVersion` is the Claude CLI
 * version stored on the session row (`sessions.version`), which is what disambiguates
 * rows sitting under the mutable `~/.claude` symlink.
 *
 * Never returns null: a transcript that matches no known home resolves to an
 * explicitly dark bucket rather than being dropped or folded into a real account.
 * Backup mirrors (`<historyDir>/backups/claude/<stamp>/projects/…`) carry no
 * `.claude.json` and so are always dark. That is honest reporting, not a fallback.
 */
export function resolveClaudeAccount(
  index: ClaudeAccountIndex,
  filePath: string,
  recordedVersion?: string | null,
): ClaudeAccountBucket {
  // Tier 1 — the file physically lives in a known home.
  for (const entry of index.entries) {
    if (filePath.startsWith(entry.prefix + path.sep)) return entry.bucket;
  }

  if (filePath.startsWith(index.symlinkPrefix + path.sep)) {
    // Tier 2 — the symlink's target moves; the recorded version does not.
    if (recordedVersion) {
      const byVersion = index.byVersion.get(recordedVersion);
      if (byVersion === 'ambiguous') {
        return unattributed(`ambiguous history for version ${recordedVersion}`);
      }
      if (byVersion) return byVersion;
      return unattributed(`no home for version ${recordedVersion}`);
    }
    // Tier 3 — no recorded version. The current target is the only evidence there is.
    if (index.symlinkBucket) return index.symlinkBucket;
  }

  const version = versionFromPath(filePath);
  if (version) return unattributed(`signed-out home ${version}`);
  if (filePath.includes(`${path.sep}backups${path.sep}claude${path.sep}`)) {
    return unattributed('backup mirror');
  }
  return unattributed('unknown home');
}
