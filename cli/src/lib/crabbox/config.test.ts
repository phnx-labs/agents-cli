import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readCrabboxLeaseProfile, DEFAULT_CRABBOX_PROFILE } from './config.js';

describe('readCrabboxLeaseProfile', () => {
  function withRepo(body: string | undefined, fn: (root: string) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbox-lease-cfg-'));
    if (body !== undefined) fs.writeFileSync(path.join(root, '.crabbox.yaml'), body, 'utf-8');
    try {
      fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('uses the shared pool when only the sandbox profile is configured', () => {
    expect(DEFAULT_CRABBOX_PROFILE).toBe('default');
    withRepo('profile: agents-cli\nclass: cpx62\n', (root) => {
      expect(readCrabboxLeaseProfile(root)).toBe('default');
    });
  });

  it('uses a dedicated pool only when leaseProfile explicitly opts in', () => {
    withRepo('profile: agents-cli\nleaseProfile: private-hot-box\n', (root) => {
      expect(readCrabboxLeaseProfile(root)).toBe('private-hot-box');
    });
  });

  it('uses the shared pool for a missing or invalid config', () => {
    withRepo(undefined, (root) => expect(readCrabboxLeaseProfile(root)).toBe('default'));
    withRepo(': : invalid : [\n', (root) => expect(readCrabboxLeaseProfile(root)).toBe('default'));
  });
});
