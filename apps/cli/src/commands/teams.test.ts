import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildTeamRowsFromSnapshots, type TeamListAgentSnapshot } from './teams.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome: string;

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
});

function guardedHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-teams-home-'));
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  testHome = home;
  return home;
}

function seedTeam(home: string, teamName: string, agents: TeamListAgentSnapshot[]): void {
  const history = path.join(home, '.agents', '.history', 'teams');
  fs.mkdirSync(path.join(history, 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(history, 'registry.json'),
    JSON.stringify({ [teamName]: { created_at: '2026-08-01T12:00:00.000Z' } }, null, 2),
  );
  for (const agent of agents) {
    const agentDir = path.join(history, 'agents', agent.agent_id);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'meta.json'),
      JSON.stringify({
        agent_id: agent.agent_id,
        task_name: agent.task_name,
        agent_type: agent.agent_type,
        status: agent.status,
        prompt: agent.prompt,
        started_at: agent.started_at,
        completed_at: agent.completed_at,
        workspace_dir: agent.workspace_dir,
        version: agent.version,
        remote_session_id: agent.remote_session_id,
        name: agent.name,
        after: agent.after,
        task_type: agent.task_type,
        host_name: agent.host,
        mode: agent.mode,
        cloud_session_id: agent.cloud_session_id,
        cloud_provider: agent.cloud_provider,
        pr_url: agent.pr_url,
        remote_pid: 424242,
        remote_log: '$HOME/.agents/.cache/hosts/offline.log',
        remote_exit: '$HOME/.agents/.cache/hosts/offline.exit',
        host_target: '203.0.113.1',
      }, null, 2),
    );
  }
}

function remoteSnapshot(overrides: Partial<TeamListAgentSnapshot> = {}): TeamListAgentSnapshot {
  return {
    agent_id: 'agent-remote-1',
    task_name: 'remote-lag',
    agent_type: 'codex',
    status: 'running',
    prompt: 'Investigate the remote failure',
    started_at: '2026-08-01T12:01:00.000Z',
    completed_at: null,
    workspace_dir: '/work/remote-lag',
    version: '0.146.0',
    remote_session_id: 'session-remote-1',
    name: 'remote',
    after: [],
    task_type: 'bugfix',
    host: 'offline-box',
    mode: 'edit',
    cloud_session_id: null,
    cloud_provider: null,
    pr_url: null,
    ...overrides,
  };
}

function run(
  args: string[],
  setup?: (home: string) => void,
  timeout = 10_000,
): { stdout: string; stderr: string; status: number | null; error?: Error } {
  const home = guardedHome();
  setup?.(home);
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    timeout,
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_NO_USAGE_TRACK: '1',
      AGENTS_SKIP_MIGRATION: '1',
    },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status, error: r.error };
}

describe('teams list output modes', () => {
  it('keeps piped stdout human-readable unless --json is passed', () => {
    const { stdout, status } = run(['teams', 'list']);
    expect(status).toBe(0);
    expect(stdout).toContain("You haven't started any teams yet.");
    expect(() => JSON.parse(stdout)).toThrow();
  });

  it('emits JSON when --json is passed', () => {
    const { stdout, status } = run(['teams', 'list', '--json']);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ teams: [] });
  });

  it('builds list rows from cached teammate metadata', () => {
    const result = buildTeamRowsFromSnapshots(
      { 'remote-lag': { created_at: '2026-08-01T12:00:00.000Z', description: 'remote work' } },
      [remoteSnapshot()],
    );

    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]).toMatchObject({
      task_name: 'remote-lag',
      agent_count: 1,
      running: 1,
      workspace_dir: '/work/remote-lag',
    });
    expect(result.rows[0].agents[0]).toMatchObject({
      agent_id: 'agent-remote-1',
      agent_type: 'codex',
      host: 'offline-box',
      tool_count: 0,
      files_modified: [],
    });
  });

  it('does not probe unreachable remote teammates for JSON list output', () => {
    const { stdout, status, error } = run(
      ['teams', 'list', '--json'],
      (home) => seedTeam(home, 'remote-lag', [remoteSnapshot()]),
      2_500,
    );

    expect(error).toBeUndefined();
    expect(status).toBe(0);
    expect(JSON.parse(stdout).teams[0]).toMatchObject({
      task_name: 'remote-lag',
      agent_count: 1,
      running: 1,
    });
  });
});
