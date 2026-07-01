import { describe, it, expect } from 'vitest';
import { renderWhatsNew } from './whats-new.js';

// Strip ANSI so assertions read against plain text (robust under FORCE_COLOR).
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const CHANGELOG = `# Changelog

## Unreleased

## 1.20.34

**Test suite runs remotely on a crabbox VM (#525, #540)**

- \`scripts/release.sh\`'s test gate now runs on a leased crabbox VM.
- \`scripts/sandbox.sh\` box acquisition is now robust.

## 1.20.31

**\`agents sessions <id>\`: a catch-up digest (#502)**

- Opening a single session now leads with its title.

**A second heading in the same version**

- Some detail.
- Another detail with an inline **bold** word.

## 1.20.30

**Older release the user already had**

- Should never appear.
`;

describe('renderWhatsNew', () => {
  it('keeps only headings as bullets and drops the verbose sub-bullets', () => {
    const lines = renderWhatsNew(CHANGELOG, '1.20.31', '1.20.34').map(plain);

    // Version header + its single heading, nothing from the detail bullets.
    expect(lines).toContain('v1.20.34');
    expect(lines).toContain('  • Test suite runs remotely on a crabbox VM (#525, #540)');
    // The detail sub-bullets must be gone.
    expect(lines.some((l) => l.includes('release.sh'))).toBe(false);
    expect(lines.some((l) => l.includes('box acquisition'))).toBe(false);
  });

  it('emits a bullet for every heading within a single version', () => {
    const lines = renderWhatsNew(CHANGELOG, '1.20.30', '1.20.31').map(plain);
    expect(lines).toContain('v1.20.31');
    expect(lines).toContain('  • `agents sessions <id>`: a catch-up digest (#502)');
    expect(lines).toContain('  • A second heading in the same version');
  });

  it('bounds the range to (from, to] — excludes from, includes to, skips out-of-range', () => {
    const lines = renderWhatsNew(CHANGELOG, '1.20.31', '1.20.34').map(plain);
    // from (1.20.31) is excluded ...
    expect(lines).not.toContain('v1.20.31');
    // ... and versions below from are never shown.
    expect(lines.some((l) => l.includes('Older release'))).toBe(false);
    expect(lines).not.toContain('v1.20.30');
  });

  it('returns nothing when the range is empty', () => {
    expect(renderWhatsNew(CHANGELOG, '1.20.34', '1.20.34')).toEqual([]);
  });
});
