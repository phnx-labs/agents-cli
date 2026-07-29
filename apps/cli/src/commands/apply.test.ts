import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { stripPad, registerApplyCommand, registerFleetApplyAlias } from './apply.js';

// A real SGR-wrapped cell as chalk emits it: ESC `[32m` ... ESC `[39m`.
const ESC = '\x1b';
const colored = `${ESC}[32mok 2/2${ESC}[39m`;
const strip = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

describe('stripPad', () => {
  it('pads to the visible width, counting the full ANSI escape (ESC byte included) as zero-width', () => {
    // 'ok 2/2' renders as 6 columns; padded to 12 the terminal must show 12.
    // The pre-fix regex `/\[[0-9;]*m/` left each ESC byte counted as visible,
    // so a colored cell under-padded by the number of escapes (here, 2).
    const out = stripPad(colored, 12);
    expect(strip(out).length).toBe(12);
    expect(strip(out)).toBe('ok 2/2      ');
  });

  it('pads a plain (uncolored) cell correctly', () => {
    expect(stripPad('hi', 5)).toBe('hi   ');
  });

  it('always adds at least one trailing space, even when already at/over width', () => {
    expect(stripPad('toolong', 4)).toBe('toolong ');
  });
});

describe('fleet apply alias', () => {
  it('registers `apply` under the fleet/devices tree with options identical to top-level `agents apply`', () => {
    const program = new Command();
    registerApplyCommand(program);
    const top = program.commands.find((c) => c.name() === 'apply');
    expect(top).toBeDefined();

    const devices = program.command('devices');
    registerFleetApplyAlias(devices);
    const sub = devices.commands.find((c) => c.name() === 'apply');
    expect(sub).toBeDefined();

    // The alias must never drift from the real command — same flags, same engine.
    const longFlags = (c: Command) => c.options.map((o) => o.long).sort();
    expect(longFlags(sub!)).toEqual(longFlags(top!));
  });
});
