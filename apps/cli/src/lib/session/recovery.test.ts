import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { RotateCandidate } from '../rotate.js';
import type { SessionMeta } from './types.js';
import {
  SessionRecoveryError,
  inspectNativeResumeSession,
  resolveSessionRecoveryFromCandidates,
  sessionOriginDevice,
  sessionRecoveryDestinationMatches,
  sessionRecoveryPeer,
  sessionRecoveryRunArgs,
} from './recovery.js';

function session(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: '14567b8a-db63-4e27-9867-4846813157cc',
    shortId: '14567b8a',
    agent: 'claude',
    version: '2.1.187',
    machine: 'yosemite-s0',
    timestamp: '2026-08-05T15:00:00.000Z',
    filePath: '/retained/transcript.jsonl',
    ...over,
  };
}

function candidate(version: string, over: Partial<RotateCandidate> = {}): RotateCandidate {
  return {
    agent: 'claude',
    version,
    accountKey: `claude:${version}`,
    accountLabel: version,
    email: `${version}@example.test`,
    usageKey: `claude:${version}`,
    usageStatus: null,
    usageSnapshot: null,
    usageError: null,
    usageMinutesToLimit: null,
    plan: null,
    signedIn: true,
    authVerdict: null,
    lastActive: null,
    ...over,
  };
}

describe('resolveSessionRecoveryFromCandidates', () => {
  it('native-resumes only the healthy origin version', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-native-'));
    try {
      const home = path.join(root, 'home');
      const cwd = path.join(root, 'original-project');
      const laterCwd = path.join(root, 'later-project');
      const filePath = path.join(home, '.claude', 'projects', '-original-project', `${session().id}.jsonl`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.mkdirSync(cwd);
      fs.mkdirSync(laterCwd);
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: 'attachment', cwd }),
        JSON.stringify({ type: 'user', cwd: laterCwd }),
      ].join('\n') + '\n');
      const source = session({ filePath, cwd: laterCwd });
      const inspection = inspectNativeResumeSession(source, home);
      const result = resolveSessionRecoveryFromCandidates(
        source,
        [candidate('2.1.187'), candidate('2.1.218')],
        () => true,
        inspection,
      );
      expect(result).toMatchObject({ mode: 'native', agent: 'claude', version: '2.1.187', cwd });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses /continue on a healthy same-harness version when the origin is signed out', () => {
    const result = resolveSessionRecoveryFromCandidates(
      session(),
      [candidate('2.1.187', { signedIn: false }), candidate('2.1.218')],
      () => true,
    );
    expect(result).toMatchObject({ mode: 'continue', agent: 'claude', version: '2.1.218' });
    expect(result.reason).toContain('signed_out');
  });

  it('keeps a healthy origin home for /continue when the harness has no native resume form', () => {
    const result = resolveSessionRecoveryFromCandidates(
      session(),
      [candidate('2.1.187'), candidate('2.1.218')],
      () => false,
    );
    expect(result).toMatchObject({ mode: 'continue', agent: 'claude', version: '2.1.187' });
  });

  it('never native-resumes from a different isolated version home', () => {
    const result = resolveSessionRecoveryFromCandidates(
      session(),
      [candidate('2.1.218')],
      () => true,
    );
    expect(result.mode).toBe('continue');
    expect(result.version).toBe('2.1.218');
    expect(result.reason).toContain('2.1.187 is not installed');
  });

  it('uses /continue when a same-number reinstall does not own the retained transcript', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recovery-trash-'));
    try {
      const home = path.join(root, 'active-home');
      const retained = path.join(root, 'trash', `${session().id}.jsonl`);
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(path.dirname(retained), { recursive: true });
      fs.writeFileSync(retained, '{}\n');
      const source = session({ filePath: retained });
      const result = resolveSessionRecoveryFromCandidates(
        source,
        [candidate('2.1.187')],
        () => true,
        inspectNativeResumeSession(source, home),
      );
      expect(result).toMatchObject({ mode: 'continue', agent: 'claude', version: '2.1.187' });
      expect(result.reason).toContain('retained outside the active claude@2.1.187 home');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails with the concrete device, origin version, and account reason', () => {
    expect(() => resolveSessionRecoveryFromCandidates(
      session(),
      [candidate('2.1.187', { usageStatus: 'rate_limited' })],
      () => true,
    )).toThrowError(SessionRecoveryError);
    expect(() => resolveSessionRecoveryFromCandidates(
      session(),
      [candidate('2.1.187', { usageStatus: 'rate_limited' })],
      () => true,
    )).toThrow(/yosemite-s0.*claude@2\.1\.187.*rate_limited/);
  });
});

describe('sessionRecoveryRunArgs', () => {
  it('routes focus, resume, and attach through run auto --resume', () => {
    expect(sessionRecoveryRunArgs(session())).toEqual([
      'run', 'auto', '--resume', '14567b8a-db63-4e27-9867-4846813157cc', '--interactive',
    ]);
  });
});

describe('session recovery placement', () => {
  it('normalizes the indexed origin device', () => {
    expect(sessionOriginDevice(session({ machine: 'YOSEMITE-S0.tail.ts.net' }), 'zion')).toBe('yosemite-s0');
    expect(sessionOriginDevice(session({ machine: undefined }), 'ZION.local')).toBe('zion');
  });

  it('returns a peer only when recovery is not already on the origin', () => {
    expect(sessionRecoveryPeer(session(), (host) => host === 'yosemite-s0')).toBeUndefined();
    expect(sessionRecoveryPeer(session(), () => false)).toBe('yosemite-s0');
  });

  it('matches explicit user@host placement only to the origin', () => {
    expect(sessionRecoveryDestinationMatches(session(), 'muqsit@yosemite-s0', 'zion')).toBe(true);
    expect(sessionRecoveryDestinationMatches(session(), 'zion', 'zion')).toBe(false);
  });
});
