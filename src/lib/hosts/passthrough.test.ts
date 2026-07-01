import { describe, it, expect, afterEach } from 'vitest';
import { flagValue, maybeRunOnHost } from './passthrough.js';
import { machineId } from '../session/sync/config.js';

describe('flagValue', () => {
  it('reads the space-separated long form', () => {
    expect(flagValue(['view', '--host', 'mac'], 'host', 'H')).toBe('mac');
  });
  it('reads the --host=value form', () => {
    expect(flagValue(['view', '--host=mac'], 'host', 'H')).toBe('mac');
  });
  it('reads the -H value and glued -Hmac forms', () => {
    expect(flagValue(['view', '-H', 'mac'], 'host', 'H')).toBe('mac');
    expect(flagValue(['view', '-Hmac'], 'host', 'H')).toBe('mac');
  });
  it('reads --remote-cwd (long-only, no short)', () => {
    expect(flagValue(['sync', '--remote-cwd', '/srv'], 'remote-cwd')).toBe('/srv');
  });
  it('returns undefined when absent', () => {
    expect(flagValue(['view', '--json'], 'host', 'H')).toBeUndefined();
  });
});

describe('maybeRunOnHost — local short-circuits (no SSH attempted)', () => {
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
  });

  it('returns false when the command is not host-routable', async () => {
    expect(await maybeRunOnHost('secrets', ['secrets', 'list', '--host', 'mac'])).toBe(false);
  });

  it('returns false when no --host is given', async () => {
    expect(await maybeRunOnHost('view', ['view', 'claude'])).toBe(false);
  });

  it('returns false when --host names this very machine (runs locally instead)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    expect(machineId()).toBe('mybox');
    expect(await maybeRunOnHost('view', ['view', '--host', 'mybox'])).toBe(false);
    // case-insensitive: the self-check must not SSH to `MyBox` either
    expect(await maybeRunOnHost('view', ['view', '--host', 'MyBox'])).toBe(false);
  });
});
