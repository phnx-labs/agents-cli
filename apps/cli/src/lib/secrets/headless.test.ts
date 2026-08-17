import { describe, it, expect } from 'vitest';
import { isHeadlessSecretsContext, isAgentInvocationContext } from './headless.js';

describe('isAgentInvocationContext', () => {
  it('is false in a clean human shell', () => {
    expect(isAgentInvocationContext({})).toBe(false);
    expect(isAgentInvocationContext({ PATH: '/usr/bin', TERM: 'xterm' })).toBe(false);
  });

  it('fires on every agent-launch marker independently', () => {
    expect(isAgentInvocationContext({ AGENTS_RUNTIME: 'terminal' })).toBe(true);
    expect(isAgentInvocationContext({ AGENTS_RUNTIME: 'headless' })).toBe(true);
    expect(isAgentInvocationContext({ AGENT_SESSION_ID: 'abc' })).toBe(true);
    expect(isAgentInvocationContext({ AGENTS_SESSION_ID: 'abc' })).toBe(true);
    expect(isAgentInvocationContext({ CLAUDECODE: '1' })).toBe(true);
  });

  it('is platform-independent, unlike the biometry-prompt predicate', () => {
    // The materialization boundary holds on Linux/Windows too — the prompt
    // predicate deliberately does not (no biometry to suppress off-darwin).
    expect(isHeadlessSecretsContext({ AGENTS_RUNTIME: 'headless' }, 'linux')).toBe(false);
    expect(isAgentInvocationContext({ AGENTS_RUNTIME: 'headless' })).toBe(true);
  });
});
