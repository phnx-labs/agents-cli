import { describe, it, expect } from 'bun:test';
import {
  mapInventoriesToInstalledAgents,
  deriveHostLoad,
  buildDispatchHosts,
  rankTargets,
  rankHostUses,
  parseRemoteCpuRatio,
  buildManagedTargets,
} from './dispatchRanking';
import type { ManagedProject } from './managedProjects';
import { RemoteSession, HostInfo } from './remoteSessions';
import { AgentInventory, AgentInventoryVersion } from './agentInventory';

// --- fixtures ---------------------------------------------------------------

function version(overrides: Partial<AgentInventoryVersion> = {}): AgentInventoryVersion {
  return {
    version: '1.0.0',
    isDefault: true,
    signedIn: true,
    email: 'me@example.com',
    plan: 'pro',
    usageStatus: 'available',
    sessionUsedPercent: 0,
    lastActive: null,
    path: '/opt/agents/x',
    ...overrides,
  };
}

function inventory(overrides: Partial<AgentInventory> = {}): AgentInventory {
  const versions = overrides.versions ?? [version()];
  return {
    agent: 'claude',
    strategy: 'pinned',
    defaultVersion: versions[0]?.version ?? null,
    defaultAccount: null,
    defaultPlan: null,
    signedInCount: versions.filter((v) => v.signedIn).length,
    healthyCount: versions.filter((v) => v.signedIn).length,
    canRotate: false,
    ...overrides,
    versions,
  };
}

function session(overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    host: 'this-mac',
    sessionId: 's1',
    agentType: 'claude',
    cwd: '/Users/me/src/swarmify',
    project: 'swarmify',
    phase: 'running',
    activity: '',
    tokPerSec: 0,
    waitingForInput: false,
    lastResponse: '',
    prUrl: null,
    ticket: null,
    branch: '',
    sinceMs: 0,
    startedAtMs: 0,
    topic: '',
    sessionFile: '',
    context: 'terminal',
    ...overrides,
  };
}

// --- mapInventoriesToInstalledAgents ---------------------------------------

describe('mapInventoriesToInstalledAgents', () => {
  it('maps installed agents with brand name/color and default flag', () => {
    const agents = mapInventoriesToInstalledAgents(
      {
        claude: inventory({ agent: 'claude', defaultVersion: '2.1.181', versions: [version({ version: '2.1.181' })] }),
        codex: inventory({ agent: 'codex', defaultVersion: '0.134.0', versions: [version({ version: '0.134.0' })] }),
      },
      'claude',
    );
    const claude = agents.find((a) => a.id === 'claude')!;
    expect(claude.name).toBe('Claude');
    expect(claude.color).toBe('#d97757');
    expect(claude.version).toBe('2.1.181');
    expect(claude.signedIn).toBe(true);
    expect(claude.isDefault).toBe(true);
    const codex = agents.find((a) => a.id === 'codex')!;
    expect(codex.isDefault).toBe(false);
    expect(codex.color).toBe('#cfcfcf');
  });

  it('skips agents with no installed versions', () => {
    const agents = mapInventoriesToInstalledAgents(
      { opencode: inventory({ agent: 'opencode', versions: [] }) },
      'claude',
    );
    expect(agents).toHaveLength(0);
  });

  it('reports signedIn false when no version is signed in', () => {
    const agents = mapInventoriesToInstalledAgents(
      { gemini: inventory({ agent: 'gemini', signedInCount: 0, versions: [version({ signedIn: false })] }) },
      'claude',
    );
    expect(agents[0].signedIn).toBe(false);
  });

  it('falls back to id + neutral color for an unknown agent', () => {
    const agents = mapInventoriesToInstalledAgents(
      { mystery: inventory({ agent: 'mystery' }) },
      'claude',
    );
    expect(agents[0].name).toBe('mystery');
    expect(agents[0].color).toBe('#9aa0a6');
  });
});

// --- deriveHostLoad ---------------------------------------------------------

describe('deriveHostLoad', () => {
  it('is idle with no agents and quiet cpu', () => {
    expect(deriveHostLoad(0, 0.1)).toBe('idle');
    expect(deriveHostLoad(0, null)).toBe('idle');
  });
  it('is free with one agent or light cpu', () => {
    expect(deriveHostLoad(1, 0.1)).toBe('free');
    expect(deriveHostLoad(0, 0.3)).toBe('free');
  });
  it('is busy with a couple agents or loaded cpu', () => {
    expect(deriveHostLoad(2, 0.1)).toBe('busy');
    expect(deriveHostLoad(1, 0.7)).toBe('busy');
  });
  it('is hot when cpu is saturated or many agents', () => {
    expect(deriveHostLoad(1, 1.2)).toBe('hot');
    expect(deriveHostLoad(4, null)).toBe('hot');
  });
  it('derives from agent count alone when cpu ratio is unknown', () => {
    expect(deriveHostLoad(2, null)).toBe('busy');
    expect(deriveHostLoad(1, null)).toBe('free');
  });
});

// --- buildDispatchHosts -----------------------------------------------------

describe('buildDispatchHosts', () => {
  function host(overrides: Partial<HostInfo>): HostInfo {
    return { name: 'h', online: true, agents: 0, load: 'idle', uses: 0, ...overrides };
  }

  it('puts local first, remotes by descending usage, then cloud', () => {
    const hosts = buildDispatchHosts(
      [
        host({ name: 'yosemite-s1', uses: 2, agents: 2, load: 'busy' }),
        host({ name: 'this-mac', uses: 5, agents: 1, load: 'free' }),
        host({ name: 'yosemite-s0', uses: 9, agents: 3, load: 'busy' }),
      ],
      'this-mac',
    );
    expect(hosts.map((h) => h.id)).toEqual([
      'this-mac',
      'yosemite-s0',
      'yosemite-s1',
      'rush',
      'codex',
    ]);
    expect(hosts[0].kind).toBe('local');
    expect(hosts[1].kind).toBe('remote');
    const rush = hosts.find((h) => h.id === 'rush')!;
    expect(rush.kind).toBe('cloud');
    expect(rush.costHint).toBe('~$0.40/run');
  });

  it('carries live load fields through from the roster', () => {
    const hosts = buildDispatchHosts([host({ name: 'this-mac', agents: 3, load: 'busy', uses: 3 })], 'this-mac');
    expect(hosts[0].agents).toBe(3);
    expect(hosts[0].load).toBe('busy');
  });
});

// --- rankTargets ------------------------------------------------------------

describe('rankTargets', () => {
  it('counts sessions per project and sorts by usage', () => {
    const targets = rankTargets([
      session({ project: 'swarmify', sessionId: 'a' }),
      session({ project: 'swarmify', sessionId: 'b' }),
      session({ project: 'prix-api', sessionId: 'c', cwd: '/Users/me/src/prix/api' }),
    ]);
    expect(targets.map((t) => t.id)).toEqual(['swarmify', 'prix-api']);
    expect(targets[0].uses).toBe(2);
    expect(targets[1].path).toBe('/Users/me/src/prix/api');
  });

  it('prefers a non-worktree cwd as the canonical project path', () => {
    const targets = rankTargets([
      session({ project: 'swarmify', sessionId: 'a', cwd: '/Users/me/src/swarmify/.agents/worktrees/foo' }),
      session({ project: 'swarmify', sessionId: 'b', cwd: '/Users/me/src/swarmify' }),
    ]);
    expect(targets[0].path).toBe('/Users/me/src/swarmify');
  });

  it('skips sessions with no project or cwd', () => {
    const targets = rankTargets([
      session({ project: '', cwd: '' }),
      session({ project: 'swarmify', cwd: '/x' }),
    ]);
    expect(targets).toHaveLength(1);
  });

  it('breaks usage ties alphabetically for stable output', () => {
    const targets = rankTargets([
      session({ project: 'zeta', sessionId: 'a', cwd: '/z' }),
      session({ project: 'alpha', sessionId: 'b', cwd: '/a' }),
    ]);
    expect(targets.map((t) => t.id)).toEqual(['alpha', 'zeta']);
  });
});

// --- rankHostUses -----------------------------------------------------------

describe('rankHostUses', () => {
  it('counts active sessions per host', () => {
    const uses = rankHostUses([
      session({ host: 'this-mac', sessionId: 'a' }),
      session({ host: 'this-mac', sessionId: 'b' }),
      session({ host: 'zion', sessionId: 'c' }),
    ]);
    expect(uses).toEqual({ 'this-mac': 2, zion: 1 });
  });
});

// --- parseRemoteCpuRatio ----------------------------------------------------

describe('parseRemoteCpuRatio', () => {
  it('parses a Linux uptime + nproc output', () => {
    const out = ' 14:23:01 up 10 days,  3:21,  2 users,  load average: 2.00, 1.10, 0.98\n4\n';
    expect(parseRemoteCpuRatio(out)).toBeCloseTo(0.5, 5);
  });

  it('parses a macOS uptime (space-separated averages) output', () => {
    const out = '14:23  up 5 days,  2:11, 3 users, load averages: 4.00 3.35 2.40\n8\n';
    expect(parseRemoteCpuRatio(out)).toBeCloseTo(0.5, 5);
  });

  it('returns null when the core count is missing', () => {
    expect(parseRemoteCpuRatio('load average: 1.00, 0.5, 0.3\n')).toBeNull();
  });

  it('returns null when the load line is missing', () => {
    expect(parseRemoteCpuRatio('8\n')).toBeNull();
  });
});

describe('buildManagedTargets', () => {
  function mp(overrides: Partial<ManagedProject> = {}): ManagedProject {
    return {
      id: 'x',
      name: 'x',
      path: '/x',
      confidence: 'low',
      source: 'manual',
      ...overrides,
    };
  }

  it('orders by confidence, then active uses, then name — from the curated list, not sessions', () => {
    const managed = [
      mp({ id: 'lo', name: 'zeta', confidence: 'low' }),
      mp({ id: 'hi', name: 'agents-cli', confidence: 'high', linearProjectName: 'Agents CLI' }),
      mp({ id: 'md', name: 'prix', confidence: 'medium' }),
    ];
    const out = buildManagedTargets(managed, []);
    expect(out.map((t) => t.id)).toEqual(['hi', 'md', 'lo']);
    // high-confidence one carries the Linear pill name
    expect(out[0].linearProject).toBe('Agents CLI');
    // present even with zero active sessions
    expect(out[0].uses).toBe(0);
  });

  it('breaks confidence ties by active-session uses', () => {
    const managed = [
      mp({ id: 'a', name: 'alpha', confidence: 'high' }),
      mp({ id: 'b', name: 'beta', confidence: 'high' }),
    ];
    const sessions = [
      session({ project: 'beta', cwd: '/beta' }),
      session({ project: 'beta', cwd: '/beta' }),
      session({ project: 'alpha', cwd: '/alpha' }),
    ];
    const out = buildManagedTargets(managed, sessions);
    expect(out.map((t) => t.id)).toEqual(['b', 'a']); // beta has more uses
    expect(out[0].uses).toBe(2);
  });
});
