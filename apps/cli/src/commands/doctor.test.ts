import { describe, it, expect } from 'vitest';
import { execPolicyWarningLines, renderFleetDivergence, wrapLine, computeVerdict } from './doctor.js';
import { stringWidth, stripAnsi } from '../lib/session/width.js';
import type { VersionResourceReport } from '../lib/doctor-diff.js';
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

describe('computeVerdict (doctor per-version health rollup)', () => {
  it('is healthy when nothing diverges', () => {
    const v = computeVerdict(baseReport());
    expect(v.healthy).toBe(true);
    expect(v.issues).toEqual([]);
  });

  it('an UNWIRED hook flips the verdict to unhealthy even when every file is ok', () => {
    // The yosemite-s1 bug: 32 hook files reconcile ok, but one is never wired
    // into settings.json. Files-ok must NOT read as healthy.
    const v = computeVerdict(
      baseReport({
        hookWiring: {
          supported: true,
          settingsPath: '/home/.claude/settings.json',
          expected: 32,
          unwired: [{ name: 'ask-user-question-guard', event: 'PreToolUse', matcher: 'AskUserQuestion', command: '~/x.sh' }],
        },
      }),
    );
    expect(v.healthy).toBe(false);
    expect(v.issues.map((i) => i.text)).toContain('1 unwired');
  });

  it('a missing settings.json is unhealthy and names the unwired count', () => {
    const v = computeVerdict(
      baseReport({
        hookWiring: { supported: true, settingsPath: '/home/.claude/settings.json', expected: 3, settingsMissing: true, unwired: [] },
      }),
    );
    expect(v.healthy).toBe(false);
    expect(v.issues.some((i) => i.text.includes('settings.json missing') && i.text.includes('3'))).toBe(true);
  });

  it('a source layer behind origin flips the verdict to unhealthy (not a buried note)', () => {
    const v = computeVerdict(
      baseReport({
        sourceBehind: [{ layer: 'user', label: '~/.agents', alias: 'user', behind: 75, branch: 'origin/main' }],
      }),
    );
    expect(v.healthy).toBe(false);
    expect(v.issues.some((i) => i.text.includes('75 commits behind origin/main'))).toBe(true);
  });

  it('still folds in classic divergences (diff / missing / extra)', () => {
    const v = computeVerdict(baseReport({ summary: { ok: 1, diff: 2, missing: 1, extra: 3 } }));
    expect(v.healthy).toBe(false);
    const texts = v.issues.map((i) => i.text);
    expect(texts).toEqual(expect.arrayContaining(['2 divergent', '1 missing', '3 extra']));
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
