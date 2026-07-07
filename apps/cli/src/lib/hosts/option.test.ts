import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { addHostOption } from './option.js';

/**
 * `--device` is an alias of `--host` consumed pre-parse by maybeRunOnHost for a
 * REMOTE target. But the self-machine fall-through (maybeRunOnHost returns
 * false) hands the flag to commander, so the flag MUST be registered here or a
 * local `--device <this-machine>` errors with "unknown option". maybeRunOnHost's
 * own unit tests can't catch that — they return before commander parses — so the
 * guard lives at this layer.
 */
describe('addHostOption', () => {
  function build(): Command {
    return addHostOption(new Command('view')).exitOverride();
  }

  it('registers --device so a local fall-through does not error on the alias', () => {
    const cmd = build();
    expect(() => cmd.parse(['--device', 'mybox'], { from: 'user' })).not.toThrow();
    expect(cmd.opts().device).toBe('mybox');
  });

  it('keeps --host and its family (-H/--remote-cwd/--any) working', () => {
    const cmd = build();
    expect(() => cmd.parse(['-H', 'mac', '--remote-cwd', '/srv', '--any'], { from: 'user' })).not.toThrow();
    const o = cmd.opts();
    expect(o.host).toBe('mac');
    expect(o.remoteCwd).toBe('/srv');
    expect(o.any).toBe(true);
  });
});
