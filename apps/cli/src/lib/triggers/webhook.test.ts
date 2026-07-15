import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as http from 'http';
import type { JobConfig, RunMeta } from '../routines.js';
import {
  matchJobsToWebhook,
  jobMatchesWebhook,
  webhookRepo,
  webhookBranches,
  fireWebhookJobs,
  verifyGithubSignature,
  verifyLinearSignature,
  startWebhookServer,
  type IncomingWebhook,
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
function pullRequestWebhook(repoFullName: string, baseRef = 'main', headRef = 'feature'): IncomingWebhook {
  return {
    source: 'github',
    event: 'pull_request',
    payload: {
      action: 'opened',
      repository: { full_name: repoFullName },
      pull_request: { base: { ref: baseRef }, head: { ref: headRef } },
    },
  };
}

/** A `push` webhook for repo x/y on branch main. */
function pushWebhook(repoFullName: string, ref = 'refs/heads/main'): IncomingWebhook {
  return {
    source: 'github',
    event: 'push',
    payload: { repository: { full_name: repoFullName }, ref },
  };
}

function linearIssueWebhook(labels: string[] = ['agent']): IncomingWebhook {
  return {
    source: 'linear',
    event: 'Issue',
    payload: {
      type: 'Issue',
      action: 'update',
      webhookTimestamp: Date.now(),
      data: {
        identifier: 'RUSH-1459',
        labels: { nodes: labels.map((name) => ({ name })) },
      },
    },
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

  it('matches Linear issue triggers by action, team key, and label', () => {
    const linear = job({
      name: 'linear-agent',
      trigger: { type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' },
    });
    expect(jobMatchesWebhook(linear, linearIssueWebhook(['agent']))).toBe(true);
    expect(jobMatchesWebhook(linear, linearIssueWebhook(['triage']))).toBe(false);
  });

  it('skips jobs pinned to other devices, keeps jobs pinned here', () => {
    const saved = process.env.AGENTS_SYNC_MACHINE_ID;
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    try {
      const foreign = job({
        name: 'foreign',
        devices: ['yosemite-s0'],
        trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y' },
      });
      const local = job({
        name: 'local',
        devices: ['zion'],
        trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y' },
      });
      const multi = job({
        name: 'multi',
        devices: ['mac-mini', 'zion'],
        trigger: { type: 'github_event', event: 'pull_request', repo: 'x/y' },
      });
      expect(matchJobsToWebhook([foreign, local, multi], pullRequestWebhook('x/y')).map((j) => j.name)).toEqual(['local', 'multi']);
    } finally {
      if (saved === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
      else process.env.AGENTS_SYNC_MACHINE_ID = saved;
    }
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

describe('webhook signature verification', () => {
  it('verifies GitHub and Linear HMAC-SHA256 signatures against the raw body', () => {
    const secret = 'test-secret';
    const raw = Buffer.from(JSON.stringify({ hello: 'world' }));
    const hex = crypto.createHmac('sha256', secret).update(raw).digest('hex');

    expect(verifyGithubSignature({ 'x-hub-signature-256': `sha256=${hex}` }, raw, secret)).toBe(true);
    expect(verifyGithubSignature({ 'x-hub-signature-256': 'sha256=bad' }, raw, secret)).toBe(false);
    expect(verifyLinearSignature({ 'linear-signature': hex }, raw, secret)).toBe(true);
    expect(verifyLinearSignature({ 'linear-signature': 'bad' }, raw, secret)).toBe(false);
  });
});

describe('startWebhookServer', () => {
  it('rejects unsigned public deliveries and accepts signed Linear deliveries once', async () => {
    const secret = 'linear-secret';
    const jobs = [
      job({
        name: 'linear-agent',
        trigger: { type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' },
      }),
    ];
    const dispatched: string[] = [];
    const server = startWebhookServer({
      secrets: { linear: secret },
      fire: {
        jobs,
        dispatch: async (config: JobConfig): Promise<RunMeta> => {
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
        },
      },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('server did not bind');
    try {
      const payload = Buffer.from(JSON.stringify(linearIssueWebhook(['agent']).payload));
      const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const send = (headers: Record<string, string>) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: address.port,
          path: '/hooks/linear',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...headers },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('error', reject);
        req.end(payload);
      });

      expect((await send({})).status).toBe(401);
      expect((await send({ 'linear-signature': sig, 'linear-delivery': 'delivery-1' })).status).toBe(200);
      const duplicate = await send({ 'linear-signature': sig, 'linear-delivery': 'delivery-1' });
      expect(duplicate.status).toBe(200);
      expect(JSON.parse(duplicate.body).duplicate).toBe(true);
      expect(dispatched).toEqual(['linear-agent']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not burn a delivery id when a signed Linear delivery is stale', async () => {
    const secret = 'linear-secret';
    const jobs = [
      job({
        name: 'linear-agent',
        trigger: { type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' },
      }),
    ];
    const dispatched: string[] = [];
    const server = startWebhookServer({
      secrets: { linear: secret },
      fire: {
        jobs,
        dispatch: async (config: JobConfig): Promise<RunMeta> => {
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
        },
      },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('server did not bind');
    try {
      const send = (payload: Buffer, delivery = 'delivery-retry') => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
        const req = http.request({
          host: '127.0.0.1',
          port: address.port,
          path: '/hooks/linear',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(payload.length),
            'linear-signature': sig,
            'linear-delivery': delivery,
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('error', reject);
        req.end(payload);
      });

      const stale = linearIssueWebhook(['agent']).payload as Record<string, unknown>;
      stale.webhookTimestamp = Date.now() - 120_000;
      expect((await send(Buffer.from(JSON.stringify(stale)))).status).toBe(401);

      const fresh = Buffer.from(JSON.stringify(linearIssueWebhook(['agent']).payload));
      const retry = await send(fresh);
      expect(retry.status).toBe(200);
      expect(JSON.parse(retry.body).duplicate).toBeUndefined();
      expect(dispatched).toEqual(['linear-agent']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not let unsigned traffic consume the signed delivery rate limit', async () => {
    const secret = 'linear-secret';
    const jobs = [
      job({
        name: 'linear-agent',
        trigger: { type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' },
      }),
    ];
    const dispatched: string[] = [];
    const server = startWebhookServer({
      secrets: { linear: secret },
      rateLimitPerMinute: 1,
      fire: {
        jobs,
        dispatch: async (config: JobConfig): Promise<RunMeta> => {
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
        },
      },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('server did not bind');
    try {
      const payload = Buffer.from(JSON.stringify(linearIssueWebhook(['agent']).payload));
      const signedHeaders = {
        'linear-signature': crypto.createHmac('sha256', secret).update(payload).digest('hex'),
        'linear-delivery': 'delivery-rate-limit',
      };
      const send = (headers: Record<string, string>) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: address.port,
          path: '/hooks/linear',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...headers },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('error', reject);
        req.end(payload);
      });

      expect((await send({})).status).toBe(401);
      expect((await send({})).status).toBe(401);
      expect((await send(signedHeaders)).status).toBe(200);
      expect(dispatched).toEqual(['linear-agent']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not mark a delivery when dispatch fails so retry can finish matched routines', async () => {
    const secret = 'linear-secret';
    const jobs = [
      job({
        name: 'linear-agent',
        trigger: { type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' },
      }),
      job({
        name: 'linear-followup',
        trigger: { type: 'linear_event', event: 'Issue', action: 'update', teamKey: 'RUSH', label: 'agent' },
      }),
    ];
    const dispatched: string[] = [];
    let shouldFailFollowup = true;
    const server = startWebhookServer({
      secrets: { linear: secret },
      fire: {
        jobs,
        dispatch: async (config: JobConfig): Promise<RunMeta> => {
          dispatched.push(config.name);
          if (config.name === 'linear-followup' && shouldFailFollowup) {
            shouldFailFollowup = false;
            throw new Error('dispatch failed after a previous match fired');
          }
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
        },
      },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('server did not bind');
    try {
      const payload = Buffer.from(JSON.stringify(linearIssueWebhook(['agent']).payload));
      const signedHeaders = {
        'linear-signature': crypto.createHmac('sha256', secret).update(payload).digest('hex'),
        'linear-delivery': 'delivery-partial',
      };
      const send = () => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: address.port,
          path: '/hooks/linear',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...signedHeaders },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('error', reject);
        req.end(payload);
      });

      expect((await send()).status).toBe(400);
      const retry = await send();
      expect(retry.status).toBe(200);
      expect(JSON.parse(retry.body).duplicate).toBeUndefined();
      expect(dispatched).toEqual(['linear-agent', 'linear-followup', 'linear-agent', 'linear-followup']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
