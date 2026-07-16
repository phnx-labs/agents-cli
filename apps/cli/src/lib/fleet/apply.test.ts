import { describe, it, expect } from 'vitest';
import { agentIdOf, diffFleet, canPushLogin, type SourceAuth } from './apply.js';
import type { DeviceDesired, DeviceProbe } from './types.js';

function srcAuth(available: string[], bound: string[] = []): SourceAuth {
  return { available: new Set(available), bound: new Set(bound), filesByAgent: new Map() };
}

const CLI = '1.20.64';

describe('agentIdOf', () => {
  it('strips the version suffix', () => {
    expect(agentIdOf('claude@latest')).toBe('claude');
    expect(agentIdOf('codex@1.2.3')).toBe('codex');
    expect(agentIdOf('gemini')).toBe('gemini');
  });
});

describe('canPushLogin', () => {
  it('pushes a propagatable, available, non-bound agent to a linux target', () => {
    expect(canPushLogin('codex', 'linux', srcAuth(['codex']))).toBe(true);
  });
  it('refuses an agent with no portable file', () => {
    expect(canPushLogin('cursor', 'linux', srcAuth(['cursor']))).toBe(false);
  });
  it('refuses when the source token is keychain-bound', () => {
    expect(canPushLogin('claude', 'linux', srcAuth([], ['claude']))).toBe(false);
  });
  it('refuses claude to a macOS target (consumes from its own keychain)', () => {
    expect(canPushLogin('claude', 'macos', srcAuth(['claude']))).toBe(false);
  });
  it('refuses when the source is not signed in', () => {
    expect(canPushLogin('grok', 'linux', srcAuth([]))).toBe(false);
  });
});

describe('diffFleet', () => {
  const desired: DeviceDesired[] = [
    { device: 's1', agents: ['claude@latest', 'codex@latest'], sync: ['user'], login: 'sync' },
  ];

  it('plans install-cli + add both agents + sync + push-login on a bare device', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: true, platform: 'linux', cliVersion: undefined, installedAgents: [] }],
    ]);
    const plan = diffFleet(desired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['claude', 'codex']) });
    const kinds = plan.actions.map((a) => a.kind);
    expect(kinds).toContain('install-cli');
    expect(kinds.filter((k) => k === 'add-agent')).toHaveLength(2);
    expect(kinds).toContain('sync-config');
    expect(kinds.filter((k) => k === 'push-login')).toHaveLength(2);
    expect(plan.devices[0].loginBlocked).toEqual([]);
  });

  it('is idempotent: nothing to install when cli + agents already present (login still pushes)', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: true, platform: 'linux', cliVersion: CLI, installedAgents: ['claude', 'codex'] }],
    ]);
    const plan = diffFleet(desired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['claude', 'codex']) });
    const kinds = plan.actions.map((a) => a.kind);
    expect(kinds).not.toContain('install-cli');
    expect(kinds).not.toContain('upgrade-cli');
    expect(kinds).not.toContain('add-agent');
    // sync + login are push operations, still present
    expect(kinds).toContain('sync-config');
    expect(kinds.filter((k) => k === 'push-login')).toHaveLength(2);
  });

  it('plans upgrade-cli on a version mismatch', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: true, platform: 'linux', cliVersion: '1.20.55', installedAgents: ['claude', 'codex'] }],
    ]);
    const plan = diffFleet(desired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['claude', 'codex']) });
    expect(plan.actions.map((a) => a.kind)).toContain('upgrade-cli');
  });

  it('surfaces a macOS keychain login as needs-login, not push', () => {
    const macDesired: DeviceDesired[] = [
      { device: 'mac', agents: ['claude@latest', 'codex@latest'], sync: [], login: 'sync' },
    ];
    const probes = new Map<string, DeviceProbe>([
      ['mac', { device: 'mac', reachable: true, platform: 'macos', cliVersion: CLI, installedAgents: ['claude', 'codex'] }],
    ]);
    const plan = diffFleet(macDesired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['claude', 'codex']) });
    const claudeActions = plan.actions.filter((a) => a.agent === 'claude');
    expect(claudeActions.some((a) => a.kind === 'needs-login')).toBe(true);
    expect(claudeActions.some((a) => a.kind === 'push-login')).toBe(false);
    // codex is portable on macOS -> still pushes
    expect(plan.actions.some((a) => a.agent === 'codex' && a.kind === 'push-login')).toBe(true);
    expect(plan.devices[0].loginBlocked).toContain('claude');
  });

  it('does not flag a non-propagatable agent as needs-login on a macOS target', () => {
    // Regression: the branch was `isPropagatableAgent(id) || platform === 'macos'`,
    // which flagged EVERY agent on a mac target — including ones (like cursor)
    // that have no portable credential and were never propagation candidates.
    const macDesired: DeviceDesired[] = [
      { device: 'mac', agents: ['cursor@latest'], sync: [], login: 'sync' },
    ];
    const probes = new Map<string, DeviceProbe>([
      ['mac', { device: 'mac', reachable: true, platform: 'macos', cliVersion: CLI, installedAgents: ['cursor'] }],
    ]);
    const plan = diffFleet(macDesired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['cursor']) });
    expect(plan.actions.some((a) => a.kind === 'needs-login')).toBe(false);
    expect(plan.devices[0].loginBlocked).toEqual([]);
  });

  it('does not flag a propagatable agent the source is not signed into (parity with linux)', () => {
    // grok is propagatable but the source has no grok login — nothing to push and
    // nothing to nag about; must stay silent on macOS just like on linux.
    const macDesired: DeviceDesired[] = [
      { device: 'mac', agents: ['grok@latest'], sync: [], login: 'sync' },
    ];
    const probes = new Map<string, DeviceProbe>([
      ['mac', { device: 'mac', reachable: true, platform: 'macos', cliVersion: CLI, installedAgents: ['grok'] }],
    ]);
    const plan = diffFleet(macDesired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth([]) });
    expect(plan.actions.some((a) => a.kind === 'needs-login')).toBe(false);
    expect(plan.devices[0].loginBlocked).toEqual([]);
  });

  it('flags a keychain-bound source token as needs-login on a linux target', () => {
    // claude bound on the source (unextractable) → can't push, must surface manual.
    const probes = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: true, platform: 'linux', cliVersion: CLI, installedAgents: ['claude', 'codex'] }],
    ]);
    const plan = diffFleet(desired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['codex'], ['claude']) });
    const claudeActions = plan.actions.filter((a) => a.agent === 'claude');
    expect(claudeActions.some((a) => a.kind === 'needs-login')).toBe(true);
    expect(plan.devices[0].loginBlocked).toContain('claude');
    // codex is portable and available → still pushes.
    expect(plan.actions.some((a) => a.agent === 'codex' && a.kind === 'push-login')).toBe(true);
  });

  it('produces no actions for an unreachable device', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: false, platform: 'linux', installedAgents: [], note: 'unreachable' }],
    ]);
    const plan = diffFleet(desired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['claude', 'codex']) });
    expect(plan.actions).toEqual([]);
    expect(plan.devices[0].probe.reachable).toBe(false);
  });

  it('skips login entirely when login mode is skip', () => {
    const skipDesired: DeviceDesired[] = [
      { device: 's1', agents: ['codex@latest'], sync: [], login: 'skip' },
    ];
    const probes = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: true, platform: 'linux', cliVersion: CLI, installedAgents: ['codex'] }],
    ]);
    const plan = diffFleet(skipDesired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['codex']) });
    expect(plan.actions.map((a) => a.kind)).not.toContain('push-login');
    expect(plan.actions).toEqual([]);
  });
});
