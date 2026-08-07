import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as labels from './account-labels.js';

describe('account labels', () => {
  let root = '';
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-account-labels-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it('stores no raw identity and permits many version bindings', () => {
    const fingerprint = labels.setAccountLabel('work', 'claude', 'claude:account=secret-provider-id', root);
    labels.bindAccount('zion', 'claude@2.1.220', 'work', fingerprint, root);
    labels.bindAccount('zion', 'claude@2.1.219', 'work', fingerprint, root);
    expect(fs.readFileSync(path.join(root, 'accounts.yaml'), 'utf8')).not.toContain('secret-provider-id');
    expect(Object.keys(labels.readAccountBindings('zion', root).bindings)).toEqual(['claude@2.1.220', 'claude@2.1.219']);
  });
  it('rejects assigning one harness identity to two labels', () => {
    labels.setAccountLabel('work', 'codex', 'codex:account=one', root);
    expect(() => labels.setAccountLabel('personal', 'codex', 'codex:account=one', root)).toThrow("already labeled 'work'");
  });
  it('supports one cross-harness logical label', () => {
    labels.setAccountLabel('work', 'claude', 'claude:account=one', root);
    labels.setAccountLabel('work', 'codex', 'codex:account=two', root);
    expect(Object.keys(labels.readAccountLabels(root).labels.work.identities)).toEqual(['claude', 'codex']);
  });
  it('renames bindings and refuses to remove an attached label', () => {
    const fingerprint = labels.setAccountLabel('work', 'claude', 'claude:account=one', root);
    labels.bindAccount('zion', 'claude@2.1.220', 'work', fingerprint, root);
    labels.renameAccountLabel('work', 'company', root);
    expect(labels.readAccountBindings('zion', root).bindings['claude@2.1.220'].label).toBe('company');
    expect(() => labels.removeAccountLabel('company', root)).toThrow('Detach those versions first');
  });
});
