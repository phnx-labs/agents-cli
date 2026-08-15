import { describe, expect, it } from 'vitest';
import { classifyAttachTarget, parseBundleKey } from './accounts.js';

describe('accounts credential import', () => {
  it('parses the bundle and key without tying the account to an agent version', () => {
    expect(parseBundleKey('openrouter.ai:OPENROUTER_API_KEY')).toEqual({
      bundle: 'openrouter.ai',
      key: 'OPENROUTER_API_KEY',
    });
  });

  it('rejects incomplete secret references', () => {
    expect(() => parseBundleKey('openrouter.ai')).toThrow('Expected bundle:key');
    expect(() => parseBundleKey(':KEY')).toThrow('Expected bundle:key');
  });
});

describe('classifyAttachTarget', () => {
  it('rejects a completely unknown target', () => {
    expect(() => classifyAttachTarget('totally-unknown-xyz-123')).toThrow('Unknown attach target');
  });

  it('rejects an unknown harness in agent@version form', () => {
    expect(() => classifyAttachTarget('notarealagent@1.0.0')).toThrow("Unknown harness 'notarealagent'");
  });

  it('rejects a valid agent with missing version', () => {
    expect(() => classifyAttachTarget('claude@')).toThrow('missing a version');
  });

  it('rejects a valid agent with an uninstalled version', () => {
    expect(() => classifyAttachTarget('claude@99999.0.0')).toThrow('is not installed');
  });
});
