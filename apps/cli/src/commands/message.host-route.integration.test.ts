/**
 * `agents message <name>` resolving a detached `agents run --device <host>
 * --no-follow` dispatch (RUSH-2366 follow-up), end to end through the real
 * command.
 *
 * `decideHostTaskRoute` is unit-tested in `lib/mailbox-target.test.ts`, but the
 * WIRING in `commands/message.ts` was not covered — and the wiring is where the
 * bug lived twice over: first the command never consulted the host-task records
 * at all, then it consulted them WITHOUT the `reconcileRunningTasks` heal that
 * `hosts stop`/`hosts ps` both run first.
 *
 * Real CLI, real on-disk records under a throwaway HOME, no mocking. The cases
 * here are deliberately the ones that need no reachable host: a record that is
 * already terminal must be reported as finished from local state, and an
 * unknown name must fall through to the generic "no target" error. The live-SSH
 * heal itself is covered by `lib/hosts/reconcile`'s own tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function resolveBin(name: string): string | null {
  try {
    const out = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
    return out && path.isAbsolute(out) ? out : null;
  } catch {
    return null;
  }
}

const BUN = process.platform === 'win32' ? null : resolveBin('bun');

describe.skipIf(process.platform === 'win32' || !BUN)(
  'agents message routing to a detached --device dispatch (RUSH-2366)',
  () => {
    let home: string;
    const entry = path.resolve(process.cwd(), 'src/index.ts');

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'message-host-route-'));
      const systemDir = path.join(home, '.agents', '.system');
      fs.mkdirSync(systemDir, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });
    });

    afterEach(() => {
      fs.rmSync(home, { recursive: true, force: true });
    });

    /** Write the same `<id>.json` record `agents hosts ps` reads. */
    function writeTask(task: Record<string, unknown>): void {
      const dir = path.join(home, '.agents', '.cache', 'hosts');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${task.id}.json`), JSON.stringify(task, null, 2));
    }

    function runMessage(target: string): { status: number; out: string } {
      const result = spawnSync(BUN!, [entry, 'message', target, 'ping'], {
        env: { ...process.env, HOME: home, AGENTS_NO_NUDGE: '1', FORCE_COLOR: '0' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: result.status ?? 1, out: `${result.stdout}${result.stderr}` };
    }

    it('a finished dispatch is reported from local state — no SSH, and never a silent success', () => {
      writeTask({
        id: 'task-done-1',
        host: 'somebox',
        target: 'somebox',
        agent: 'claude',
        prompt: 'do a thing',
        name: 'donerun',
        remoteLog: '/home/x/.agents/.cache/hosts/task-done-1.log',
        remoteExit: '/home/x/.agents/.cache/hosts/task-done-1.exit',
        status: 'completed',
        exitCode: 0,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const res = runMessage('donerun');

      // Fails loud, names the host and the status, and points at the log —
      // rather than the generic "no running agent matches" this used to give.
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("Task 'donerun' on host 'somebox' already completed");
      expect(res.out).toContain('agents hosts logs donerun');
    }, 60_000);

    it('an unknown target still fails loud with both listing commands', () => {
      const res = runMessage('nothing-by-this-name');
      expect(res.status).not.toBe(0);
      expect(res.out).toContain('No running agent or cloud task matches');
      expect(res.out).toContain('agents hosts ps');
    }, 60_000);
  },
);
