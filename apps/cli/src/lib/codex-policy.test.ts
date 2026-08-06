import { describe, expect, it } from 'vitest';
import {
  CODEX_EDIT_PROFILE,
  CODEX_PLAN_PROFILE,
  codexPermissionProfileConfig,
  codexPolicyArgs,
  modeForRemoteDispatch,
  modeWasImplicit,
} from './codex-policy.js';

describe('codexPolicyArgs', () => {
  it('keeps plan read-only while enabling network and on-request approval', () => {
    const args = codexPolicyArgs('plan');
    expect(args).toContain('approval_policy="on-request"');
    expect(args).toContain(`default_permissions="${CODEX_PLAN_PROFILE}"`);
    expect(args.join(' ')).toContain('extends = ":read-only"');
    expect(args.join(' ')).toContain('network = { enabled = true, allow_local_binding = true }');
    expect(args.join(' ')).not.toContain('workspace_roots');
  });

  it('gives edit the workspace, managed state, caches, and network', () => {
    const args = codexPolicyArgs('edit', ['/tmp/cache', '/tmp/cache', '/tmp/agents']);
    expect(args).toContain(`default_permissions="${CODEX_EDIT_PROFILE}"`);
    expect(args.join(' ')).toContain('extends = ":workspace"');
    expect(args.join(' ')).toContain('workspace_roots = { "/tmp/cache" = true, "/tmp/agents" = true }');
    expect(args.join(' ')).toContain('network = { enabled = true, allow_local_binding = true }');
  });

  it('keeps skip as the only sandbox and approval bypass', () => {
    expect(codexPolicyArgs('skip')).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });
});

describe('mode provenance', () => {
  it('preserves omitted versus explicit mode across remote dispatch', () => {
    expect(modeForRemoteDispatch('plan', 'default')).toBeUndefined();
    expect(modeForRemoteDispatch('plan', 'cli')).toBe('plan');
    expect(modeForRemoteDispatch('edit', 'config')).toBe('edit');
  });

  it.each(['plan', 'edit', 'skip'])('does not replace an inherited %s resume mode', (mode) => {
    expect(modeForRemoteDispatch(mode, 'implied')).toBe(mode);
    expect(modeWasImplicit('implied', false)).toBe(false);
  });
});

describe('codexPermissionProfileConfig', () => {
  it('quotes writable root keys as TOML strings', () => {
    expect(codexPermissionProfileConfig('edit', ['/tmp/a path'])).toContain('"/tmp/a path" = true');
  });
});
