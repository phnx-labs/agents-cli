import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { shellQuote, sshExec } from '../ssh-exec.js';
import {
  buildDetachedLaunchCommand,
  buildRunForwardedArgs,
  buildInteractiveRunForwardedArgs,
  buildStopRemoteCommand,
  remoteCdPrefix,
  terminateDispatchedTask,
} from './dispatch.js';
import type { HostTask } from './tasks.js';

const LOCAL_HOME = process.env.HOME ?? os.homedir();

describe('buildStopRemoteCommand', () => {
  const exit = '$HOME/.agents/.cache/hosts/abc12345.exit';

  it('rejects non-positive pids before any remote shell is built', () => {
    expect(() => buildStopRemoteCommand(0, exit)).toThrow(/Invalid remote task pid/);
    expect(() => buildStopRemoteCommand(-1, exit)).toThrow(/Invalid remote task pid/);
    expect(() => buildStopRemoteCommand(1.5, exit)).toThrow(/Invalid remote task pid/);
  });

  it('writes 143 only after signaling a live group; keeps the log path untouched', () => {
    const cmd = buildStopRemoteCommand(4242, exit);
    // Live group: TERM then write 143 and report SIGNALED.
    expect(cmd).toContain('kill -TERM -- -4242');
    expect(cmd).toContain(`echo 143 > ${exit}`);
    expect(cmd).toContain('echo SIGNALED');
    // Already-dead group with a real exit code: adopt it, never overwrite.
    expect(cmd).toContain('echo "ALREADY $code"');
    expect(cmd).toContain(`cat ${exit}`);
    // Never deletes the log (contrast terminateRemoteLaunch's rm -f).
    expect(cmd).not.toMatch(/rm\s+-f/);
    expect(cmd).not.toContain('.log');
  });

  it('when the group is gone with no .exit, still writes 143 (GONE) without requiring kill success', () => {
    const cmd = buildStopRemoteCommand(99, exit);
    expect(cmd).toContain('echo GONE');
    // GONE branch is under the final else (group dead).
    expect(cmd).toMatch(/else[\s\S]*echo GONE/);
  });
});

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

  it('forwards an explicit version pin as agent@version', () => {
    const args = buildRunForwardedArgs({ agent: 'claude', prompt: 'p', version: '2.1.207' });
    expect(args).toEqual(['run', 'claude@2.1.207', 'p', '--quiet']);
  });

  it('forwards an explicit strategy', () => {
    const args = buildRunForwardedArgs({ agent: 'claude', prompt: 'p', strategy: 'balanced' });
    expect(args).toEqual(['run', 'claude', 'p', '--quiet', '--strategy', 'balanced']);
  });

  it('forwards version and strategy together before session flags', () => {
    const args = buildRunForwardedArgs({
      agent: 'claude',
      prompt: 'p',
      version: '2.1.207',
      strategy: 'balanced',
      sessionId: 'id-1',
    });
    expect(args).toEqual([
      'run', 'claude@2.1.207', 'p', '--quiet',
      '--strategy', 'balanced', '--session-id', 'id-1',
    ]);
  });

  it('forwards common behavioral flags', () => {
    const args = buildRunForwardedArgs({
      agent: 'claude',
      prompt: 'p',
      effort: 'high',
      addDir: ['~/notes', '/shared'],
      json: true,
      verbose: true,
      timeout: '30m',
      yes: true,
      acp: true,
    });
    expect(args).toEqual([
      'run', 'claude', 'p', '--quiet',
      '--effort', 'high',
      '--add-dir', '~/notes',
      '--add-dir', '/shared',
      '--timeout', '30m',
      '--json',
      '--verbose',
      '--yes',
      '--acp',
    ]);
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

  it('forwards version and strategy interactively', () => {
    const args = buildInteractiveRunForwardedArgs({
      agent: 'claude',
      version: '2.1.207',
      strategy: 'balanced',
    });
    expect(args).toEqual(['run', 'claude@2.1.207', '--strategy', 'balanced']);
  });

  it('forwards common behavioral flags interactively', () => {
    const args = buildInteractiveRunForwardedArgs({
      agent: 'claude',
      effort: 'max',
      addDir: ['~/notes'],
      json: true,
      verbose: true,
      timeout: '1h',
      yes: true,
      acp: true,
    });
    expect(args).toEqual([
      'run', 'claude',
      '--effort', 'max',
      '--add-dir', '~/notes',
      '--timeout', '1h',
      '--json',
      '--verbose',
      '--yes',
      '--acp',
    ]);
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
    expect(remoteCdPrefix(p)).toBe(`cd ${shellQuote(p)} && `);
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
  it('terminates the production wrapper and a TERM-resistant child before returning', () => {
    const id = randomUUID().slice(0, 8);
    const marker = `agents-dispatch-rollback-${id}`;
    const remoteLog = `/tmp/${marker}.log`;
    const remoteExit = `/tmp/${marker}.exit`;
    const childPidPath = `/tmp/${marker}.child-pid`;
    const childCommand = `echo $$ > ${childPidPath}; trap '' TERM; exec -a ${marker}-child sleep 30`;
    const inner =
      `trap 'exit 0' TERM; ` +
      `bash -lc ${shellQuote(childCommand)} > ${remoteLog} 2>&1; ` +
      `echo $? > ${remoteExit}`;
    const launch = sshExec(
      remoteTarget!,
      `rm -f ${remoteLog} ${remoteExit} ${childPidPath}; ${buildDetachedLaunchCommand(inner)}`,
      { timeoutMs: 10000, multiplex: true },
    );
    expect(launch.code).toBe(0);
    const pid = Number.parseInt(launch.stdout.trim().split('\n').pop() ?? '', 10);
    expect(Number.isFinite(pid)).toBe(true);

    const identity = sshExec(
      remoteTarget!,
      `for i in 1 2 3 4 5 6 7 8 9 10; do ` +
        `child=$(cat ${childPidPath} 2>/dev/null || true); ` +
        `if test -n "$child"; then ` +
          `pgid=$(ps -o pgid= -p ${pid} | tr -d ' '); ` +
          `printf '%s %s\n' "$child" "$pgid"; exit 0; ` +
        `fi; sleep 0.1; ` +
      `done; exit 1`,
      { timeoutMs: 10000, multiplex: true },
    );
    expect(identity.code).toBe(0);
    const [childPidText, groupIdText] = identity.stdout.trim().split(/\s+/);
    const childPid = Number.parseInt(childPidText ?? '', 10);
    expect(Number.isFinite(childPid)).toBe(true);
    expect(Number.parseInt(groupIdText ?? '', 10)).toBe(pid);

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
        `for process in ${pid} ${childPid}; do ` +
          `if kill -0 "$process" 2>/dev/null; then echo "ALIVE:$process"; exit 1; fi; ` +
        `done; echo DEAD`,
        { timeoutMs: 10000, multiplex: true },
      );
      expect(probe.code).toBe(0);
      expect(probe.stdout.trim()).toBe('DEAD');
    } finally {
      sshExec(
        remoteTarget!,
        `kill -KILL -- -${pid} 2>/dev/null || true; ` +
          `kill -KILL ${pid} ${childPid} 2>/dev/null || true; ` +
          `rm -f ${remoteLog} ${remoteExit} ${childPidPath}`,
        { timeoutMs: 10000, multiplex: true },
      );
    }
  });
});
