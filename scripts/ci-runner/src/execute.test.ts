import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAttestation } from './attestation';
import { Broker } from './broker';
import { janitorCompletedRuns, requestTemplate, runAdmittedJob } from './execute';
import { FirecrackerPool } from './firecracker';
import { ciLayout } from './paths';
import { initRepo } from './test-repo';

const KEY = 'controller-signing-key-not-for-workers';

describe('runAdmittedJob', () => {
  test('runs in a one-use jail, signs the attestation on the controller, and tears the vm down', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-exec-'));
    try {
      const src = initRepo(root, 'src');
      const layout = ciLayout(join(root, 'ci'));
      const broker = new Broker({ layout });
      const submitted = broker.submit(requestTemplate({
        owner: 'phnx-labs',
        repo: 'agi-cli',
        checkRunId: 'exec-1',
        candidateCommitSha: src.commit,
        candidateTreeSha: src.tree,
      }));
      const result = runAdmittedJob({
        broker,
        runId: submitted.runId,
        sourceGitDir: src.gitDir,
        command: ['/bin/sh', '-c', 'echo ran-in-jail; test -z "$GITHUB_TOKEN"; test -z "$AGENTS_CONTROLLER_KEY"'],
        controllerKey: KEY,
        lockfileDigest: 'aa'.repeat(16),
        cacheFiles: { stamp: 'warm' },
      });
      expect(result.record.status).toBe('succeeded');
      expect(result.record.exitCode).toBe(0);
      expect(readFileSync(join(result.record.resultPath, 'stdout.log'), 'utf8')).toContain('ran-in-jail');
      const attestation = JSON.parse(readFileSync(result.attestationPath, 'utf8'));
      verifyAttestation(attestation, KEY);
      expect(attestation.candidateTreeSha).toBe(src.tree);
      expect(new FirecrackerPool(layout).exists('vm-exec-1')).toBe(false);
      expect(existsSync(result.record.worktreePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails loud when the worker tries to write the attestation', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-exec-'));
    try {
      const src = initRepo(root, 'src');
      const layout = ciLayout(join(root, 'ci'));
      const broker = new Broker({ layout });
      const submitted = broker.submit(requestTemplate({
        owner: 'phnx-labs',
        repo: 'agi-cli',
        checkRunId: 'exec-evil',
        candidateCommitSha: src.commit,
        candidateTreeSha: src.tree,
      }));
      expect(() => runAdmittedJob({
        broker,
        runId: submitted.runId,
        sourceGitDir: src.gitDir,
        command: ['/bin/sh', '-c', 'echo stolen > attestation.json'],
        controllerKey: KEY,
      })).toThrow(/worker wrote an attestation/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('janitor removes finished runs and leaves an admitted one', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-exec-'));
    try {
      const src = initRepo(root, 'src');
      const layout = ciLayout(join(root, 'ci'));
      const broker = new Broker({ layout, capacity: { maxSlots: 2, maxPerRepo: 2 } });
      const done = broker.submit(requestTemplate({
        owner: 'phnx-labs', repo: 'agi-cli', checkRunId: 'done-1',
        candidateCommitSha: src.commit, candidateTreeSha: src.tree,
      }));
      runAdmittedJob({
        broker,
        runId: done.runId,
        sourceGitDir: src.gitDir,
        command: ['true'],
        controllerKey: KEY,
      });
      const live = broker.submit(requestTemplate({
        owner: 'phnx-labs', repo: 'agi-cli', checkRunId: 'live-1',
        candidateCommitSha: src.commit, candidateTreeSha: src.tree,
      }));
      expect(live.status).toBe('admitted');
      const removed = janitorCompletedRuns(broker, 0, Date.now() + 1);
      expect(removed).toContain('done-1');
      expect(removed).not.toContain('live-1');
      expect(broker.tryRead('live-1')?.status).toBe('admitted');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
