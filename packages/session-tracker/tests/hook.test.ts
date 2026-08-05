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
  it('atomically joins the effective run mode to the harness session id', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-hook-'));
    dirs.push(root);
    const home = path.join(root, 'home');
    const history = path.join(root, 'history');
    fs.mkdirSync(home);

    const result = spawnSync(hookPath, ['codex'], {
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
});
