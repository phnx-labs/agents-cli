import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './cli';
import type { BenchInput, BenchJob, BenchRun } from './types';

function job(name: string, start: string, end: string, labels = ['ubuntu-latest']): BenchJob {
  return {
    name,
    labels,
    runner_group_name: labels.includes('crabbox') ? 'phnx-untrusted' : 'GitHub Actions',
    started_at: start,
    completed_at: end,
    conclusion: 'success',
    steps: [
      { name: 'Set up job', started_at: start, completed_at: start },
      { name: 'Run selected tests', started_at: start, completed_at: end },
    ],
  };
}

function runAt(id: number, created: string, done: string, labels: string[], kind: BenchRun['kind'] = 'required-ci'): BenchRun {
  const start = new Date(Date.parse(created) + 1_000).toISOString().replace('.000Z', 'Z');
  return {
    id,
    name: kind === 'release' ? 'Release' : 'Tests',
    kind,
    created_at: created,
    conclusion: 'success',
    jobs: [
      job('impact', start, done, labels),
      {
        name: 'test',
        labels,
        runner_group_name: 'GitHub Actions',
        started_at: done,
        completed_at: done,
        conclusion: 'success',
        steps: [{ name: 'Gate every affected component', started_at: done, completed_at: done }],
      },
    ],
  };
}

describe('cli', () => {
  test('exits 2 when tails lack samples or windows is still required', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-bench-'));
    const input = join(dir, 'runs.json');
    writeFileSync(input, JSON.stringify({
      runs: [runAt(1, '2026-08-15T00:00:00Z', '2026-08-15T00:00:20Z', ['ubuntu-latest'])],
    } satisfies BenchInput));
    const workflow = join(import.meta.dir, 'fixtures/workflow-windows-required.yml');
    expect(main(['--input', input, '--workflow', workflow])).toBe(2);
  });

  test('exits 0 when CI and release tails clear their budgets and windows is optional', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-bench-'));
    const runs: BenchRun[] = [];
    for (let i = 0; i < 10_000; i++) {
      const created = new Date(Date.UTC(2026, 7, 1, 0, 0, 0) + i * 1000).toISOString().replace('.000Z', 'Z');
      const done = new Date(Date.parse(created) + 12_000).toISOString().replace('.000Z', 'Z');
      const labels = i < 5_000 ? ['ubuntu-latest'] : ['self-hosted', 'crabbox'];
      runs.push(runAt(i, created, done, labels, 'required-ci'));
    }
    for (let i = 0; i < 10_000; i++) {
      const created = new Date(Date.UTC(2026, 7, 2, 0, 0, 0) + i * 1000).toISOString().replace('.000Z', 'Z');
      const done = new Date(Date.parse(created) + 40_000).toISOString().replace('.000Z', 'Z');
      runs.push(runAt(100_000 + i, created, done, ['ubuntu-latest'], 'release'));
    }
    const input = join(dir, 'runs.json');
    writeFileSync(input, JSON.stringify({ runs } satisfies BenchInput));
    const workflow = join(import.meta.dir, 'fixtures/workflow-windows-optional.yml');
    expect(main(['--input', input, '--workflow', workflow, '--json'])).toBe(0);
  });

  test('prints usage and exits 0 on --help', () => {
    expect(main(['--help'])).toBe(0);
  });
});
