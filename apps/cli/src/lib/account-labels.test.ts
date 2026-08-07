import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identityFingerprint, labelForFingerprint, nameAccount, readAccountLabels, removeAccountLabel, renameAccountLabel } from './account-labels.js';

describe('account labels', () => {
  let root = '';
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-account-labels-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it('stores one provider identity without raw account data', () => { const fingerprint = identityFingerprint('claude', 'claude:account=secret-provider-id'); nameAccount('work', 'claude', fingerprint, root); const raw = fs.readFileSync(path.join(root, 'accounts.yaml'), 'utf8'); expect(raw).not.toContain('secret-provider-id'); expect(readAccountLabels(root).labels.work).toEqual({ agent: 'claude', fingerprint }); });
  it('prevents one provider account from having two labels', () => { const fingerprint = identityFingerprint('codex', 'codex:account=one'); nameAccount('work', 'codex', fingerprint, root); expect(() => nameAccount('personal', 'codex', fingerprint, root)).toThrow("already named 'work'"); });
  it('prevents a label from grouping different provider accounts', () => { nameAccount('work', 'claude', 'aaa', root); expect(() => nameAccount('work', 'codex', 'bbb', root)).toThrow('already names another account'); });
  it('renames and removes labels without version bindings', () => { nameAccount('work', 'claude', 'aaa', root); renameAccountLabel('work', 'company', root); expect(labelForFingerprint('claude', 'aaa', readAccountLabels(root))).toBe('company'); removeAccountLabel('company', root); expect(readAccountLabels(root).labels).toEqual({}); });
});
