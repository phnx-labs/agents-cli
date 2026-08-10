import { describe, it, expect } from 'bun:test';
import { resolveTabIndex, type TabView } from './tabIndex';

const term = (label: string): TabView => ({ label, isTerminal: true });
const file = (label: string): TabView => ({ label, isTerminal: false });

describe('resolveTabIndex', () => {
  it('returns the 1-based position of the matching terminal tab within its group', () => {
    const groups = [[file('README.md'), term('CC - auth'), term('CX - ui')]];
    expect(resolveTabIndex(groups, 'CC - auth')).toBe(2);
    expect(resolveTabIndex(groups, 'CX - ui')).toBe(3);
  });

  it('indexes relative to the tab position, counting non-terminal tabs', () => {
    // The file tab at index 0 still shifts the terminal to tab 2.
    expect(resolveTabIndex([[file('index.ts'), term('CC')]], 'CC')).toBe(1 + 1);
  });

  it('resolves per-group, scanning groups in order', () => {
    const groups = [[file('a.ts'), term('CC')], [term('CX'), term('GX')]];
    expect(resolveTabIndex(groups, 'CC')).toBe(2); // group 0, position 2
    expect(resolveTabIndex(groups, 'CX')).toBe(1); // group 1, position 1
    expect(resolveTabIndex(groups, 'GX')).toBe(2); // group 1, position 2
  });

  it('ignores non-terminal tabs even when their label matches', () => {
    expect(resolveTabIndex([[file('CC'), term('CX')]], 'CC')).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    expect(resolveTabIndex([[term('CC')]], 'nope')).toBeUndefined();
    expect(resolveTabIndex([], 'CC')).toBeUndefined();
    expect(resolveTabIndex([[]], 'CC')).toBeUndefined();
  });

  it('returns undefined for an empty terminal name', () => {
    expect(resolveTabIndex([[term('')]], '')).toBeUndefined();
  });

  it('takes the first match within a group when labels are ambiguous', () => {
    expect(resolveTabIndex([[term('CC'), term('CC')]], 'CC')).toBe(1);
  });
});
