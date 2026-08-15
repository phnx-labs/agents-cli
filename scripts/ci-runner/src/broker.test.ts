import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from './broker';
import { requestTemplate } from './execute';
import { ciLayout } from './paths';

describe('Broker', () => {
  test('derives the worktree and never accepts a box lease', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-broker-'));
    try {
      const layout = ciLayout(join(root, 'ci'));
      const broker = new Broker({ layout, capacity: { maxSlots: 2, maxPerRepo: 1 } });
      const record = broker.submit(requestTemplate({
        owner: 'phnx-labs',
        repo: 'agi-cli',
        checkRunId: 'chk-1',
        candidateCommitSha: 'a'.repeat(40),
        candidateTreeSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      }));
      expect(record.status).toBe('admitted');
      expect(record.worktreePath).toBe(join(
        layout.runs,
        'phnx-labs',
        'agi-cli',
        'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        'chk-1',
        'worktree',
      ));
      expect(record.worktreePath).not.toContain('lease');
      expect(() => broker.submit({
        ...requestTemplate({
          owner: 'phnx-labs',
          repo: 'agi-cli',
          checkRunId: 'chk-lease',
          candidateCommitSha: 'a'.repeat(40),
          candidateTreeSha: 'e'.repeat(40),
        }),
        leaseId: 'warm-box-3',
      })).toThrow(/must not carry a lease/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('queues past the per-repo cap and admits the other repo when a slot frees', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-broker-'));
    try {
      const layout = ciLayout(join(root, 'ci'));
      const broker = new Broker({ layout, capacity: { maxSlots: 2, maxPerRepo: 1 } });
      const a1 = broker.submit(requestTemplate({
        owner: 'phnx-labs', repo: 'alpha', checkRunId: 'a1',
        candidateCommitSha: 'a'.repeat(40), candidateTreeSha: 'a'.repeat(40),
      }));
      const a2 = broker.submit(requestTemplate({
        owner: 'phnx-labs', repo: 'alpha', checkRunId: 'a2',
        candidateCommitSha: 'a'.repeat(40), candidateTreeSha: 'a'.repeat(40),
      }));
      const b1 = broker.submit(requestTemplate({
        owner: 'phnx-labs', repo: 'beta', checkRunId: 'b1',
        candidateCommitSha: 'a'.repeat(40), candidateTreeSha: 'a'.repeat(40),
      }));
      expect(a1.status).toBe('admitted');
      expect(a2.status).toBe('queued');
      expect(b1.status).toBe('admitted');

      broker.complete('a1', 'succeeded');
      expect(broker.read('a2').status).toBe('admitted');

      const other = new Broker({ layout, capacity: { maxSlots: 2, maxPerRepo: 1 } });
      const a3 = other.submit(requestTemplate({
        owner: 'phnx-labs', repo: 'alpha', checkRunId: 'a3',
        candidateCommitSha: 'a'.repeat(40), candidateTreeSha: 'a'.repeat(40),
      }));
      expect(a3.status).toBe('queued');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
