/**
 * RUSH-2639: the vitest suite must be structurally unable to touch the
 * developer's REAL ~/.agents (or ~/.claude, ~/.codex, ...) — not "unlikely
 * to" because a hot spot happens to have its own escape hatch, but literally
 * unable to, because tests/setup.ts redirects HOME itself before any test
 * file's imports run (see the RUSH-2639 comment block there).
 *
 * These assertions FAIL on the pre-fix setup.ts (which pinned only specific
 * sub-paths — AGENTS_DEVICES_DIR, AGENTS_EVENTS_PATH, ... — and left HOME
 * itself untouched) and PASS once HOME is redirected.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { getHomeDir, getUserAgentsDir } from '../src/lib/state.js';

describe('vitest HOME sandbox (RUSH-2639)', () => {
  it('process.env.HOME is redirected to a fork-private sandbox, not the real OS home', () => {
    const home = process.env.HOME;
    expect(home).toBeTruthy();
    // The real OS-reported home for this uid, ignoring any env override —
    // what a leaking test would resolve into on unfixed code.
    const realOsHome = os.userInfo().homedir;
    expect(home).not.toBe(realOsHome);
    expect(path.basename(path.dirname(home as string))).toMatch(/^agents-vitest-/);
  });

  it('state.ts captured the sandboxed HOME at import time, not the real home', () => {
    const realOsHome = os.userInfo().homedir;
    expect(getHomeDir()).toBe(process.env.HOME);
    expect(getUserAgentsDir()).toBe(path.join(process.env.HOME as string, '.agents'));
    expect(getUserAgentsDir()).not.toBe(path.join(realOsHome, '.agents'));
  });

  it('a naive subprocess spawn (env: {...process.env}) inherits the sandboxed HOME for free', () => {
    // This is the exact shape of the historical bug class: a test spawns the
    // CLI (or any subprocess) with the parent env spread verbatim and never
    // thinks about HOME at all. Before this fix that meant "whatever the
    // developer's real HOME happens to be"; after it, the child inherits the
    // already-sandboxed HOME with zero per-test effort.
    const out = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.HOME || "")'],
      { env: { ...process.env } },
    ).toString();
    expect(out).toBe(process.env.HOME);
  });
});
