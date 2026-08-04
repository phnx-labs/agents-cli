import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readCrabboxRepoProfile, DEFAULT_CRABBOX_PROFILE } from './config.js';

describe('readCrabboxRepoProfile', () => {
  function withRepo(files: Record<string, string>, fn: (root: string) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbox-cfg-'));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body, 'utf-8');
    try {
      fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('reads the profile a repo .crabbox.yaml declares', () => {
    withRepo({ '.crabbox.yaml': 'profile: agents-cli\nclass: cpx62\n' }, (root) => {
      expect(readCrabboxRepoProfile(root)).toBe('agents-cli');
    });
  });

  it('returns undefined when the repo has no .crabbox.yaml (crabbox default applies)', () => {
    withRepo({}, (root) => {
      expect(readCrabboxRepoProfile(root)).toBeUndefined();
    });
  });

  it('returns undefined when the file has no profile key or is unparseable', () => {
    withRepo({ '.crabbox.yaml': 'class: cpx62\n' }, (root) => {
      expect(readCrabboxRepoProfile(root)).toBeUndefined();
    });
    withRepo({ '.crabbox.yaml': ': : not yaml : [\n' }, (root) => {
      expect(readCrabboxRepoProfile(root)).toBeUndefined();
    });
  });

  it('exposes the shared fallback label (sandbox.sh PROFILE:-default parity)', () => {
    expect(DEFAULT_CRABBOX_PROFILE).toBe('default');
  });
});
