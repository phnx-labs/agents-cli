import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { sshExec } from '../ssh-exec.js';
import {
  buildRunForwardedArgs,
  buildInteractiveRunForwardedArgs,
  remoteCdPrefix,
  terminateDispatchedTask,
} from './dispatch.js';
import type { HostTask } from './tasks.js';

const LOCAL_HOME = process.env.HOME ?? os.homedir();

describe('buildRunForwardedArgs', () => {
  it('forwards --session-id for a fresh run so the remote session gets our id', () => {
    const args = buildRunForwardedArgs({ agent: 'claude', prompt: 'do a thing', sessionId: 'abc-123' });
    expect(args).toEqual(['run', 'claude', 'do a thing', '--quiet', '--session-id', 'abc-123']);
  });

  it('forwards --resume (not --session-id) when resuming, so no new session is created', () => {
    const args = buildRunForwardedArgs({ agent: 'claude', prompt: 'keep going', resume: 'abc-123' });
    expect(args).toEqual(['run', 'claude', 'keep going', '--quiet', '--resume', 'abc-123']);
  });

  it('resume wins when both are set — they are mutually exclusive on the CLI', () => {
    const args = buildRunForwardedArgs({ agent: 'claude', prompt: 'p', sessionId: 'new-id', resume: 'old-id' });
    expect(args).toContain('--resume');
    expect(args).toContain('old-id');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('new-id');
  });

  it('omits session flags entirely for agents with no captured id', () => {
    const args = buildRunForwardedArgs({ agent: 'codex', prompt: 'p' });
    expect(args).toEqual(['run', 'codex', 'p', '--quiet']);
  });

  it('threads mode and model through ahead of the session flag', () => {
    const args = buildRunForwardedArgs({
      agent: 'claude',
      prompt: 'p',
      mode: 'plan',
      model: 'opus',
      sessionId: 'id-1',
    });
    expect(args).toEqual(['run', 'claude', 'p', '--quiet', '--mode', 'plan', '--model', 'opus', '--session-id', 'id-1']);
  });
});

describe('buildInteractiveRunForwardedArgs', () => {
  it('omits prompt and --quiet so the remote agent starts interactively', () => {
    const args = buildInteractiveRunForwardedArgs({ agent: 'claude' });
    expect(args).toEqual(['run', 'claude']);
  });

  it('forwards --session-id for a fresh interactive run', () => {
    const args = buildInteractiveRunForwardedArgs({ agent: 'claude', sessionId: 'abc-123' });
    expect(args).toEqual(['run', 'claude', '--session-id', 'abc-123']);
  });

  it('forwards --resume (not --session-id) when resuming interactively', () => {
    const args = buildInteractiveRunForwardedArgs({ agent: 'claude', resume: 'abc-123' });
    expect(args).toEqual(['run', 'claude', '--resume', 'abc-123']);
  });

  it('threads mode, model, and name through', () => {
    const args = buildInteractiveRunForwardedArgs({
      agent: 'claude',
      mode: 'plan',
      model: 'opus',
      name: 'my-run',
    });
    expect(args).toEqual(['run', 'claude', '--mode', 'plan', '--model', 'opus', '--name', 'my-run']);
  });

  it('forwards --raw and passthrough args', () => {
    const args = buildInteractiveRunForwardedArgs({
      agent: 'claude',
      raw: true,
      passthroughArgs: ['--verbose', '--some-flag'],
    });
    expect(args).toEqual(['run', 'claude', '--raw', '--', '--verbose', '--some-flag']);
  });

  it('omits empty passthrough args', () => {
    const args = buildInteractiveRunForwardedArgs({ agent: 'claude', passthroughArgs: [] });
    expect(args).toEqual(['run', 'claude']);
  });

  it('forwards a prompt only when interactive mode is forced, plus --interactive flag', () => {
    const args = buildInteractiveRunForwardedArgs({
      agent: 'claude',
      prompt: 'do a thing',
      forceInteractive: true,
    });
    expect(args).toEqual(['run', 'claude', 'do a thing', '--interactive']);
  });

  it('drops the prompt when interactive mode is not forced', () => {
    const args = buildInteractiveRunForwardedArgs({ agent: 'claude', prompt: 'do a thing' });
    expect(args).toEqual(['run', 'claude']);
  });
});

describe('remoteCdPrefix', () => {
  it('returns no prefix when no cwd is given', () => {
    expect(remoteCdPrefix(undefined)).toBe('');
    expect(remoteCdPrefix('')).toBe('');
  });

  it('re-roots a `~/…` path at the REMOTE home via unquoted "$HOME"', () => {
    // The whole point: local `~` mustn't leak the local home to the remote.
    expect(remoteCdPrefix('~/src/github.com/muqsitnawaz/agents-cli')).toBe(
      'cd "$HOME"/src/github.com/muqsitnawaz/agents-cli && ',
    );
  });

  it('re-roots a `$HOME/…` path the same way', () => {
    expect(remoteCdPrefix('$HOME/src/x')).toBe('cd "$HOME"/src/x && ');
  });

  it('does NOT re-root a raw local-home absolute — only ~/$HOME anchor here (exec.ts makes --cwd portable)', () => {
    const p = `${LOCAL_HOME}/src/x`;
    expect(remoteCdPrefix(p)).toBe(`cd ${p} && `);
  });

  it('maps bare ~ / $HOME to "$HOME"', () => {
    expect(remoteCdPrefix('~')).toBe('cd "$HOME" && ');
    expect(remoteCdPrefix('$HOME')).toBe('cd "$HOME" && ');
  });

  it('quotes a non-home absolute path verbatim (used as-is on the host)', () => {
    expect(remoteCdPrefix('/opt/work')).toBe("cd /opt/work && ");
    expect(remoteCdPrefix('/data/a b')).toBe("cd '/data/a b' && ");
  });

  it('shell-quotes a home remainder containing spaces', () => {
    expect(remoteCdPrefix('~/my projects/repo')).toBe(`cd "$HOME"/'my projects/repo' && `);
  });
});

const remoteTarget = process.env.AGENTS_TEST_REMOTE_TARGET;

describe.skipIf(!remoteTarget)('terminateDispatchedTask — real remote process', () => {
  it('terminates a launched remote process before returning', () => {
    const id = randomUUID().slice(0, 8);
    const marker = `agents-dispatch-rollback-${id}`;
    const remoteLog = `/tmp/${marker}.log`;
    const remoteExit = `/tmp/${marker}.exit`;
    const launch = sshExec(
      remoteTarget!,
      `nohup bash -lc 'exec -a ${marker} sleep 30' >${remoteLog} 2>&1 & echo $!`,
      { timeoutMs: 10000, multiplex: true },
    );
    expect(launch.code).toBe(0);
    const pid = Number.parseInt(launch.stdout.trim().split('\n').pop() ?? '', 10);
    expect(Number.isFinite(pid)).toBe(true);

    const task: HostTask = {
      id,
      host: remoteTarget!,
      target: remoteTarget!,
      agent: 'test',
      prompt: marker,
      pid,
      remoteLog,
      remoteExit,
      status: 'running',
      createdAt: new Date().toISOString(),
    };

    try {
      terminateDispatchedTask(task);
      const probe = sshExec(
        remoteTarget!,
        `kill -0 ${pid} 2>/dev/null && echo ALIVE || echo DEAD`,
        { timeoutMs: 10000, multiplex: true },
      );
      expect(probe.stdout.trim()).toBe('DEAD');
    } finally {
      sshExec(
        remoteTarget!,
        `kill -KILL ${pid} 2>/dev/null || true; rm -f ${remoteLog} ${remoteExit}`,
        { timeoutMs: 10000, multiplex: true },
      );
    }
  });
});
