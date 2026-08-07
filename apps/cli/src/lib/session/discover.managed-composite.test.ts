import { describe, it, expect } from 'vitest';
import { isManagedSessionFile } from './discover.js';

// A composite file_path (`<container>#<id>`) names a row inside a single shared DB
// the scanner reads from one fixed location (OpenCode's `opencode.db`). That store
// is never a per-install dotfile under a version home, so the managed-vs-unmanaged
// split does not apply — treating it as "the user's own unmanaged install" hid
// every OpenCode row from default listings once any agent was managed (RUSH-2357).
describe('isManagedSessionFile — composite (single-DB) sessions (RUSH-2357)', () => {
  it('classifies a composite OpenCode path as managed even though it sits in the XDG data dir', () => {
    const composite = '/home/u/.local/share/opencode/opencode.db#ses_02410a2c3ffeRumGfUNRgtB1Xk';
    expect(isManagedSessionFile(composite)).toBe(true);
  });

  it('still treats a plain per-install dotfile transcript as unmanaged', () => {
    // No `#` fragment: an ordinary ~/.<agent> transcript, not under any version home.
    const dotfile = '/home/u/.codex/sessions/2026/07/30/rollout-abc.jsonl';
    expect(isManagedSessionFile(dotfile)).toBe(false);
  });

  it('is keyed off the composite FORM, not the harness name — any single-DB path qualifies', () => {
    const future = '/var/data/futureharness/store.sqlite#conv_123';
    expect(isManagedSessionFile(future)).toBe(true);
  });
});
