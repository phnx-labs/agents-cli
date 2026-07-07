import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the hosts cache under a temp HOME before state.js captures HOME at
// import time.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-hosttasks-'));
process.env.HOME = TEST_HOME;

const { saveTask, findTaskBySessionId } = await import('./tasks.js');
type HostTask = import('./tasks.js').HostTask;

function task(id: string, sessionId?: string): HostTask {
  return {
    id,
    host: 'box',
    target: 'user@box',
    agent: 'claude',
    prompt: 'p',
    sessionId,
    remoteLog: `/r/${id}.log`,
    remoteExit: `/r/${id}.exit`,
    status: 'running',
    createdAt: new Date(Date.now() + parseInt(id, 36)).toISOString(),
  };
}

describe('findTaskBySessionId', () => {
  it('maps a captured session id back to the host task that launched it', () => {
    saveTask(task('aa', 'sess-aaaa'));
    saveTask(task('bb', 'sess-bbbb'));
    const found = findTaskBySessionId('sess-bbbb');
    expect(found?.id).toBe('bb');
    expect(found?.host).toBe('box');
  });

  it('returns null for an unknown session id', () => {
    expect(findTaskBySessionId('sess-missing')).toBeNull();
  });

  it('returns null for an empty query and never matches tasks with no session id', () => {
    saveTask(task('cc')); // no sessionId
    expect(findTaskBySessionId('')).toBeNull();
  });
});
