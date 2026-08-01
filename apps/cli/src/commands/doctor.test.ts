import { describe, it, expect } from 'vitest';
import { execPolicyWarningLines, renderFleetDivergence, wrapLine } from './doctor.js';
import { stringWidth, stripAnsi } from '../lib/session/width.js';
import { compareFleetInventories, FLEET_RESOURCE_KINDS, type FleetInventory, type FleetResourceKind } from '../lib/devices/fleet-divergence.js';

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
