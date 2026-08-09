import { describe, it, expect } from 'vitest';
import { flagValue, hasHostRoutingFlag } from './routing-flag.js';

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

describe('hasHostRoutingFlag', () => {
  it('is false for ordinary local argvs (the majority path bootstrap must skip)', () => {
    expect(hasHostRoutingFlag(['view'])).toBe(false);
    expect(hasHostRoutingFlag(['sync', 'claude', '--yes'])).toBe(false);
    expect(hasHostRoutingFlag(['skills', 'list'])).toBe(false);
    expect(hasHostRoutingFlag(['doctor'])).toBe(false);
    expect(
      hasHostRoutingFlag([
        'run',
        'claude',
        '--mode',
        'edit',
        '--name',
        'bench',
        '--profile',
        'default',
        '-p',
        'do the thing',
        '--json',
      ]),
    ).toBe(false);
  });

  it('is true for every form maybeRunOnHost accepts', () => {
    expect(hasHostRoutingFlag(['view', '--host', 'box'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '--host=box'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '-H', 'box'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '-Hbox'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '--device', 'box'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '--device=box'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '--hosts', 'all'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '--hosts=all'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '--devices', 'all'])).toBe(true);
    expect(hasHostRoutingFlag(['view', '--devices=all'])).toBe(true);
  });

  it('does not treat --remote-cwd alone as a routing flag (local-only companion)', () => {
    // remote-cwd is only meaningful with --host/--device; alone it must not
    // force-load the passthrough graph on a pure-local invocation.
    expect(hasHostRoutingFlag(['view', '--remote-cwd', '/srv'])).toBe(false);
  });
});
