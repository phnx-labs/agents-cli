/**
 * Project workspace probing — the drift signal behind `projects status --fleet`.
 *
 * Projects are natively multi-device: the same definition (home-relative paths)
 * re-roots on every fleet machine, and the question is whether the project's
 * repos are PRESENT on each box, on which branch, how far ahead/behind their
 * upstream, and whether they carry uncommitted changes. This module is the pure
 * local half: given a set of home-relative paths it probes each one with a
 * handful of read-only git calls. Drift is measured against the LAST-FETCHED
 * upstream (`@{upstream}`) — deliberately no `git fetch`, so a probe is fast
 * and offline-safe. The fleet half (`--fleet`) just runs this probe on every
 * peer via the canonical `remote-agents-json` SSH fan-out.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import chalk from 'chalk';
import { expandLocalHome, toHomeRelative } from './project-root.js';
import type { ProjectDef } from './projects.js';

/** Per-call git budget. A read-only git call taking >3s is wedged by any
 * definition (NFS stall, index lock) — and the fleet fan-out SIGKILLs the SSH
 * hop at 12s, so a probe must fit inside that budget to avoid a slow peer
 * being misreported as unreachable: 3s × 5 calls leaves headroom even when
 * one repo is genuinely stuck. */
const GIT_TIMEOUT_MS = 3_000;

/** The on-disk state of one workspace repo on one machine. */
export interface RepoWorkspaceStatus {
  /** The probed path, echoed home-relative (re-roots per machine). */
  path: string;
  /** `.git` exists (a directory, or a FILE for a linked worktree). */
  present: boolean;
  branch?: string;
  /** The configured upstream ref (e.g. `origin/main`); absent → no upstream. */
  upstream?: string;
  /** Commits on HEAD not on the upstream. Undefined without an upstream. */
  ahead?: number;
  /** Commits on the upstream not on HEAD. Undefined without an upstream. */
  behind?: number;
  /** Uncommitted (incl. untracked) paths from `git status --porcelain`. */
  dirty?: number;
  /** ISO 8601 committer date of HEAD. */
  lastCommit?: string;
  /** `.git` exists but git could not read it — never looks silently clean. */
  error?: string;
}

/** A probe result tagged with the machine that answered (the fleet view). */
export interface HostWorkspaceStatus extends RepoWorkspaceStatus {
  host: string;
}

/** One read-only git call against `absPath`; undefined on any failure. */
function git(absPath: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', absPath, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Probe one workspace repo. A missing path yields `{present: false}` and no
 * git call is made. On a present repo every signal is best-effort: whatever
 * succeeded is reported, and a repo whose `.git` exists yet every git call
 * failed surfaces as present-with-error rather than silently clean.
 */
export function probeRepoWorkspace(absPath: string): RepoWorkspaceStatus {
  const status: RepoWorkspaceStatus = { path: toHomeRelative(absPath), present: false };
  if (!fs.existsSync(path.join(absPath, '.git'))) return status;
  status.present = true;

  const branch = git(absPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const upstream = git(absPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  // `--left-right --count A...B` prints "<left>\t<right>" — left is
  // upstream-only (we are BEHIND by that much), right is HEAD-only (AHEAD).
  const counts = upstream !== undefined
    ? git(absPath, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
    : undefined;
  const dirtyOut = git(absPath, ['status', '--porcelain']);
  const lastCommit = git(absPath, ['log', '-1', '--format=%cI']);

  if (branch === undefined && dirtyOut === undefined && lastCommit === undefined) {
    status.error = '.git exists but git could not read this repo';
    return status;
  }
  if (branch !== undefined) status.branch = branch;
  if (upstream !== undefined) status.upstream = upstream;
  if (counts !== undefined) {
    const [behind, ahead] = counts.split(/\s+/).map(Number);
    if (Number.isFinite(behind) && Number.isFinite(ahead)) {
      status.behind = behind;
      status.ahead = ahead;
    }
  }
  if (dirtyOut !== undefined) status.dirty = dirtyOut === '' ? 0 : dirtyOut.split('\n').length;
  if (lastCommit !== undefined) status.lastCommit = lastCommit;
  return status;
}

/** Probe each home-relative path (expanded against the local home), in order. */
export function probeProjectWorkspaces(paths: string[]): RepoWorkspaceStatus[] {
  return paths.map((p) => probeRepoWorkspace(expandLocalHome(p)));
}

/**
 * The home-relative paths to probe for a project definition: its `root` plus
 * each `repos[].path` (the opt-in for additional repos), deduped. Every target
 * is normalized through the same `toHomeRelative(expandLocalHome(...))` the
 * probe echoes, so a hand-edited def (absolute path under home, trailing
 * slash) matches its probe rows exactly — `writeProjectDef` normalizes on
 * write, but defs are hand-editable YAML and never silently drop a row.
 */
export function workspaceTargetsForDef(def: ProjectDef): string[] {
  const targets = [def.root, ...(def.repos ?? []).map((r) => r.path)]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => toHomeRelative(expandLocalHome(p)));
  return [...new Set(targets)];
}

/**
 * Parse a peer's `projects probe --json` stdout, tagging each row with the
 * machine that answered. Defensive against version skew / partial output, the
 * same boundary contract as `parseRemoteActive`: non-JSON or a non-array
 * yields `[]`, and rows without a `path`/`present` core are dropped.
 */
export function parseRemoteProbe(stdout: string, machine: string): HostWorkspaceStatus[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((x) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const o = x as Record<string, unknown>;
      if (typeof o.path === 'string' && typeof o.present === 'boolean') {
        return [{ ...(o as unknown as RepoWorkspaceStatus), host: machine }];
      }
    }
    return [];
  });
}

/**
 * One workspace's compact state: `✓ clean · main`, `⚠ 12 dirty · ↑3 ↓1 ·
 * feature/x`, `✗ missing`, or `⚠ error: …`. Pure — chalk styling only.
 */
export function formatWorkspaceLine(s: RepoWorkspaceStatus): string {
  if (!s.present) return chalk.red('✗ missing');
  if (s.error) return chalk.yellow(`⚠ error: ${s.error}`);
  const parts: string[] = [];
  if (s.dirty !== undefined && s.dirty > 0) parts.push(`${s.dirty} dirty`);
  const drift = [
    s.ahead !== undefined && s.ahead > 0 ? `↑${s.ahead}` : '',
    s.behind !== undefined && s.behind > 0 ? `↓${s.behind}` : '',
  ].filter(Boolean).join(' ');
  if (drift) parts.push(drift);
  const head = parts.length > 0 ? chalk.yellow(`⚠ ${parts.join(' · ')}`) : chalk.green('✓ clean');
  return s.branch ? `${head} ${chalk.dim('·')} ${s.branch}` : head;
}

/**
 * The fleet view of one project's workspaces: one content line per probed
 * path (host-sorted `host: state` cells joined by ` · `), labelled with the
 * path when a project probes more than one. Pure — the caller adds the
 * `fleet` row label.
 */
export function formatFleetWorkspaces(statuses: HostWorkspaceStatus[]): string[] {
  const paths = [...new Set(statuses.map((s) => s.path))];
  const multi = paths.length > 1;
  return paths.map((p) => {
    const rows = statuses
      .filter((s) => s.path === p)
      .sort((a, b) => a.host.localeCompare(b.host));
    const body = rows.map((r) => `${chalk.cyan(r.host)}: ${formatWorkspaceLine(r)}`).join(chalk.dim('  ·  '));
    return multi ? `${chalk.dim(`${p} · `)}${body}` : body;
  });
}

/** Severity for a workspace/repo warning on the project card. */
export type WorkspaceWarningSeverity = 'critical' | 'continue';

export interface WorkspaceWarning {
  severity: WorkspaceWarningSeverity;
  text: string;
  remediation?: string;
}

/**
 * Turn probed workspace rows into card-footer warnings.
 *
 * - missing / unreadable git → critical (agents there cannot share a tree)
 * - behind upstream → critical when ≥10 commits, continue otherwise
 * - dirty tree → continue (local work is fine; just note it)
 * - ahead-only is not a warning (that is progress waiting to push)
 *
 * Pure. Caller decides whether the rows came from `--fleet` or a local probe.
 */
export function workspaceWarnings(statuses: HostWorkspaceStatus[]): WorkspaceWarning[] {
  const out: WorkspaceWarning[] = [];
  for (const s of [...statuses].sort((a, b) => a.host.localeCompare(b.host) || a.path.localeCompare(b.path))) {
    const where = s.host ? `${s.host}` : 'local';
    const pathBit = s.path ? ` (${s.path})` : '';
    if (!s.present) {
      out.push({
        severity: 'critical',
        text: `${where}: checkout missing${pathBit}`,
        remediation: 'clone or sync the project root on that host before landing agents there',
      });
      continue;
    }
    if (s.error) {
      out.push({
        severity: 'critical',
        text: `${where}: ${s.error}${pathBit}`,
      });
      continue;
    }
    if (s.behind !== undefined && s.behind > 0) {
      out.push({
        severity: s.behind >= 10 ? 'critical' : 'continue',
        text: `${where} is ${s.behind} commit${s.behind === 1 ? '' : 's'} behind ${s.upstream ?? 'upstream'}${pathBit}`,
        remediation: 'pull (or rebase) before agents on this host open PRs against a stale base',
      });
    }
    if (s.dirty !== undefined && s.dirty > 0) {
      out.push({
        severity: 'continue',
        text: `${where} has ${s.dirty} uncommitted change${s.dirty === 1 ? '' : 's'}${pathBit}`,
      });
    }
  }
  return out;
}

