import { describe, expect, it } from 'vitest';
import type { JobConfig, RunMeta } from '../routines.js';
import {
  matchJobsToWebhook,
  jobMatchesWebhook,
  webhookRepo,
  webhookBranches,
  fireWebhookJobs,
  type GithubWebhook,
} from './webhook.js';

/** Build a JobConfig with sensible defaults for tests. */
function job(partial: Partial<JobConfig> & Pick<JobConfig, 'name'>): JobConfig {
  return {
    agent: 'claude',
    mode: 'plan',
    effort: 'auto',
    timeout: '10m',
    enabled: true,
    prompt: 'do the thing',
    ...partial,
  } as JobConfig;
}

/** A realistic `pull_request` webhook for repo x/y targeting branch main. */
function pullRequestWebhook(repoFullName: string, baseRef = 'main', headRef = 'feature'): GithubWebhook {
  return {
    event: 'pull_request',
    payload: {
      action: 'opened',
      repository: { full_name: repoFullName },
      pull_request: { base: { ref: baseRef }, head: { ref: headRef } },
    },
  };
}

/** A `push` webhook for repo x/y on branch main. */
function pushWebhook(repoFullName: string, ref = 'refs/heads/main'): GithubWebhook {
  return {
    event: 'push',
    payload: { repository: { full_name: repoFullName }, ref },
  };
}

describe('matchJobsToWebhook', () => {
  const prJob = job({
    name: 'pr-job',
    trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y' },
  });

  it('selects a job whose trigger matches the pull_request event + repo', () => {
    const matched = matchJobsToWebhook([prJob], pullRequestWebhook('x/y'));
    expect(matched.map((j) => j.name)).toEqual(['pr-job']);
  });

  it('does NOT match a push payload against a pull_request trigger', () => {
    const matched = matchJobsToWebhook([prJob], pushWebhook('x/y'));
    expect(matched).toEqual([]);
  });

  it('does NOT match a pull_request payload for a different repo', () => {
    const matched = matchJobsToWebhook([prJob], pullRequestWebhook('a/b'));
    expect(matched).toEqual([]);
  });

  it('leaves a time-based (schedule-only) job unaffected by any webhook', () => {
    const cronJob = job({ name: 'nightly', schedule: '0 3 * * *' });
    // A schedule-only job has no trigger, so it is never selected — not by the
    // matching event, not by a mismatching one.
    expect(matchJobsToWebhook([cronJob], pullRequestWebhook('x/y'))).toEqual([]);
    expect(matchJobsToWebhook([cronJob], pushWebhook('x/y'))).toEqual([]);
  });

  it('matches a repo-agnostic trigger (no repo filter) against any repo', () => {
    const anyRepo = job({ name: 'any', trigger: { type: 'github_event', event: 'pull_request' } });
    expect(matchJobsToWebhook([anyRepo], pullRequestWebhook('who/ever')).map((j) => j.name)).toEqual(['any']);
  });

  it('honors a branch filter (base or head ref)', () => {
    const mainOnly = job({
      name: 'main-only',
      trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y', branch: 'main' },
    });
    expect(jobMatchesWebhook(mainOnly, pullRequestWebhook('x/y', 'main', 'topic'))).toBe(true);
    // base=develop head=topic → neither is main
    expect(jobMatchesWebhook(mainOnly, pullRequestWebhook('x/y', 'develop', 'topic'))).toBe(false);
  });

  it('honors a branch filter for push (refs/heads/<b>)', () => {
    const mainOnly = job({
      name: 'push-main',
      trigger: { type: 'github_event', event: 'push', repo: 'x/y', branch: 'main' },
    });
    expect(jobMatchesWebhook(mainOnly, pushWebhook('x/y', 'refs/heads/main'))).toBe(true);
    expect(jobMatchesWebhook(mainOnly, pushWebhook('x/y', 'refs/heads/dev'))).toBe(false);
  });

  it('skips disabled jobs', () => {
    const disabled = job({
      name: 'off',
      enabled: false,
      trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y' },
    });
    expect(matchJobsToWebhook([disabled], pullRequestWebhook('x/y'))).toEqual([]);
  });
});

describe('payload extraction helpers', () => {
  it('reads repository.full_name', () => {
    expect(webhookRepo({ repository: { full_name: 'x/y' } })).toBe('x/y');
    expect(webhookRepo({})).toBeNull();
  });

  it('extracts branches per event type', () => {
    expect(webhookBranches('push', { ref: 'refs/heads/main' })).toEqual(['main']);
    expect(
      webhookBranches('pull_request', { pull_request: { base: { ref: 'main' }, head: { ref: 'feat' } } }).sort(),
    ).toEqual(['feat', 'main']);
    expect(webhookBranches('workflow_run', { workflow_run: { head_branch: 'release' } })).toEqual(['release']);
    expect(webhookBranches('issue_comment', {})).toEqual([]);
  });
});

describe('fireWebhookJobs', () => {
  it('dispatches each matched job through the injected dispatch path, not schedule-only jobs', async () => {
    const jobs: JobConfig[] = [
      job({ name: 'pr-job', trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y' } }),
      job({ name: 'nightly', schedule: '0 3 * * *' }),
    ];
    const dispatched: string[] = [];
    const dispatch = async (config: JobConfig): Promise<RunMeta> => {
      dispatched.push(config.name);
      return {
        jobName: config.name,
        runId: `run-${config.name}`,
        agent: config.agent,
        pid: 1234,
        status: 'running',
        startedAt: new Date().toISOString(),
        completedAt: null,
        exitCode: null,
      };
    };

    const fired = await fireWebhookJobs(pullRequestWebhook('x/y'), { jobs, dispatch });

    expect(dispatched).toEqual(['pr-job']);
    expect(fired).toEqual([{ jobName: 'pr-job', runId: 'run-pr-job' }]);
  });
});
