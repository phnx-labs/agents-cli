import { describe, it, expect } from 'vitest';
import { execPolicyWarningLines, renderFleetDivergence, wrapLine, computeVerdict, computeOverviewHealth, verdictIsAutoFixable, healthBlockLines } from './doctor.js';
import { stringWidth, stripAnsi } from '../lib/session/width.js';
import type { ResourceDiff, VersionResourceReport } from '../lib/doctor-diff.js';
import type { SyncStatusRow, OrphanRow } from '../lib/drift.js';
import type { FetchStatusMarker } from '../lib/auto-pull.js';
import { compareFleetInventories, FLEET_RESOURCE_KINDS, type FleetInventory, type FleetResourceKind } from '../lib/devices/fleet-divergence.js';

/** Minimal reconciled report; override the fields a case cares about. */
function baseReport(over: Partial<VersionResourceReport> = {}): VersionResourceReport {
  return {
    agent: 'claude',
    version: '2.1.207',
    home: '/home/.claude',
    cwd: '/work',
    layers: { project: null, user: '~/.agents', system: '~/.agents/.system', extras: [] },
    kinds: { commands: [], skills: [], hooks: [], rules: [], mcp: [], permissions: [], subagents: [], plugins: [], promptcuts: [] },
    summary: { ok: 32, diff: 0, missing: 0, extra: 0 },
    ...over,
  };
}

/** A single resource diff row for seeding a report's `kinds`. */
function row(kind: ResourceDiff['kind'], name: string, status: ResourceDiff['status'], detail?: string): ResourceDiff {
  return { kind, name, status, detail };
}

function inv(plugins: string[] = []): FleetInventory {
  const resources = {} as Record<FleetResourceKind, string[]>;
  for (const k of FLEET_RESOURCE_KINDS) resources[k] = k === 'plugins' ? plugins : [];
  return { resources, agentVersions: {}, repos: { agents: null, system: null } };
}

describe('execPolicyWarningLines (Windows exec-policy advisory in `agents doctor`)', () => {
  it('fires when the policy blocks local scripts (Restricted) — with the RemoteSigned remediation', () => {
    const lines = execPolicyWarningLines('win32', 'Restricted');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('Restricted');
    // The remediation and the `.cmd` still-works note must both be surfaced.
    expect(lines.some((l) => l.includes('Set-ExecutionPolicy -Scope CurrentUser RemoteSigned'))).toBe(true);
    expect(lines.some((l) => l.includes('agents.cmd'))).toBe(true);
  });

  it('fires for AllSigned too', () => {
    expect(execPolicyWarningLines('win32', 'AllSigned').length).toBeGreaterThan(0);
  });

  it('stays silent for a permissive policy (RemoteSigned)', () => {
    expect(execPolicyWarningLines('win32', 'RemoteSigned')).toEqual([]);
  });

  it('stays silent when the policy can not be determined (null)', () => {
    expect(execPolicyWarningLines('win32', null)).toEqual([]);
  });

  it('never fires off Windows, even under a blocking policy', () => {
    expect(execPolicyWarningLines('linux', 'Restricted')).toEqual([]);
    expect(execPolicyWarningLines('darwin', 'AllSigned')).toEqual([]);
  });
});

describe('wrapLine', () => {
  it('wraps advisory text under its prefix', () => {
    const lines = wrapLine('  ', 'Reconcile with `agents doctor claude@latest --fix` or `agents sync claude@latest` (not applied on launch).', 62);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => stringWidth(line) <= 62)).toBe(true);
    expect(lines[1].startsWith('  ')).toBe(true);
  });

  it('collapses embedded newlines before wrapping', () => {
    expect(wrapLine('  ', 'one\n\n  two\tthree', 80)).toEqual(['  one two three']);
  });
});

describe('computeVerdict (doctor per-version triaged health)', () => {
  it('is healthy when nothing diverges — with the reconciled count carried', () => {
    const v = computeVerdict(baseReport({ summary: { ok: 34, diff: 0, missing: 0, extra: 0 } }));
    expect(v.healthy).toBe(true);
    expect(v.issues).toEqual([]);
    expect(v.reconciled).toBe(34);
  });

  it('classifies an UNWIRED hook as CRITICAL with the sync fix — even when every file is ok', () => {
    // The yosemite-s1 bug: 32 hook files reconcile ok, but one is never wired
    // into settings.json. Files-ok must NOT read as healthy.
    const v = computeVerdict(
      baseReport({
        version: '2.1.220',
        hookWiring: {
          supported: true,
          settingsPath: '/home/.claude/settings.json',
          expected: 32,
          unwired: [{ name: 'ask-user-question-guard', event: 'PreToolUse', matcher: 'AskUserQuestion', command: '~/x.sh' }],
        },
      }),
    );
    expect(v.healthy).toBe(false);
    const issue = v.issues.find((i) => i.category === 'unwired-hook');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('critical');
    expect(issue!.subject).toBe('ask-user-question-guard');
    expect(issue!.impact).toContain('not wired into settings.json');
    expect(issue!.fix).toBe('agents sync claude@2.1.220 --yes');
  });

  it('classifies a missing settings.json as CRITICAL and names the unwired count', () => {
    const v = computeVerdict(
      baseReport({
        hookWiring: { supported: true, settingsPath: '/home/.claude/settings.json', expected: 3, settingsMissing: true, unwired: [] },
      }),
    );
    expect(v.healthy).toBe(false);
    const issue = v.issues.find((i) => i.category === 'settings-missing');
    expect(issue!.severity).toBe('critical');
    expect(issue!.impact).toContain('3 declared hooks never fire');
  });

  it('classifies a source layer behind origin as WARNING with the repo-pull fix (not a --fix)', () => {
    const v = computeVerdict(
      baseReport({
        sourceBehind: [{ layer: 'user', label: '~/.agents', alias: 'user', behind: 75, branch: 'origin/main' }],
      }),
    );
    expect(v.healthy).toBe(false);
    const issue = v.issues.find((i) => i.category === 'source-behind');
    expect(issue!.severity).toBe('warning');
    expect(issue!.subject).toBe('~/.agents');
    expect(issue!.impact).toContain('75 commits behind origin/main');
    expect(issue!.fix).toBe('agents repo pull user');
  });

  it('triages a MISSING resource as critical, a DIVERGENT as warning, an EXTRA as info — by name', () => {
    const v = computeVerdict(
      baseReport({
        version: '2.1.220',
        summary: { ok: 0, diff: 1, missing: 1, extra: 1 },
        kinds: {
          commands: [row('commands', 'deploy', 'missing')],
          skills: [row('skills', '11-activity-log', 'diff')],
          hooks: [], rules: [], mcp: [], permissions: [],
          subagents: [row('subagents', 'ghost', 'extra')],
          plugins: [], promptcuts: [],
        },
      }),
    );
    expect(v.healthy).toBe(false);
    const byCat = Object.fromEntries(v.issues.map((i) => [i.category, i]));
    expect(byCat['missing'].severity).toBe('critical');
    expect(byCat['missing'].subject).toBe('deploy');
    expect(byCat['divergent'].severity).toBe('warning');
    expect(byCat['divergent'].subject).toBe('11-activity-log');
    expect(byCat['divergent'].fix).toBe('agents doctor claude@2.1.220 --fix');
    expect(byCat['extra'].severity).toBe('info');
    expect(byCat['extra'].subject).toBe('ghost');
    expect(byCat['extra'].fix).toBe('agents prune cleanup');
    // Critical is ordered before warning before info.
    expect(v.issues.map((i) => i.severity)).toEqual(['critical', 'warning', 'info']);
  });

  it('a source-behind-only verdict is NOT auto-fixable (repo pull, not --fix)', () => {
    const v = computeVerdict(
      baseReport({ sourceBehind: [{ layer: 'user', label: '~/.agents', alias: 'user', behind: 3, branch: 'origin/main' }] }),
    );
    expect(verdictIsAutoFixable(v)).toBe(false);
  });

  it('a divergent resource IS auto-fixable', () => {
    const v = computeVerdict(
      baseReport({
        summary: { ok: 0, diff: 1, missing: 0, extra: 0 },
        kinds: { commands: [], skills: [row('skills', 'x', 'diff')], hooks: [], rules: [], mcp: [], permissions: [], subagents: [], plugins: [], promptcuts: [] },
      }),
    );
    expect(verdictIsAutoFixable(v)).toBe(true);
  });
});

describe('computeOverviewHealth (bare `agents doctor` triage across versions)', () => {
  const syncRow = (over: Partial<SyncStatusRow> = {}): SyncStatusRow =>
    ({ agent: 'claude', version: '2.1.220', status: 'fresh', isDefault: true, ...over });
  const marker = (over: Partial<FetchStatusMarker> = {}): FetchStatusMarker =>
    ({ alias: 'user', dir: '/home/.agents', behind: 16, branch: 'origin/main', fetchedAt: 0, ...over } as FetchStatusMarker);

  it('is healthy when every version is fresh, wired, and sources current', () => {
    const v = computeOverviewHealth([syncRow()], [], []);
    expect(v.healthy).toBe(true);
    expect(v.reconciled).toBe(1);
  });

  it('folds an unwired hook (critical), a behind source (warning), and an orphan (info)', () => {
    const sync: SyncStatusRow[] = [
      syncRow({ unwiredHooks: 1 }),
      syncRow({ version: '2.1.200', status: 'stale' }),
    ];
    const orphans: OrphanRow[] = [{ agent: 'claude', version: '2.1.220', commands: 2, skills: 0, hooks: 0 }];
    const v = computeOverviewHealth(sync, orphans, [marker()]);
    expect(v.healthy).toBe(false);
    const cats = v.issues.map((i) => i.category);
    expect(cats).toContain('unwired-hook');
    expect(cats).toContain('source-behind');
    expect(cats).toContain('stale');
    expect(cats).toContain('orphan');
    const unwired = v.issues.find((i) => i.category === 'unwired-hook')!;
    expect(unwired.severity).toBe('critical');
    expect(unwired.fix).toBe('agents sync claude@2.1.220 --yes');
    const behind = v.issues.find((i) => i.category === 'source-behind')!;
    expect(behind.subject).toBe('~/.agents');
    expect(behind.fix).toBe('agents repo pull user');
    expect(v.issues.find((i) => i.category === 'orphan')!.severity).toBe('info');
    // A stale version makes it auto-fixable via `agents doctor --fix`.
    expect(verdictIsAutoFixable(v)).toBe(true);
  });
});

describe('healthBlockLines (triaged health rendering)', () => {
  it('renders a single green ✓ line when healthy', () => {
    const v = computeVerdict(baseReport({ summary: { ok: 34, diff: 0, missing: 0, extra: 0 } }));
    const out = healthBlockLines(v, { healthySummary: '34 resources reconciled · hooks wired · sources current' }).map(stripAnsi);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('✓ healthy');
    expect(out[0]).toContain('34 resources reconciled · hooks wired · sources current');
  });

  it('renders a severity-counted header, one row + fix per finding, and the heal footer', () => {
    const v = computeVerdict(
      baseReport({
        version: '2.1.220',
        summary: { ok: 30, diff: 1, missing: 0, extra: 0 },
        hookWiring: {
          supported: true, settingsPath: '/home/.claude/settings.json', expected: 32,
          unwired: [{ name: 'ask-user-question-guard', event: 'PreToolUse', matcher: 'AskUserQuestion', command: '~/x.sh' }],
        },
        sourceBehind: [{ layer: 'user', label: '~/.agents', alias: 'user', behind: 16, branch: 'origin/main' }],
        kinds: { commands: [], skills: [row('skills', '11-activity-log', 'diff')], hooks: [], rules: [], mcp: [], permissions: [], subagents: [], plugins: [], promptcuts: [] },
      }),
    );
    const out = healthBlockLines(v, { healthySummary: 'x', healFix: 'agents doctor claude@2.1.220 --fix' }).map(stripAnsi);
    const joined = out.join('\n');
    expect(joined).toContain('✗ unhealthy — 3 issues (1 critical · 2 warnings)');
    expect(joined).toContain('✗ critical  ask-user-question-guard — on disk but not wired into settings.json');
    expect(joined).toContain('→ agents sync claude@2.1.220 --yes');
    expect(joined).toContain('⚠ warning   ~/.agents — 16 commits behind origin/main');
    expect(joined).toContain('→ agents repo pull user');
    expect(joined).toContain("heal what's auto-fixable:  agents doctor claude@2.1.220 --fix");
  });

  it('caps the info tier with a "+N more orphans" rollup', () => {
    const extras: ResourceDiff[] = [];
    for (let i = 0; i < 9; i++) extras.push(row('skills', `orphan-${i}`, 'extra'));
    const v = computeVerdict(
      baseReport({
        summary: { ok: 0, diff: 0, missing: 0, extra: 9 },
        kinds: { commands: [], skills: extras, hooks: [], rules: [], mcp: [], permissions: [], subagents: [], plugins: [], promptcuts: [] },
      }),
    );
    const out = healthBlockLines(v, { healthySummary: 'x' }).map(stripAnsi).join('\n');
    // 9 orphans, cap 5 → 4 hidden.
    expect(out).toContain('+4 more orphans — agents prune cleanup');
    // The heal footer is suppressed for an orphan-only verdict (prune, not --fix).
    expect(out).not.toContain("heal what's auto-fixable");
  });
});

describe('renderFleetDivergence (agents doctor --devices, RUSH-2027)', () => {
  it('names the missing resource and the box it is missing on', () => {
    const report = compareFleetInventories(
      [{ name: 'zion', inventory: inv(['swarm']) }, { name: 'yosemite-s0', inventory: inv([]) }],
      'zion',
    );
    const out = renderFleetDivergence(report).map(stripAnsi).join('\n');
    expect(out).toContain('Cross-device divergence');
    expect(out).toContain('yosemite-s0');
    expect(out).toContain("missing plugin 'swarm'");
    expect(out).toContain('agents apply'); // read-only remediation hint
  });

  it('renders an all-clear line and names uncompared boxes when the fleet agrees', () => {
    const report = compareFleetInventories(
      [
        { name: 'zion', inventory: inv(['swarm']) },
        { name: 'box', inventory: inv(['swarm']) },
        { name: 'offline', inventory: null },
      ],
      'zion',
    );
    const out = renderFleetDivergence(report).map(stripAnsi).join('\n');
    expect(out).toContain('Fleet is consistent');
    expect(out).toContain('not compared: offline');
  });
});
