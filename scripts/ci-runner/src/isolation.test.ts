import { describe, expect, test } from 'bun:test';
import {
  assertMounts,
  assertWorkerEnv,
  findForbiddenRequestFields,
  validateRequestShape,
  workerEnv,
} from './isolation';
import { requestTemplate } from './execute';

describe('isolation', () => {
  test('rejects a lease or checkout on the request', () => {
    expect(findForbiddenRequestFields({ owner: 'a', leaseId: 'box-1' })).toEqual(['leaseId']);
    expect(() => validateRequestShape({
      ...requestTemplate({
        owner: 'phnx-labs',
        repo: 'agi-cli',
        checkRunId: '1',
        candidateCommitSha: 'a'.repeat(40),
        candidateTreeSha: 'a'.repeat(40),
      }),
      boxId: 'cpx62-9',
    })).toThrow(/must not carry a lease or checkout path/);
  });

  test('rejects fork code on the persistent executor', () => {
    expect(() => validateRequestShape(requestTemplate({
      owner: 'phnx-labs',
      repo: 'agi-cli',
      checkRunId: '2',
      candidateCommitSha: 'a'.repeat(40),
      candidateTreeSha: 'a'.repeat(40),
      isFork: true,
    }))).toThrow(/fork pull requests are never scheduled/);
  });

  test('worker env has no host tokens or ssh agent', () => {
    const env = workerEnv('/work/.home');
    expect(env.HOME).toBe('/work/.home');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.AGENTS_CONTROLLER_KEY).toBeUndefined();
    assertWorkerEnv(env);
    expect(() => assertWorkerEnv({ ...env, GITHUB_TOKEN: 'ghs_xxx' })).toThrow(/GITHUB_TOKEN/);
  });

  test('forbids docker, tailnet, and host-home mounts', () => {
    expect(() => assertMounts(['/var/run/docker.sock'])).toThrow(/docker.sock/);
    expect(() => assertMounts(['/home/muqsit/.ssh'])).toThrow(/\/home/);
    expect(() => assertMounts(['/var/run/tailscale.socket'])).toThrow(/tailscale/);
    assertMounts(['/srv/ci/runs/phnx-labs/agi-cli/abc/1/worktree']);
  });
});
