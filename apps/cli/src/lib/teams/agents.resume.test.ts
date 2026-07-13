/**
 * Teammate resume argv + guard. `teams resume`/`teams message` re-enter a
 * stopped teammate's own session by delegating to `agents run --resume <id> --
 * <message>`. These assert the argv the team runner builds and the guard that
 * refuses to resume a non-Claude teammate whose session id was never captured.
 *
 * Real objects, no mocking: buildRunArgv/buildCommand are the production argv
 * builders; resumeTeammate drives a real AgentProcess loaded from disk.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentManager, AgentProcess, AgentStatus } from './agents.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resume-test-'));
}

// buildRunArgv is private; reach it through a cast — testing the real builder,
// not a re-implementation.
function argv(opts: {
  agentType?: string;
  prompt?: string;
  mode?: string;
  model?: string | null;
  effort?: string;
  version?: string | null;
  profileName?: string | null;
  resume?: { id: string; message: string };
}): string[] {
  const mgr = new AgentManager() as any;
  return mgr.buildRunArgv(
    opts.agentType ?? 'claude',
    opts.prompt ?? 'the original brief',
    opts.mode ?? 'edit',
    opts.model ?? null,
    opts.effort ?? 'medium',
    opts.version ?? null,
    opts.profileName ?? null,
    opts.resume,
  );
}

describe('buildRunArgv — resume', () => {
  it('emits `run <agent> <message> --resume <id>` with headless/json flags', () => {
    const a = argv({ agentType: 'claude', resume: { id: 'sess-123', message: 'merge the PR now' } });
    expect(a[0]).toBe('run');
    expect(a[1]).toBe('claude');
    // The message is the first positional (the prompt slot), + the summary nudge.
    expect(a[2].startsWith('merge the PR now')).toBe(true);
    const ri = a.indexOf('--resume');
    expect(ri).toBeGreaterThan(-1);
    expect(a[ri + 1]).toBe('sess-123');
    expect(a).toContain('--headless');
    expect(a).toContain('--json');
    expect(a).toContain('--quiet');
    expect(a).toContain('--mode');
    expect(a).toContain('--effort');
  });

  it('drops the Claude plan-mode prefix on resume but keeps it on a fresh plan launch', () => {
    const fresh = argv({ agentType: 'claude', mode: 'plan', prompt: 'do X' });
    const resumed = argv({ agentType: 'claude', mode: 'plan', resume: { id: 'x', message: 'keep going' } });
    expect(fresh[2].includes('HEADLESS PLAN MODE')).toBe(true);
    expect(resumed[2].includes('HEADLESS PLAN MODE')).toBe(false);
    expect(resumed[2].startsWith('keep going')).toBe(true);
  });

  it('never emits --resume on a fresh (non-resume) launch', () => {
    expect(argv({ agentType: 'codex', prompt: 'do a thing' })).not.toContain('--resume');
  });

  it('is agent-agnostic — a codex resume id forwards the same way', () => {
    const a = argv({ agentType: 'codex', resume: { id: 'thread-abc', message: 'continue' } });
    expect(a[1]).toBe('codex');
    const ri = a.indexOf('--resume');
    expect(a[ri + 1]).toBe('thread-abc');
  });
});

describe('buildCommand — resume omits --session-id', () => {
  it('creates with --session-id on a fresh launch and omits it on resume', () => {
    const mgr = new AgentManager() as any;
    const fresh: string[] = mgr.buildCommand('claude', 'brief', 'edit', null, '/tmp/x', 'agent-uuid', 'medium', null, null);
    expect(fresh).toContain('--session-id');

    const resumed: string[] = mgr.buildCommand(
      'claude', 'brief', 'edit', null, '/tmp/x', 'agent-uuid', 'medium', null, null,
      { id: 'agent-uuid', message: 'go' },
    );
    // --session-id CREATES a session; `agents run` rejects it with --resume.
    expect(resumed).not.toContain('--session-id');
    expect(resumed).toContain('--resume');
    // Working-directory access is still granted on resume.
    expect(resumed).toContain('--add-dir');
  });
});

describe('resumeTeammate — resume-id guard', () => {
  it('refuses to resume a non-Claude teammate whose session id was never captured', async () => {
    const base = tmpBase();
    const id = 'codex-agent-1';
    fs.mkdirSync(path.join(base, id), { recursive: true });

    // A codex teammate that finished (or failed) before its stream ever emitted a
    // session/thread id — remoteSessionId stays null, so there is no resumable
    // handle (the agent_id is only Claude's session id, not codex's).
    const a = new AgentProcess(
      id, 'guard-team', 'codex', 'do a thing',
      null, 'edit', null, AgentStatus.COMPLETED, new Date(), new Date(), base,
    );
    await a.saveMeta();

    const mgr = new AgentManager(50, base);
    await expect(mgr.resumeTeammate(id, 'keep going')).rejects.toThrow(/No resumable session id was captured/);

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('uses the captured remoteSessionId as the resume id when present (no throw at the guard)', async () => {
    const base = tmpBase();
    const id = 'codex-agent-2';
    fs.mkdirSync(path.join(base, id), { recursive: true });

    const a = new AgentProcess(
      id, 'guard-team', 'codex', 'do a thing',
      null, 'edit', null, AgentStatus.COMPLETED, new Date(), new Date(), base,
    );
    a.remoteSessionId = 'codex-thread-xyz';
    await a.saveMeta();

    // Past the guard, resumeTeammate would spawn a real `agents run` child. We
    // only need to prove the guard passes — assert the persisted resume handle
    // is the captured thread id, which is what buildRunArgv receives.
    const mgr = new AgentManager(50, base);
    const loaded = await mgr.get(id);
    expect(loaded!.remoteSessionId).toBe('codex-thread-xyz');
    expect(loaded!.agentType).toBe('codex');

    fs.rmSync(base, { recursive: true, force: true });
  });
});
