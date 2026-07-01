import { describe, it, expect } from 'vitest';
import { parseReadyProbe, viewHasAgent } from './ready.js';

const MARK = '@@AGENTS_READY@@';

describe('parseReadyProbe', () => {
  it('parses version + agent listing from one compound probe', () => {
    const stdout = `2.1.170\n${MARK}\nClaude (balanced)\nCodex (balanced)\n`;
    const p = parseReadyProbe(stdout);
    expect(p.reachable).toBe(true);
    expect(p.version).toBe('2.1.170');
    expect(p.view).toContain('Claude');
  });

  it('strips a leading v from the version', () => {
    expect(parseReadyProbe(`v2.1.170\n${MARK}\nClaude`).version).toBe('2.1.170');
  });

  it('reports reachable-but-not-installed when the version half is empty', () => {
    // agents-cli missing: `agents --version` printed nothing, but the login
    // shell still ran our printf so the marker (and thus reachability) is intact.
    const p = parseReadyProbe(`\n${MARK}\n`);
    expect(p.reachable).toBe(true);
    expect(p.version).toBeNull();
  });

  it('treats a missing marker as unreachable (ssh never ran our shell)', () => {
    const p = parseReadyProbe('');
    expect(p.reachable).toBe(false);
    expect(p.version).toBeNull();
    expect(p.view).toBe('');
  });
});

describe('viewHasAgent', () => {
  const view = 'Claude (balanced) 2.1.170\nCodex (balanced) 0.134.0';
  it('matches an installed agent case-insensitively', () => {
    expect(viewHasAgent(view, 'claude')).toBe(true);
    expect(viewHasAgent(view, 'codex')).toBe(true);
  });
  it('does not match an absent agent', () => {
    expect(viewHasAgent(view, 'gemini')).toBe(false);
  });
});
