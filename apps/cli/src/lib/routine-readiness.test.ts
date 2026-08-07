import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import type { JobConfig } from './routines.js';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { buildRemoteWorkspaceProbe, evaluateActivationReadiness, parseRemoteProjectSnapshot, probeOutputHasSentinel } from './routine-readiness.js';

function job(over: Partial<JobConfig>): JobConfig {
  return {
    name: 'r', schedule: '0 3 * * *',
    mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'hi',
    ...over,
  } as JobConfig;
}

describe('evaluateActivationReadiness', () => {
  it('a command routine with no context is ready (home fallback)', () => {
    const r = evaluateActivationReadiness(job({ command: 'echo hi', prompt: '' }));
    expect(r.ready).toBe(true);
  });

  it('an agent routine with no project/cwd is blocked (execution_context_missing)', () => {
    const r = evaluateActivationReadiness(job({ agent: 'claude' }), { probeAgent: () => true });
    expect(r.ready).toBe(false);
    expect(r.readiness?.code).toBe('execution_context_missing');
  });

  it('an agent routine with a valid home cwd and an installed agent is ready', () => {
    const r = evaluateActivationReadiness(job({ agent: 'claude', cwd: '~' }), { probeAgent: () => true });
    expect(r.ready).toBe(true);
  });

  it('an agent routine whose agent is not installed is agent_unavailable', () => {
    const r = evaluateActivationReadiness(job({ agent: 'claude', cwd: '~' }), { probeAgent: () => false });
    expect(r.ready).toBe(false);
    expect(r.readiness?.code).toBe('agent_unavailable');
  });

  it('an agent routine pointing at a missing directory is blocked (cwd_missing)', () => {
    const missing = path.join(os.homedir(), 'definitely-not-here-routine-xyz-42');
    const r = evaluateActivationReadiness(job({ agent: 'claude', cwd: missing }), { probeAgent: () => true });
    expect(r.ready).toBe(false);
    expect(r.readiness?.code).toBe('cwd_missing');
  });
});

describe('remote routine readiness primitives', () => {
  it('parses the target HOME and project catalog, including spaces in paths', () => {
    expect(parseRemoteProjectSnapshot('__HOME__/home/worker\n[{"name":"crm","defaultPath":"/home/worker/CRM data"}]\n')).toEqual({
      home: '/home/worker',
      projects: [{ name: 'crm', defaultPath: '/home/worker/CRM data' }],
    });
  });

  it('rejects malformed or structurally invalid target project output', () => {
    expect(parseRemoteProjectSnapshot('__HOME__/home/worker\nnot json')).toBeUndefined();
    expect(parseRemoteProjectSnapshot('__HOME__/home/worker\n[{"root":"/tmp"}]')).toBeUndefined();
    expect(parseRemoteProjectSnapshot('[{"name":"crm"}]')).toBeUndefined();
  });

  it.runIf(process.platform !== 'win32')('performs a real POSIX create/delete probe in a quoted directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routine readiness '));
    try {
      execFileSync('bash', ['-c', buildRemoteWorkspaceProbe(root, false)]);
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  });

  it('requires the exact Codex postcondition in plain or JSON event output', () => {
    expect(probeOutputHasSentinel('ROUTINE_READY\n', 'ROUTINE_READY')).toBe(true);
    expect(probeOutputHasSentinel('{"type":"result","result":"ROUTINE_READY"}\n', 'ROUTINE_READY')).toBe(true);
    expect(probeOutputHasSentinel('{"result":"Could not emit ROUTINE_READY because auth failed"}\n', 'ROUTINE_READY')).toBe(false);
    expect(probeOutputHasSentinel('{malformed}\n', 'ROUTINE_READY')).toBe(false);
  });
});
