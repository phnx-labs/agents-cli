import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// star-nudge.ts -> state.ts resolves HOME at import time, so pin HOME to a
// throwaway dir BEFORE the module is ever loaded. Done at top-level module
// scope (runs after the hoisted imports above, none of which load state.ts),
// then the single dynamic import below picks it up — no vi.resetModules needed,
// which keeps this compatible with both vitest and `bun test`.
const savedHome = process.env.HOME;
const savedCI = process.env.CI;
const savedOptOut = process.env.AGENTS_NO_NUDGE;
const savedTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-nudge-test-'));
process.env.HOME = TMP_HOME;
delete process.env.CI;
delete process.env.AGENTS_NO_NUDGE;

type Mod = typeof import('./star-nudge.js');
let mod: Mod;

beforeAll(async () => {
  mod = await import('./star-nudge.js');
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedCI === undefined) delete process.env.CI; else process.env.CI = savedCI;
  if (savedOptOut === undefined) delete process.env.AGENTS_NO_NUDGE; else process.env.AGENTS_NO_NUDGE = savedOptOut;
  if (savedTTY) Object.defineProperty(process.stdout, 'isTTY', savedTTY);
});

/** A fully "green light" context; override one field per case to prove the gate. */
function ctx(over: Partial<Parameters<Mod['shouldShowStarNudge']>[0]> = {}) {
  return { quiet: false, isTTY: true, ci: false, optedOut: false, alreadyShown: false, ...over };
}

describe('shouldShowStarNudge gate', () => {
  it('shows when interactive, first time, not quiet/CI/opted-out', () => {
    expect(mod.shouldShowStarNudge(ctx())).toBe(true);
  });

  it('skips quiet/JSON output', () => {
    expect(mod.shouldShowStarNudge(ctx({ quiet: true }))).toBe(false);
  });

  it('skips non-interactive terminals (pipes, redirects)', () => {
    expect(mod.shouldShowStarNudge(ctx({ isTTY: false }))).toBe(false);
  });

  it('skips under CI', () => {
    expect(mod.shouldShowStarNudge(ctx({ ci: true }))).toBe(false);
  });

  it('skips when opted out via AGENTS_NO_NUDGE', () => {
    expect(mod.shouldShowStarNudge(ctx({ optedOut: true }))).toBe(false);
  });

  it('skips once already shown (one-time)', () => {
    expect(mod.shouldShowStarNudge(ctx({ alreadyShown: true }))).toBe(false);
  });
});

/** Run a thunk with console.log captured; returns every logged line. Portable — no vi mocks. */
function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

describe('maybeShowStarNudge one-time behavior', () => {
  it('prints exactly once, writes the sentinel, then stays silent', () => {
    // Force the TTY gate on for this non-interactive test process.
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    expect(mod.hasShownStarNudge()).toBe(false);
    const first = captureLog(() => mod.maybeShowStarNudge());
    const second = captureLog(() => mod.maybeShowStarNudge());
    const third = captureLog(() => mod.maybeShowStarNudge());

    expect(first).toHaveLength(1);
    expect(first[0]).toContain('github.com/phnx-labs/agents-cli');
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(0);
    expect(mod.hasShownStarNudge()).toBe(true);
    // Sentinel really landed under the pinned throwaway HOME.
    expect(fs.existsSync(path.join(TMP_HOME, '.agents', '.cache', 'state', 'star-nudge-shown'))).toBe(true);
  });
});
