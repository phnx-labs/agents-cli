/**
 * Tests for the `agents watchdog` command surface (RUSH-1415).
 *
 * Focus: `watchdog status --json` — the read the Swift menu-bar helper decodes to
 * drive its auto-nudge toggle. The parent `watchdog` command ALSO declares --json
 * and greedily parses it before dispatching to `status`, so the flag lands on the
 * parent, not the subcommand. The action reads it via optsWithGlobals(); if that
 * regressed to plain opts.json, `status --json` would silently emit human text and
 * the Swift JSONDecoder would get nothing. These tests lock that behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerWatchdogCommand } from './watchdog.js';

/** Run `agents watchdog <args...>`, capturing stdout lines the action prints. */
async function runWatchdog(args: string[]): Promise<string[]> {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit on parse errors
  registerWatchdogCommand(program);

  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    await program.parseAsync(['node', 'agents', 'watchdog', ...args]);
  } finally {
    console.log = orig;
  }
  return lines;
}

describe('watchdog status --json', () => {
  let origLog: typeof console.log;
  beforeEach(() => { origLog = console.log; });
  afterEach(() => { console.log = origLog; });

  it('emits a single JSON object with a boolean `enabled` and a `stateDir`', async () => {
    const lines = await runWatchdog(['status', '--json']);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { enabled: unknown; stateDir: unknown };
    expect(typeof parsed.enabled).toBe('boolean');
    expect(typeof parsed.stateDir).toBe('string');
    expect((parsed.stateDir as string).length).toBeGreaterThan(0);
  });

  it('without --json prints human text, not JSON', async () => {
    const lines = await runWatchdog(['status']);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // The human path is two lines starting with the enable-state label.
    expect(lines[0]).toContain('global auto-nudge');
    expect(() => JSON.parse(lines[0])).toThrow();
  });
});
