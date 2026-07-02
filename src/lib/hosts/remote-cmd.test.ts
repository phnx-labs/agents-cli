import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import {
  stripRoutingFlags,
  buildRemoteAgentsInvocation,
  HOST_ROUTING_SPECS,
  type StripSpec,
} from './remote-cmd.js';

const SPECS: StripSpec[] = [...HOST_ROUTING_SPECS, { long: 'no-tty', takesValue: false }];

/**
 * Decode the argv the *remote* would actually receive. `buildRemoteAgentsInvocation`
 * emits `bash -lc '<...>'`; ssh hands that to the remote login shell, which runs it.
 * We reproduce that exactly with an `agents` shim that prints each arg on its own
 * line, so stdout == the remote argv — the true end-to-end check of the two-layer
 * quoting (injection-safety).
 */
function decodeRemoteArgv(forwarded: string[], remoteCwd?: string): string[] {
  const shim = `agents() { for a in "$@"; do printf '%s\\n' "$a"; done; }; export -f agents; cd /; `;
  const res = spawnSync('bash', ['-c', shim + buildRemoteAgentsInvocation(forwarded, remoteCwd)], {
    encoding: 'utf-8',
  });
  expect(res.status).toBe(0);
  return res.stdout.split('\n').slice(0, -1);
}

describe('stripRoutingFlags', () => {
  it('keeps the command name and drops --host with a separate value', () => {
    expect(stripRoutingFlags(['view', '--host', 'mac', 'claude'], SPECS)).toEqual(['view', 'claude']);
  });

  it('drops the --host=value glued form', () => {
    expect(stripRoutingFlags(['view', '--host=mac', '--json'], SPECS)).toEqual(['view', '--json']);
  });

  it('drops -H with a separate value and the glued short form', () => {
    expect(stripRoutingFlags(['view', '-H', 'mac'], SPECS)).toEqual(['view']);
    expect(stripRoutingFlags(['view', '-Hmac', '--json'], SPECS)).toEqual(['view', '--json']);
  });

  it('drops --remote-cwd and its value but keeps other flags in order', () => {
    expect(stripRoutingFlags(['sync', 'claude', '--remote-cwd', '/srv/app', '--yes'], SPECS)).toEqual([
      'sync',
      'claude',
      '--yes',
    ]);
  });

  it('drops the valueless --no-tty without consuming the next token', () => {
    expect(stripRoutingFlags(['view', '--no-tty', 'claude'], SPECS)).toEqual(['view', 'claude']);
  });

  it('does not mistake a positional that merely contains "host" for the flag', () => {
    expect(stripRoutingFlags(['teams', 'add', 't', 'claude', 'fix the host header', '--host', 'mac'], SPECS)).toEqual([
      'teams',
      'add',
      't',
      'claude',
      'fix the host header',
    ]);
  });
});

describe('buildRemoteAgentsInvocation (two-layer quoting is injection-safe)', () => {
  it('round-trips ordinary args through ssh + bash -lc unchanged', () => {
    expect(decodeRemoteArgv(['view', 'claude'])).toEqual(['view', 'claude']);
  });

  it('preserves args with spaces as single argv entries', () => {
    expect(decodeRemoteArgv(['teams', 'add', 't', 'claude', 'refactor the parser'])).toEqual([
      'teams',
      'add',
      't',
      'claude',
      'refactor the parser',
    ]);
  });

  it('neutralizes shell metacharacters — no command substitution executes', () => {
    expect(decodeRemoteArgv(['view', '$(whoami); rm -rf /', '--json'])).toEqual([
      'view',
      '$(whoami); rm -rf /',
      '--json',
    ]);
  });

  it('prefixes a cd for --remote-cwd without leaking it into argv', () => {
    // The shim's cwd change is observable only via the cd prefix; argv stays clean.
    expect(decodeRemoteArgv(['view'], '/tmp')).toEqual(['view']);
  });
});
