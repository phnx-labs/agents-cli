import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from './broker';
import { runAdmittedJob, requestTemplate } from './execute';
import { ciLayout } from './paths';
import { CI_CACHE_HIT_BUDGET_MS, CI_P99_BUDGET_MS, RELEASE_P99_BUDGET_MS, eventToTerminalMs, summarize } from './timing';
import { initRepo } from './test-repo';

export interface BenchReport {
  n: number;
  p50: number;
  p99: number;
  p99_9: number;
  p99_99: number;
  max: number;
  budgets: {
    ciP99Ms: number;
    ciCacheHitMs: number;
    releaseP99Ms: number;
  };
  withinCiP99: boolean;
  withinCiP99_9: boolean;
  withinCiP99_99: boolean;
}

export function runExecutorBenchmark(jobCount = 64): BenchReport {
  const root = mkdtempSync(join(tmpdir(), 'ci-runner-bench-'));
  try {
    const { gitDir, commit, tree } = initRepo(root, 'bench-src');
    const layout = ciLayout(join(root, 'ci'));
    const broker = new Broker({ layout, capacity: { maxSlots: 8, maxPerRepo: 4 } });
    const samples: number[] = [];

    for (let i = 0; i < jobCount; i++) {
      const repo = i % 3 === 0 ? 'alpha' : i % 3 === 1 ? 'beta' : 'gamma';
      const submitted = broker.submit(requestTemplate({
        owner: 'phnx-labs',
        repo,
        checkRunId: `bench-${i}`,
        candidateCommitSha: commit,
        candidateTreeSha: tree,
      }));
      if (submitted.status !== 'admitted') {
        broker.drain();
      }
      const run = broker.read(submitted.runId);
      if (run.status !== 'admitted') {
        throw new Error(`benchmark job ${submitted.runId} never admitted`);
      }
      const result = runAdmittedJob({
        broker,
        runId: run.runId,
        sourceGitDir: gitDir,
        command: ['true'],
        controllerKey: 'bench-controller-key',
        lockfileDigest: 'ab'.repeat(16),
        cacheFiles: { 'install-stamp': 'warm' },
      });
      const elapsed = eventToTerminalMs(result.record.timings);
      if (elapsed == null) throw new Error('benchmark job missing terminal timing');
      samples.push(elapsed);
    }

    const stats = summarize(samples);
    return {
      ...stats,
      budgets: {
        ciP99Ms: CI_P99_BUDGET_MS,
        ciCacheHitMs: CI_CACHE_HIT_BUDGET_MS,
        releaseP99Ms: RELEASE_P99_BUDGET_MS,
      },
      withinCiP99: stats.p99 <= CI_P99_BUDGET_MS,
      withinCiP99_9: stats.p99_9 <= CI_P99_BUDGET_MS,
      withinCiP99_99: stats.p99_99 <= CI_P99_BUDGET_MS,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function writeBenchReport(report: BenchReport, dest: string): void {
  writeFileSync(dest, `${JSON.stringify(report, null, 2)}\n`);
}
