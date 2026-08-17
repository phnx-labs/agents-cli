import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const hookPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook.sh');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SessionStart hook launch metadata', () => {
  it.each(['codex', 'kimi', 'droid'])('atomically joins the effective run mode to a %s session id', (agent) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-hook-'));
    dirs.push(root);
    const home = path.join(root, 'home');
    const history = path.join(root, 'history');
    fs.mkdirSync(home);

    const result = spawnSync(hookPath, [agent], {
      input: JSON.stringify({ session_id: '019fd0c8-b3e9-77a2-a1a4-444698c4d897', cwd: '/repo' }),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        AGENTS_HISTORY_DIR: history,
        AGENTS_RUN_MODE: 'edit',
        AGENTS_ACTOR: 'muqsit',
        AGENTS_ACTOR_KIND: 'human',
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(history, 'by-session', '019fd0c8-b3e9-77a2-a1a4-444698c4d897.json'), 'utf8'))).toMatchObject({
      sessionId: '019fd0c8-b3e9-77a2-a1a4-444698c4d897',
      mode: 'edit',
      actor: 'muqsit',
      initiatedBy: 'human',
    });
  });

  it('joins the tmux wrapper alias to a harness-native session id without losing mode metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-hook-'));
    dirs.push(root);
    const home = path.join(root, 'home');
    const history = path.join(root, 'history');
    const sessionId = '019fd114-4689-7df1-963f-ce06e5a36aeb';
    fs.mkdirSync(home);
    const result = spawnSync(hookPath, ['codex'], {
      input: JSON.stringify({ session_id: sessionId, cwd: '/repo' }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, AGENTS_HISTORY_DIR: history, AGENTS_RUN_MODE: 'edit', AGENT_TMUX_SESSION_NAME: 'ag-codex-c1f3d813' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(history, 'by-session', `${sessionId}.json`), 'utf8'))).toMatchObject({
      sessionId,
      mode: 'edit',
      aliases: ['ag-codex-c1f3d813'],
    });
  });

  it('rejects a traversal session id before creating a temporary sidecar', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-hook-'));
    dirs.push(root);
    const home = path.join(root, 'home');
    const history = path.join(root, 'history');
    fs.mkdirSync(home);

    const result = spawnSync(hookPath, ['codex'], {
      input: JSON.stringify({ session_id: '../escaped', cwd: '/repo' }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, AGENTS_HISTORY_DIR: history, AGENTS_RUN_MODE: 'edit' },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(history, 'escaped.json'))).toBe(false);
    expect(fs.existsSync(path.join(history, 'by-session'))).toBe(false);
  });
});


describe('SessionStart hook state-dir hygiene', () => {
  it('writes the live session file and prunes dead records in the same run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-hygiene-'));
    dirs.push(root);
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const stateDir = path.join(home, '.agents', '.cache', 'terminals', 'sessions');
    fs.mkdirSync(stateDir, { recursive: true });

    // Create a genuinely dead pid to seed stale files with.
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(dead.status).toBe(0);
    const deadPid = dead.pid!;

    // Pre-seed stale files that the hook should reap.
    fs.writeFileSync(path.join(stateDir, `${deadPid}.json`), JSON.stringify({ session_id: 'x', cwd: '/', pid: deadPid, ts: 1 }), 'utf8');
    fs.writeFileSync(path.join(stateDir, '999999.json'), '', 'utf8');
    fs.writeFileSync(path.join(stateDir, `.${deadPid}.abcdef`), 'orphan', 'utf8');

    const result = spawnSync(hookPath, ['codex'], {
      input: JSON.stringify({ session_id: '019fd0c8-b3e9-77a2-a1a4-444698c4d897', cwd: '/repo' }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });

    expect(result.status, result.stderr).toBe(0);
    const remaining = new Set(fs.readdirSync(stateDir));
    // The hook runs as a child of this process, so it records THIS pid.
    expect(remaining.has(`${process.pid}.json`)).toBe(true);
    // Stale entries are gone.
    expect(remaining.has(`${deadPid}.json`)).toBe(false);
    expect(remaining.has('999999.json')).toBe(false);
    expect([...remaining].some((f) => /^\.\d+\./.test(f))).toBe(false);
  });
});
