import { describe, it, expect } from 'vitest';
import {
  agentIdOf,
  diffFleet,
  canPushLogin,
  pinnedVersion,
  rosterNeedsVersions,
  expandAllSpecs,
  parseInstalledVersions,
  type SourceAuth,
} from './apply.js';
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

  it('excludes droid (single-use rotating refresh token) from propagation and surfaces per-machine login', () => {
    const droidDesired: DeviceDesired[] = [
      { device: 's1', agents: ['droid@latest', 'codex@latest'], sync: [], login: 'sync' },
    ];
    const probes = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: true, platform: 'linux', cliVersion: CLI, installedAgents: ['droid', 'codex'] }],
    ]);
    // Pretend the source has droid credentials available — the propagation gate
    // must still refuse to push them.
    const plan = diffFleet(droidDesired, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['droid', 'codex']) });
    const droidActions = plan.actions.filter((a) => a.agent === 'droid');
    expect(droidActions.some((a) => a.kind === 'push-login')).toBe(false);
    expect(droidActions.some((a) => a.kind === 'needs-login')).toBe(true);
    expect(droidActions.find((a) => a.kind === 'needs-login')?.detail).toMatch(/single-use rotating refresh token/);
    expect(plan.devices[0].loginBlocked).toContain('droid');
    // codex is still portable and safe → pushes.
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

describe('diffFleet — secrets surfacing', () => {
  const desired: DeviceDesired[] = [
    { device: 's1', agents: ['codex@latest'], sync: ['user'], login: 'skip' },
  ];
  const converged = new Map<string, DeviceProbe>([
    ['s1', { device: 's1', reachable: true, platform: 'linux', cliVersion: CLI, installedAgents: ['codex'] }],
  ]);

  it('surfaces declared bundles as needs-secret (not executable), one per bundle', () => {
    const plan = diffFleet(desired, converged, {
      targetCliVersion: CLI,
      sourceAuth: srcAuth(['codex']),
      secretsBundles: ['attio', 'ssh-keys'],
    });
    const secretActs = plan.actions.filter((a) => a.kind === 'needs-secret');
    expect(secretActs).toHaveLength(2);
    expect(plan.devices[0].secretsNeeded).toEqual(['attio', 'ssh-keys']);
    // sync-config still fires (scopes declared) but there is nothing executable
    // beyond it — needs-secret must be excluded from the "actions to run" count.
    const executable = plan.actions.filter((a) => a.kind !== 'needs-login' && a.kind !== 'needs-secret');
    expect(executable.map((a) => a.kind)).toEqual(['sync-config']);
  });

  it('emits nothing for secrets when the profile declares no bundles', () => {
    const plan = diffFleet(desired, converged, { targetCliVersion: CLI, sourceAuth: srcAuth(['codex']) });
    expect(plan.actions.filter((a) => a.kind === 'needs-secret')).toEqual([]);
    expect(plan.devices[0].secretsNeeded).toEqual([]);
  });

  it('does not surface secrets on an unreachable device', () => {
    const offline = new Map<string, DeviceProbe>([
      ['s1', { device: 's1', reachable: false, installedAgents: [] }],
    ]);
    const plan = diffFleet(desired, offline, {
      targetCliVersion: CLI,
      sourceAuth: srcAuth(['codex']),
      secretsBundles: ['attio'],
    });
    expect(plan.devices[0].secretsNeeded).toEqual([]);
  });
});

describe('pinnedVersion', () => {
  it('returns the explicit version', () => {
    expect(pinnedVersion('claude@2.1.170')).toBe('2.1.170');
  });
  it('returns undefined for id-level / label specs', () => {
    expect(pinnedVersion('claude')).toBeUndefined();
    expect(pinnedVersion('claude@latest')).toBeUndefined();
    expect(pinnedVersion('claude@oldest')).toBeUndefined();
    expect(pinnedVersion('claude@all')).toBeUndefined();
  });
});

describe('rosterNeedsVersions', () => {
  it('is true when any device pins a version', () => {
    expect(rosterNeedsVersions([
      { device: 's0', agents: ['claude@latest'], sync: [], login: 'skip' },
      { device: 's1', agents: ['claude@2.1.170'], sync: [], login: 'skip' },
    ])).toBe(true);
  });
  it('is false for a purely id-level roster', () => {
    expect(rosterNeedsVersions([
      { device: 's0', agents: ['claude', 'codex@latest'], sync: [], login: 'skip' },
    ])).toBe(false);
  });
});

describe('expandAllSpecs', () => {
  const versionsOf = (id: string) => (id === 'claude' ? ['2.1.170', '2.1.207'] : []);
  it('expands @all into one pinned spec per source version', () => {
    expect(expandAllSpecs(['claude@all'], versionsOf)).toEqual(['claude@2.1.170', 'claude@2.1.207']);
  });
  it('passes non-@all specs through and de-dups', () => {
    expect(expandAllSpecs(['claude@all', 'claude@2.1.207', 'codex@latest'], versionsOf))
      .toEqual(['claude@2.1.170', 'claude@2.1.207', 'codex@latest']);
  });
  it('throws when @all names an agent with no installed versions', () => {
    expect(() => expandAllSpecs(['codex@all'], versionsOf)).toThrow(/no codex versions installed/);
  });
});

describe('parseInstalledVersions', () => {
  it('maps agent id -> versions from the view --json array', () => {
    const json = JSON.stringify([
      { agent: 'claude', versions: [{ version: '2.1.170' }, { version: '2.1.207' }], profiles: [] },
      { agent: 'codex', versions: [{ version: '0.146.0' }], profiles: [] },
    ]);
    expect(parseInstalledVersions(json)).toEqual({ claude: ['2.1.170', '2.1.207'], codex: ['0.146.0'] });
  });
  it('returns undefined on malformed output', () => {
    expect(parseInstalledVersions('not json')).toBeUndefined();
    expect(parseInstalledVersions('{"not":"an array"}')).toBeUndefined();
  });
});

describe('diffFleet — version-aware add-agent', () => {
  const twoVersions: DeviceDesired[] = [
    { device: 's0', agents: ['claude@2.1.170', 'claude@2.1.207'], sync: [], login: 'skip' },
  ];

  it('installs only the missing version when one is already present', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s0', {
        device: 's0', reachable: true, platform: 'linux', cliVersion: CLI,
        installedAgents: ['claude'], installedVersions: { claude: ['2.1.207'] },
      }],
    ]);
    const plan = diffFleet(twoVersions, probes, { targetCliVersion: CLI, sourceAuth: srcAuth([]) });
    const adds = plan.actions.filter((a) => a.kind === 'add-agent');
    expect(adds).toHaveLength(1);
    expect(adds[0].spec).toBe('claude@2.1.170');
    expect(adds[0].detail).toBe('install claude@2.1.170');
  });

  it('installs every version when the agent id is present but no versions match', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s0', {
        device: 's0', reachable: true, platform: 'linux', cliVersion: CLI,
        installedAgents: ['claude'], installedVersions: { claude: ['2.1.100'] },
      }],
    ]);
    const plan = diffFleet(twoVersions, probes, { targetCliVersion: CLI, sourceAuth: srcAuth([]) });
    expect(plan.actions.filter((a) => a.kind === 'add-agent').map((a) => a.spec))
      .toEqual(['claude@2.1.170', 'claude@2.1.207']);
  });

  it('nothing to add when both versions are already installed', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s0', {
        device: 's0', reachable: true, platform: 'linux', cliVersion: CLI,
        installedAgents: ['claude'], installedVersions: { claude: ['2.1.170', '2.1.207'] },
      }],
    ]);
    const plan = diffFleet(twoVersions, probes, { targetCliVersion: CLI, sourceAuth: srcAuth([]) });
    expect(plan.actions.filter((a) => a.kind === 'add-agent')).toHaveLength(0);
  });

  it('a version-pinned spec installs when the probe has no version info (fallback)', () => {
    const probes = new Map<string, DeviceProbe>([
      ['s0', { device: 's0', reachable: true, platform: 'linux', cliVersion: CLI, installedAgents: ['claude'] }],
    ]);
    const plan = diffFleet(twoVersions, probes, { targetCliVersion: CLI, sourceAuth: srcAuth([]) });
    expect(plan.actions.filter((a) => a.kind === 'add-agent')).toHaveLength(2);
  });

  it('propagates login once per id even when @all names claude many times', () => {
    const roster: DeviceDesired[] = [
      { device: 's0', agents: ['claude@2.1.170', 'claude@2.1.207'], sync: [], login: 'sync' },
    ];
    const probes = new Map<string, DeviceProbe>([
      ['s0', {
        device: 's0', reachable: true, platform: 'linux', cliVersion: CLI,
        installedAgents: ['claude'], installedVersions: { claude: ['2.1.170', '2.1.207'] },
      }],
    ]);
    const plan = diffFleet(roster, probes, { targetCliVersion: CLI, sourceAuth: srcAuth(['claude']) });
    expect(plan.actions.filter((a) => a.kind === 'push-login')).toHaveLength(1);
  });
});
