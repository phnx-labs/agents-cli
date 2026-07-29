import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { shouldShowStarNudge } from './star-nudge.js';

/** A fully "green light" context; override one field per case to prove the gate. */
function ctx(over: Partial<Parameters<typeof shouldShowStarNudge>[0]> = {}) {
  return {
    quiet: false,
    isTTY: true,
    ci: false,
    optedOut: false,
    alreadyShown: false,
    ...over,
  };
}

describe('shouldShowStarNudge gate', () => {
  it('shows when interactive, first time, not quiet/CI/opted-out', () => {
    expect(shouldShowStarNudge(ctx())).toBe(true);
  });

  it('skips quiet/JSON output', () => {
    expect(shouldShowStarNudge(ctx({ quiet: true }))).toBe(false);
  });

  it('skips non-interactive terminals (pipes, redirects)', () => {
    expect(shouldShowStarNudge(ctx({ isTTY: false }))).toBe(false);
  });

  it('skips under CI', () => {
    expect(shouldShowStarNudge(ctx({ ci: true }))).toBe(false);
  });

  it('skips when opted out via AGENTS_NO_NUDGE', () => {
    expect(shouldShowStarNudge(ctx({ optedOut: true }))).toBe(false);
  });

  it('skips once already shown (one-time)', () => {
    expect(shouldShowStarNudge(ctx({ alreadyShown: true }))).toBe(false);
  });
});

describe('maybeShowStarNudge one-time behavior', () => {
  const saved = { HOME: process.env.HOME, CI: process.env.CI, NO: process.env.AGENTS_NO_NUDGE };

  afterEach(() => {
    process.env.HOME = saved.HOME;
    if (saved.CI === undefined) delete process.env.CI; else process.env.CI = saved.CI;
    if (saved.NO === undefined) delete process.env.AGENTS_NO_NUDGE; else process.env.AGENTS_NO_NUDGE = saved.NO;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('writes the sentinel once and never prints twice', async () => {
    // Pin HOME to a scratch dir so the sentinel lands in a throwaway ~/.agents.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-nudge-test-'));
    process.env.HOME = home;
    delete process.env.CI;
    delete process.env.AGENTS_NO_NUDGE;
    // Force the TTY gate on for the test process.
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    // Fresh module graph so state.ts re-reads the pinned HOME.
    vi.resetModules();
    const mod = await import('./star-nudge.js');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    mod.maybeShowStarNudge();
    mod.maybeShowStarNudge();
    mod.maybeShowStarNudge();

    expect(log).toHaveBeenCalledTimes(1);
    expect(mod.hasShownStarNudge()).toBe(true);
    expect(log.mock.calls[0][0]).toContain('github.com/phnx-labs/agents-cli');

    // Restore the real isTTY descriptor.
    if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
  });
});
