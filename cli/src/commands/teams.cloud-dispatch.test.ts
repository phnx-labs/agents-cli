import { afterEach, describe, expect, it } from 'vitest';
import { cloudDispatchOptions } from './teams.js';
import { shareRuntimeEnv } from '../lib/share/config.js';

const originalToken = process.env.SHARE_WRITE_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.SHARE_WRITE_TOKEN;
  else process.env.SHARE_WRITE_TOKEN = originalToken;
});

describe('staged cloud teammate dispatch', () => {
  it('carries the same runtime environment as immediate cloud dispatch', () => {
    process.env.SHARE_WRITE_TOKEN = 'share_test_token';

    const options = cloudDispatchOptions({
      prompt: 'ship it',
      agentType: 'codex',
      cloudRepo: 'phnx-labs/agi-cli',
      cloudBranch: 'agents/test',
      model: null,
    });

    expect(options).toMatchObject({
      prompt: 'ship it',
      agent: 'codex',
      repo: 'phnx-labs/agi-cli',
      branch: 'agents/test',
    });
    expect(Object.hasOwn(options, 'env')).toBe(true);
    expect(options.env).toEqual(shareRuntimeEnv());
  });
});
