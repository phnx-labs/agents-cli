/**
 * Host cloud provider — your machines behind the CloudProvider contract.
 *
 * The real bugs this guards against:
 *   1. Dispatch without a host must throw MissingTargetError('host') so the
 *      cloud CLI's standard target-picker flow engages — not a raw error.
 *   2. --repo/--branch must be refused loud: the host provider clones nothing,
 *      and silently accepting them would look like a repo-scoped run.
 *   3. A host task's sidecar statuses must map onto the canonical cloud enum
 *      with the reconcile rule intact: `unknown` is NOT a failure.
 *   4. message() on a run without a sessionId (non-Claude) must refuse with
 *      the follow-up-run suggestion instead of dispatching a resume that the
 *      remote CLI would reject.
 *   5. listTargets() must expose the unified pool minus non-dispatchable
 *      (password-auth) devices — the same filter cap routing applies.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Set HOME before state.ts loads so the hosts/devices registries and the
// host-task sidecar dir all resolve under the temp root.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cloud-host-test-'));
process.env.HOME = TEST_HOME;

const { HostCloudProvider, hostTaskToCloudTask } = await import('./host.js');
const { MissingTargetError } = await import('./types.js');
const { saveTask } = await import('../hosts/tasks.js');
const { upsertDevice } = await import('../../lib/devices/registry.js');
const { updateMeta } = await import('../state.js');
import type { HostTask } from '../hosts/tasks.js';

function baseTask(overrides: Partial<HostTask> = {}): HostTask {
  return {
    id: 'abcd1234',
    host: 'gpu-box',
    target: 'taylor@gpu-box.tail.ts.net',
    agent: 'codex',
    prompt: 'run the benchmark',
    remoteLog: '$HOME/.agents/.cache/hosts/abcd1234.log',
    remoteExit: '$HOME/.agents/.cache/hosts/abcd1234.exit',
    status: 'running',
    createdAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  fs.rmSync(path.join(TEST_HOME, '.agents', '.cache', 'hosts'), { recursive: true, force: true });
  fs.rmSync(path.join(TEST_HOME, '.agents', '.history', 'devices'), { recursive: true, force: true });
  updateMeta((meta) => {
    const { hosts: _omit, ...rest } = meta;
    return rest;
  });
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('hostTaskToCloudTask', () => {
  it('maps sidecar statuses onto the canonical enum — unknown is never a failure', () => {
    expect(hostTaskToCloudTask(baseTask({ status: 'running' })).status).toBe('running');
    expect(hostTaskToCloudTask(baseTask({ status: 'unknown' })).status).toBe('running');
    expect(hostTaskToCloudTask(baseTask({ status: 'completed', finishedAt: '2026-07-13T01:00:00.000Z' })).status).toBe('completed');
    expect(hostTaskToCloudTask(baseTask({ status: 'failed' })).status).toBe('failed');
  });

  it('carries id/agent/prompt and stamps the host into the summary', () => {
    const t = hostTaskToCloudTask(baseTask({ name: 'nightly' }));
    expect(t.id).toBe('abcd1234');
    expect(t.provider).toBe('host');
    expect(t.agent).toBe('codex');
    expect(t.summary).toBe('on gpu-box as "nightly"');
  });
});

describe('HostCloudProvider.dispatch — validation', () => {
  const provider = new HostCloudProvider();

  it('throws MissingTargetError(host) when no host was given', async () => {
    const err = await provider.dispatch({ prompt: 'p' }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(MissingTargetError);
    expect((err as InstanceType<typeof MissingTargetError>).kind).toBe('host');
  });

  it('refuses --repo loud (the host provider clones nothing)', async () => {
    const err = await provider
      .dispatch({ prompt: 'p', repo: 'owner/repo', providerOptions: { host: 'gpu-box' } })
      .catch((e) => e as Error);
    expect((err as Error).message).toMatch(/--repo has no meaning/);
  });

  it('refuses --branch loud', async () => {
    const err = await provider
      .dispatch({ prompt: 'p', branch: 'main', providerOptions: { host: 'gpu-box' } })
      .catch((e) => e as Error);
    expect((err as Error).message).toMatch(/--branch has no meaning/);
  });
});

describe('HostCloudProvider.status/message — task lookup', () => {
  const provider = new HostCloudProvider();

  it('status throws on an unknown task id', async () => {
    await expect(provider.status('nope0000')).rejects.toThrow(/Unknown host task/);
  });

  it('message refuses a task with no sessionId, suggesting a follow-up run', async () => {
    saveTask(baseTask({ status: 'completed' }));
    const err = await provider.message('abcd1234', 'and now the report').catch((e) => e as Error);
    expect((err as Error).message).toMatch(/no session id to resume/);
    expect((err as Error).message).toMatch(/agents run codex .* --host gpu-box/);
  });

  it('list projects every sidecar; terminal tasks skip the ssh probe entirely', async () => {
    saveTask(baseTask({ id: 'aaaa1111', status: 'completed', finishedAt: '2026-07-13T01:00:00.000Z' }));
    saveTask(baseTask({ id: 'bbbb2222', status: 'failed', finishedAt: '2026-07-13T02:00:00.000Z' }));
    const tasks = await provider.list();
    expect(tasks.map((t) => t.id).sort()).toEqual(['aaaa1111', 'bbbb2222']);
    const failed = await provider.list({ status: 'failed' });
    expect(failed.map((t) => t.id)).toEqual(['bbbb2222']);
  });
});

describe('HostCloudProvider.listTargets', () => {
  const provider = new HostCloudProvider();

  it('exposes the unified pool and filters non-dispatchable devices', async () => {
    await upsertDevice('key-box', {
      platform: 'linux',
      user: 'taylor',
      address: { via: 'tailscale', dnsName: 'key-box.tail.ts.net' },
      auth: { method: 'key' },
      tailscale: { id: 'n1', hostName: 'key-box', online: true },
    });
    await upsertDevice('pw-box', {
      platform: 'windows',
      user: 'w',
      address: { via: 'tailscale', dnsName: 'pw-box.tail.ts.net' },
      auth: { method: 'password', bundle: 'b', bundleKey: 'k' },
    });
    updateMeta((meta) => ({
      ...meta,
      hosts: { 'build-host': { source: 'inline', address: '10.0.0.5', user: 'ci', caps: ['build'], addedAt: new Date().toISOString() } },
    }));

    const targets = await provider.listTargets();
    const ids = targets.map((t) => t.id).sort();
    expect(ids).toContain('key-box');
    expect(ids).toContain('build-host');
    expect(ids).not.toContain('pw-box');
    for (const t of targets) expect(t.kind).toBe('host');
    const buildHost = targets.find((t) => t.id === 'build-host');
    expect(buildHost?.label).toContain('caps: build');
  });
});
