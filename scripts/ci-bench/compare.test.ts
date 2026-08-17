import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractAllPhaseTimes } from './phases';
import { compareProviders, classifyProvider, groupByProvider } from './providers';
import {
  evaluateCiTargets,
  evaluateReleaseTargets,
  windowsRequiredFromWorkflow,
} from './gates';
import { buildReport } from './report';
import type { BenchInput, BenchJob, PhaseTimes } from './types';

const fixtures = join(import.meta.dir, 'fixtures');

function load(name: string): BenchInput {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8')) as BenchInput;
}

function sampleTimes(n: number, e2eMs: number, provider: PhaseTimes['provider'] = 'github-hosted'): PhaseTimes[] {
  return Array.from({ length: n }, (_, i) => ({
    runId: i,
    kind: 'required-ci',
    provider,
    queueMs: 1_000,
    setupMs: 3_000,
    executionMs: 8_000,
    reportMs: 2_000,
    e2eMs,
    includedJobNames: ['impact', 'test'],
    excludedJobNames: [],
  }));
}

describe('classifyProvider', () => {
  test('maps ubuntu-latest / GitHub Actions to github-hosted', () => {
    const job: BenchJob = {
      name: 'impact',
      labels: ['ubuntu-latest'],
      runner_group_name: 'GitHub Actions',
      started_at: null,
      completed_at: null,
    };
    expect(classifyProvider(job)).toBe('github-hosted');
  });

  test('maps crabbox / self-hosted / phnx labels to crabbox', () => {
    expect(classifyProvider({
      name: 'impact',
      labels: ['self-hosted', 'crabbox', 'linux'],
      runner_name: 'crabbox-0',
      started_at: null,
      completed_at: null,
    })).toBe('crabbox');
  });

  test('maps windows-latest to windows', () => {
    expect(classifyProvider({
      name: 'windows',
      labels: ['windows-latest'],
      started_at: null,
      completed_at: null,
    })).toBe('windows');
  });
});

describe('provider comparison sample-count gates', () => {
  test('refuses a winner when either side is under the P99 gate', () => {
    const times = extractAllPhaseTimes(load('provider-compare.json').runs);
    const groups = groupByProvider(times);
    const cmp = compareProviders(
      groups.get('github-hosted') ?? [],
      groups.get('crabbox') ?? [],
      'github-hosted',
      'crabbox',
      'e2e',
      99,
    );
    expect(cmp.status).toBe('insufficient-sample');
    expect(cmp.deltaMs).toBeNull();
    expect(cmp.faster).toBeNull();
    expect(cmp.left.sample.n).toBe(1);
    expect(cmp.right.sample.n).toBe(1);
    expect(cmp.left.sample.required).toBe(100);
  });

  test('emits an exact P99 delta once both providers have 100 samples', () => {
    const github = sampleTimes(100, 80_000, 'github-hosted');
    const crabbox = sampleTimes(100, 20_000, 'crabbox');
    const cmp = compareProviders(github, crabbox, 'github-hosted', 'crabbox', 'e2e', 99);
    expect(cmp.status).toBe('ok');
    expect(cmp.left.sample.valueMs).toBe(80_000);
    expect(cmp.right.sample.valueMs).toBe(20_000);
    expect(cmp.deltaMs).toBe(60_000);
    expect(cmp.faster).toBe('crabbox');
  });
});

describe('CI / release target gates', () => {
  test('cannot claim P99.99 <= 90s on 200 required-CI samples', () => {
    const evals = evaluateCiTargets(Array.from({ length: 200 }, () => 12_000));
    const p9999 = evals.find((e) => e.p === 99.99)!;
    expect(p9999.pass).toBe(false);
    expect(p9999.sample.status).toBe('insufficient-sample');
    expect(p9999.reason).toContain('need 10000');
  });

  test('passes every CI tail when 10000 samples sit under 90s', () => {
    const evals = evaluateCiTargets(Array.from({ length: 10_000 }, (_, i) => 10_000 + (i % 50)));
    expect(evals.map((e) => ({ p: e.p, pass: e.pass, value: e.sample.valueMs }))).toEqual([
      { p: 99, pass: true, value: 10_049 },
      { p: 99.9, pass: true, value: 10_049 },
      { p: 99.99, pass: true, value: 10_049 },
    ]);
  });

  test('fails P99 when the observed required-CI tail exceeds 90s', () => {
    const values = Array.from({ length: 100 }, (_, i) => (i >= 98 ? 120_000 : 20_000));
    const p99 = evaluateCiTargets(values).find((e) => e.p === 99)!;
    expect(p99.sample.valueMs).toBe(120_000);
    expect(p99.pass).toBe(false);
    expect(p99.reason).toContain('exceeds 90000ms');
  });

  test('release tails gate at 180s, not 90s', () => {
    const values = Array.from({ length: 10_000 }, () => 150_000);
    const evals = evaluateReleaseTargets(values);
    expect(evals.every((e) => e.pass)).toBe(true);
    expect(evals[0].budgetMs).toBe(180_000);
  });
});

describe('windows-required workflow gate', () => {
  test('fails when the aggregator needs windows', () => {
    const src = readFileSync(join(fixtures, 'workflow-windows-required.yml'), 'utf8');
    const finding = windowsRequiredFromWorkflow(src);
    expect(finding.required).toBe(true);
    expect(finding.pass).toBe(false);
    expect(finding.evidence).toContain('windows');
  });

  test('passes when windows is only a post-merge smoke and not in needs', () => {
    const src = readFileSync(join(fixtures, 'workflow-windows-optional.yml'), 'utf8');
    const finding = windowsRequiredFromWorkflow(src);
    expect(finding.required).toBe(false);
    expect(finding.pass).toBe(true);
    expect(finding.evidence).not.toMatch(/needs: \[.*windows/);
  });
});

describe('buildReport', () => {
  test('does not pass a one-run fixture — tails are sample-gated', () => {
    const report = buildReport(load('required-ci-run.json'), readFileSync(join(fixtures, 'workflow-windows-required.yml'), 'utf8'));
    expect(report.requiredCi.n).toBe(1);
    expect(report.windows?.pass).toBe(false);
    expect(report.pass).toBe(false);
    const e2e = report.requiredCi.phases.find((p) => p.phase === 'e2e')!;
    expect(e2e.percentiles.find((s) => s.p === 50)?.status).toBe('insufficient-sample');
    expect(e2e.percentiles.find((s) => s.p === 99.99)?.status).toBe('insufficient-sample');
  });
});
