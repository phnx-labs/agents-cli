import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Command } from 'commander';
import simpleGit from 'simple-git';
import {
  computeProjectListWidths,
  formatFleetSkippedNote,
  formatFleetUnverifiedNote,
  formatForCwdOutput,
  formatMilestoneDue,
  formatMilestoneLines,
  formatNextMilestone,
  projectRepoFromDir,
  registerProjectsCommands,
  type ProjectListRow,
} from './projects.js';
import {
  fingerprintTargets,
  parseProjectPullEnvelope,
  pullLocalArgs,
} from '../lib/project-pull.js';
import { machineId } from '../lib/machine-id.js';
import type { ProjectRepoTarget } from '../lib/projects.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('formatFleetSkippedNote', () => {
  it('says nothing when every peer answered', () => {
    expect(formatFleetSkippedNote([])).toBe('');
  });

  it('names up to four peers, collapsing the rest to +N, with honest reasons', () => {
    expect(stripAnsi(formatFleetSkippedNote(['gpu-box'])))
      .toBe("  · 1 device didn't answer (unreachable, older agents-cli, or timed out): gpu-box\n");
    expect(stripAnsi(formatFleetSkippedNote(['a', 'b', 'c', 'd', 'e', 'f'])))
      .toBe("  · 6 devices didn't answer (unreachable, older agents-cli, or timed out): a, b, c, d +2\n");
  });
});

describe('formatForCwdOutput', () => {
  it('emits {"name": "<slug>"} for a JSON match', () => {
    expect(formatForCwdOutput('agents-cli', true)).toBe('{"name":"agents-cli"}');
  });

  it('emits {"name": null} for a JSON non-match — never empty, so a caller can tell "ran, no match" from a crash', () => {
    expect(formatForCwdOutput(undefined, true)).toBe('{"name":null}');
  });

  it('prints the bare name for a plain-text match', () => {
    expect(formatForCwdOutput('agents-cli', false)).toBe('agents-cli');
  });

  it('prints nothing for a plain-text non-match', () => {
    expect(formatForCwdOutput(undefined, false)).toBe('');
  });
});

describe('computeProjectListWidths', () => {
  /** Render a row the way `list` does, so a bleeding column shows up as a shifted gridline. */
  const render = (r: ProjectListRow, w: { name: number; path: number; repo: number }) =>
    `  ${r.name.padEnd(w.name)} ${r.path.padEnd(w.path)} ${r.repo.padEnd(w.repo)} 0 agents`;

  it('sizes every column to the widest row instead of a fixed 32', () => {
    const rows: ProjectListRow[] = [
      { name: 'agents', path: '~/src/github.com/muqsitnawaz/agents', repo: 'muqsitnawaz/agents' },
      { name: 'agents-cli', path: '~/src/github.com/muqsitnawaz/agents-cli', repo: 'muqsitnawaz/agents-cli' },
    ];
    const w = computeProjectListWidths(rows);
    expect(w).toEqual({ name: 10, path: 39, repo: 22 });
    // The repo column starts at the same offset on every row — the bug was a
    // 32-char pad that a ~39-char home-relative path ran straight through.
    const offsets = rows.map((r) => render(r, w).indexOf(r.repo));
    expect(new Set(offsets).size).toBe(1);
  });

  it('caps the path column so one long root cannot widen the whole table', () => {
    const w = computeProjectListWidths([
      { name: 'a', path: '~/' + 'x'.repeat(120), repo: 'o/r' },
      { name: 'b', path: '~/short', repo: 'o/r2' },
    ]);
    expect(w.path).toBe(48);
  });

  it('collapses to zero-width columns when there is nothing to show', () => {
    expect(computeProjectListWidths([])).toEqual({ name: 0, path: 0, repo: 0 });
    expect(computeProjectListWidths([{ name: 'a', path: '', repo: '' }])).toEqual({ name: 1, path: 0, repo: 0 });
  });
});

describe('formatMilestoneDue', () => {
  /** Local noon on 2026-08-03, so a timezone slip shows up as a whole-day error. */
  const now = new Date(2026, 7, 3, 12, 0, 0).getTime();

  it('speaks in days a person would use', () => {
    expect(formatMilestoneDue('2026-08-03', now)).toBe('due today');
    expect(formatMilestoneDue('2026-08-04', now)).toBe('due tomorrow');
    expect(formatMilestoneDue('2026-08-09', now)).toBe('due in 6 days');
    expect(formatMilestoneDue('2026-08-02', now)).toBe('overdue by a day');
    expect(formatMilestoneDue('2026-07-27', now)).toBe('overdue by 7 days');
  });

  it('switches to a calendar date once the countdown stops being useful', () => {
    expect(formatMilestoneDue('2026-08-21', now)).toBe('due Aug 21');
    // A different year has to say which one.
    expect(formatMilestoneDue('2027-01-15', now)).toBe('due Jan 15, 2027');
  });

  it('reads the date at LOCAL midnight, not UTC', () => {
    // `new Date('2026-08-03')` is UTC midnight — west of Greenwich that is
    // Aug 2 locally, and this would read "overdue by a day" instead of "today".
    expect(formatMilestoneDue('2026-08-03', new Date(2026, 7, 3, 23, 59).getTime())).toBe('due today');
    expect(formatMilestoneDue('2026-08-03', new Date(2026, 7, 3, 0, 1).getTime())).toBe('due today');
  });

  it('returns nothing for a value that is not a calendar date', () => {
    expect(formatMilestoneDue('', now)).toBeUndefined();
    expect(formatMilestoneDue('someday', now)).toBeUndefined();
    expect(formatMilestoneDue('2026-08-03T00:00:00Z', now)).toBeUndefined();
  });
});

describe('formatNextMilestone', () => {
  const now = new Date(2026, 7, 3, 12, 0, 0).getTime();

  it('reads name, progress, then when it is due', () => {
    expect(stripAnsi(formatNextMilestone({ name: 'Beta cut', targetDate: '2026-08-09', done: 3, total: 8 }, now)))
      .toBe('Beta cut  ·  3/8  ·  due in 6 days');
  });

  it('omits the date entirely when the milestone has none', () => {
    expect(stripAnsi(formatNextMilestone({ name: 'Someday', done: 0, total: 4 }, now)))
      .toBe('Someday  ·  0/4');
  });

  it('omits the fraction when nothing is filed under the milestone yet', () => {
    // 0/0 is noise. This is the real shape of every milestone in this repo's
    // own Linear project.
    expect(stripAnsi(formatNextMilestone({ name: 'Factory onboarding', targetDate: '2026-09-15', done: 0, total: 0 }, now)))
      .toBe('Factory onboarding  ·  due Sep 15');
  });

  it('does not print a raw date when the stored value is unparseable', () => {
    expect(stripAnsi(formatNextMilestone({ name: 'Odd', targetDate: 'not-a-date', done: 1, total: 2 }, now)))
      .toBe('Odd  ·  1/2');
  });
});

describe('formatMilestoneLines', () => {
  const now = new Date(2026, 7, 3, 12, 0, 0).getTime();
  const ms = [
    { name: 'Factory converts strategy', targetDate: '2026-09-15', done: 0, total: 0 },
    { name: 'Factory reliability', targetDate: '2026-09-30', done: 0, total: 0 },
    { name: 'Factory onboarding', targetDate: '2026-10-15', done: 0, total: 0 },
  ];

  it('shows one line plus a pointer on the compact card', () => {
    const out = formatMilestoneLines(ms, ms[0], now, 1).map(stripAnsi);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('next');
    expect(out[0]).toContain('Factory converts strategy');
    expect(out[1]).toContain('+2 more milestones');
    expect(out[1]).toContain('agents projects view');
  });

  it('shows every milestone when the limit allows, with no pointer', () => {
    const out = formatMilestoneLines(ms, ms[0], now, 99).map(stripAnsi);
    expect(out).toHaveLength(3);
    expect(out.join('\n')).toContain('Factory onboarding');
    expect(out.join('\n')).not.toContain('more milestone');
  });

  it('labels the first row `plan` when there is no next at all', () => {
    const out = formatMilestoneLines(ms, undefined, now, 1).map(stripAnsi);
    expect(out[0].trimStart().startsWith('plan')).toBe(true);
  });

  it('leads with the NEXT milestone even when a different one is dated earlier', () => {
    // Linear can flag a later milestone as next. Slicing the date-ordered front
    // would show the earlier one and bury the actual next under "+N more".
    const out = formatMilestoneLines(ms, ms[2], now, 1).map(stripAnsi);
    expect(out[0]).toContain('next');
    expect(out[0]).toContain('Factory onboarding');
    expect(out[1]).toContain('+2 more');
  });

  it('does not repeat the next milestone further down the full list', () => {
    const out = formatMilestoneLines(ms, ms[2], now, 99).map(stripAnsi);
    expect(out).toHaveLength(3);
    expect(out.filter((l) => l.includes('Factory onboarding'))).toHaveLength(1);
    expect(out[0]).toContain('Factory onboarding');
  });

  it('labels the right row when two milestones share a name', () => {
    const dup = [
      { name: 'Cut', targetDate: '2026-09-01', done: 0, total: 0 },
      { name: 'Cut', targetDate: '2026-10-01', done: 0, total: 0 },
    ];
    // Matching on name alone put the label on the Sep row.
    const out = formatMilestoneLines(dup, dup[1], now, 99).map(stripAnsi);
    expect(out[0]).toContain('next');
    expect(out[0]).toContain('Oct 1');
    expect(out[1]).not.toContain('next');
  });

  it('renders nothing when the project declares no milestones', () => {
    expect(formatMilestoneLines([], undefined, now, 1)).toEqual([]);
  });

  it('still renders a next carried alone by an older cached answer', () => {
    // A cache entry written before `milestones` existed has only `nextMilestone`.
    const out = formatMilestoneLines([], ms[0], now, 1).map(stripAnsi);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Factory converts strategy');
  });
});

describe('projectRepoFromDir', () => {
  // Real git repos with real remotes — the whole point of the function is that
  // it reads `git remote get-url origin`, so a fixture without git tests nothing.
  let tmp: string;

  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  const repoAt = (name: string, origin?: string): string => {
    const p = path.join(tmp, name);
    fs.mkdirSync(p, { recursive: true });
    git(p, ['init', '-b', 'main']);
    if (origin) git(p, ['remote', 'add', 'origin', origin]);
    return p;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'projrepo-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads the slug from the directory OWN origin, not from its path', () => {
    // The regression this guards: a checkout under `.../muqsitnawaz/agents-cli`
    // whose origin is `phnx-labs/agents-cli` must record what it pushes to.
    const dir = repoAt(path.join('muqsitnawaz', 'agents-cli'), 'git@github.com:phnx-labs/agents-cli.git');
    const r = projectRepoFromDir(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repo.slug).toBe('phnx-labs/agents-cli');
  });

  it('refuses a directory with no origin, and names the flag that fixes it', () => {
    const dir = repoAt('no-origin');
    const r = projectRepoFromDir(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/no origin remote/);
      expect(r.error).toMatch(/--slug <owner\/repo>/);
    }
  });

  it('accepts an explicit slug override for a directory with no origin', () => {
    const dir = repoAt('vendored');
    const r = projectRepoFromDir(dir, 'phnx-labs/thing');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repo.slug).toBe('phnx-labs/thing');
  });

  it('refuses a path that does not exist, and one that is a file', () => {
    const missing = projectRepoFromDir(path.join(tmp, 'nope'));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/No such directory/);

    const file = path.join(tmp, 'a-file');
    fs.writeFileSync(file, 'x');
    const notDir = projectRepoFromDir(file);
    expect(notDir.ok).toBe(false);
    if (!notDir.ok) expect(notDir.error).toMatch(/Not a directory/);
  });

  it('stores the path home-relative when the directory lives under $HOME', () => {
    // Portability: the same definition has to re-root on every machine.
    const home = process.env.HOME ?? os.homedir();
    const under = path.join(home, `.projrepo-test-${process.pid}`);
    fs.mkdirSync(under, { recursive: true });
    try {
      git(under, ['init', '-b', 'main']);
      git(under, ['remote', 'add', 'origin', 'git@github.com:o/r.git']);
      const r = projectRepoFromDir(under);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.repo.path?.startsWith('~/')).toBe(true);
    } finally {
      fs.rmSync(under, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// formatFleetUnverifiedNote
// ---------------------------------------------------------------------------

describe('formatFleetUnverifiedNote', () => {
  it('says nothing when every answer verified', () => {
    expect(formatFleetUnverifiedNote([])).toBe('');
  });

  it('names the peers whose answer could not be trusted, distinctly from silence', () => {
    expect(stripAnsi(formatFleetUnverifiedNote(['gpu-box'])))
      .toBe('  · 1 device answered with a result that could not be verified: gpu-box\n');
    expect(stripAnsi(formatFleetUnverifiedNote(['a', 'b', 'c', 'd', 'e'])))
      .toBe('  · 5 devices answered with a result that could not be verified: a, b, c, d +1\n');
  });
});

// ---------------------------------------------------------------------------
// `projects pull` → `projects pull-local` CLI-arg round trip (RUSH-2536)
// ---------------------------------------------------------------------------

/**
 * The seam the fleet fan-out actually crosses: `pull` serializes its targets
 * into an argv, ssh hands that argv to a peer, and the peer's `pull-local`
 * rebuilds targets from it. Both halves are exercised for real here — the real
 * `pullLocalArgs` builder, the real commander command parsing that argv, real
 * git checkouts underneath — because the two things that broke were only
 * visible ACROSS this boundary:
 *
 *   1. `expectedSlug` never crossed it, so slug verification silently became a
 *      no-op on every remote peer;
 *   2. the peer's fingerprint (which hashes the slug) could then never match
 *      the caller's, so `parseProjectPullEnvelope` discarded the peer's ENTIRE
 *      result set — with no skipped/parseFailed marker, because a bare `[]`
 *      reads as "valid, zero items".
 *
 * Neither shows up in a unit test of either half alone: `pullProjectTargets`
 * verifies slugs correctly when handed slugs, and the envelope round-trips
 * correctly when both sides hash the same targets.
 */
describe('projects pull-local — CLI-arg round trip from pull', () => {
  let root: string;
  let remote: string;
  let author: string;
  let plain: string;
  let mismatched: string;

  async function configIdentity(dir: string): Promise<void> {
    const g = simpleGit(dir);
    await g.addConfig('user.email', 'test@example.com');
    await g.addConfig('user.name', 'Test');
    await g.addConfig('commit.gpgsign', 'false');
  }

  /** Run the real `agents projects pull-local …` argv and capture its stdout. */
  async function runPullLocal(args: string[]): Promise<string> {
    const program = new Command();
    program.exitOverride();
    registerProjectsCommands(program);
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      await program.parseAsync(args, { from: 'user' });
    } finally {
      console.log = realLog;
    }
    return lines.join('\n');
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-pull-cli-'));
    remote = path.join(root, 'remote.git');
    author = path.join(root, 'author');
    plain = path.join(root, 'plain');
    mismatched = path.join(root, 'mismatched');

    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]);
    await simpleGit().clone(remote, author);
    await configIdentity(author);
    fs.writeFileSync(path.join(author, 'README.md'), 'v1\n');
    await simpleGit(author).add('-A');
    await simpleGit(author).commit('init');
    await simpleGit(author).push('origin', 'main');

    await simpleGit().clone(remote, plain);
    await configIdentity(plain);
    await simpleGit().clone(remote, mismatched);
    await configIdentity(mismatched);
    // This checkout hosts a DIFFERENT repo than the project declares.
    await simpleGit(mismatched).raw(['remote', 'set-url', 'origin', 'https://github.com/org/other.git']);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('carries expectedSlug across the boundary, so the peer verifies slugs AND its fingerprint matches', async () => {
    const targets: ProjectRepoTarget[] = [
      { path: plain },
      { path: mismatched, expectedSlug: 'org/a' },
    ];
    // Exactly what the orchestrating `pull` sends each peer, and exactly the
    // fingerprint it will verify the peer's answer against.
    const expectedFingerprint = fingerprintTargets(targets);
    const stdout = await runPullLocal(pullLocalArgs(targets));

    const parsed = parseProjectPullEnvelope(stdout, machineId(), { expectedFingerprint });

    // Fingerprint agreement: the slug survived the hop. With bare paths on the
    // wire this is `valid: false` / zero items — the peer's whole answer gone.
    expect(parsed.valid).toBe(true);
    expect(parsed.items).toHaveLength(2);

    // Slug verification actually ran on the peer.
    const blocked = parsed.items.find((r) => r.path === mismatched);
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.message).toMatch(/Slug mismatch: expected org\/a, found org\/other/);
    expect(blocked?.expectedSlug).toBe('org/a');

    // The slug-less target is still pulled normally.
    expect(parsed.items.find((r) => r.path === plain)?.status).toBe('current');
  });

  it('rejects a peer answer whose fingerprint does not match the targets that were sent', async () => {
    // A peer that answered about a DIFFERENT target set must never be folded
    // into the results as if it had answered ours.
    const sent: ProjectRepoTarget[] = [{ path: plain, expectedSlug: 'org/a' }];
    const stdout = await runPullLocal(pullLocalArgs([{ path: plain }]));

    expect(parseProjectPullEnvelope(stdout, machineId(), {
      expectedFingerprint: fingerprintTargets(sent),
    })).toEqual({ items: [], valid: false });
  });
});
