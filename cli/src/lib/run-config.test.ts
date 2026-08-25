import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getProjectRunConfigs } from './run-config.js';

describe('getProjectRunConfigs', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-run-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns project run configs from nearest directory upward', () => {
    const nested = path.join(root, 'app', 'pkg');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'agents.yaml'),
      [
        'run:',
        '  defaults:',
        '    "claude:*":',
        '      model: opus',
        '',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(root, 'app', 'agents.yaml'),
      [
        'run:',
        '  defaults:',
        '    "claude:*":',
        '      mode: auto',
        '',
      ].join('\n'),
      'utf-8',
    );

    expect(getProjectRunConfigs(nested)).toEqual([
      {
        defaults: {
          'claude:*': {
            mode: 'auto',
          },
        },
      },
      {
        defaults: {
          'claude:*': {
            model: 'opus',
          },
        },
      },
    ]);
  });
});
