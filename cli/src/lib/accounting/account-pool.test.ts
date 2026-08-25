import { describe, it, expect } from 'vitest';
import { registryPoolCandidates, type RegistryAccountRecord } from './account-pool.js';

describe('registryPoolCandidates — harness capability filter', () => {
  const records: RegistryAccountRecord[] = [
    { name: 'claude-setup', provider: 'anthropic', auth: 'setup-token' },
    { name: 'openai-key', provider: 'openai', auth: 'api-key' },
    { name: 'cursor-key', provider: 'cursor', auth: 'api-key' },
    { name: 'or-key', provider: 'openrouter', auth: 'api-key' },
  ];

  it('claude pool includes anthropic + openrouter (both can auth claude), excludes openai/cursor', () => {
    expect(registryPoolCandidates(records, 'claude').map((c) => c.name)).toEqual(['claude-setup', 'or-key']);
  });

  it('codex pool includes openai + openrouter, excludes anthropic setup-token + cursor', () => {
    expect(registryPoolCandidates(records, 'codex').map((c) => c.name)).toEqual(['openai-key', 'or-key']);
  });

  it('cursor pool includes only the cursor key', () => {
    expect(registryPoolCandidates(records, 'cursor').map((c) => c.name)).toEqual(['cursor-key']);
  });

  it('grok pool includes only an xai key', () => {
    const withXai = [...records, { name: 'grok-key', provider: 'xai', auth: 'api-key' as const }];
    expect(registryPoolCandidates(withXai, 'grok').map((c) => c.name)).toEqual(['grok-key']);
  });

  it('tags a synthetic agent-scoped accountKey until identity capture backfills it', () => {
    const [c] = registryPoolCandidates(records, 'claude');
    expect(c.accountKey).toBe('claude:name=claude-setup');
    expect(c.email).toBeNull();
    expect(c.auth).toBe('setup-token');
  });

  it('keeps (agent, account) distinct — same account name under two harnesses gets different keys', () => {
    const rec: RegistryAccountRecord[] = [{ name: 'or', provider: 'openrouter', auth: 'api-key' }];
    const claudeKey = registryPoolCandidates(rec, 'claude')[0].accountKey;
    const codexKey = registryPoolCandidates(rec, 'codex')[0].accountKey;
    expect(claudeKey).not.toBe(codexKey);
  });
});
