import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import {
  buildForwardedArgs,
  buildRemoteCommand,
  shellQuote,
  assertValidSshTarget,
  classifySshFailure,
  remoteCachePath,
  formatStaleBanner,
  formatUnreachable,
} from './remote.js';

/**
 * Decode the argv the *remote* would actually receive. `buildRemoteCommand` emits
 * `bash -lc '<...>'`; ssh hands that to the remote login shell, which runs it. We
 * reproduce that exactly: an outer bash defines+exports an `agents` shim (exported
 * functions survive the nested `bash -lc` via the environment), then runs the
 * command. The shim prints each arg on its own line, so stdout == the remote argv.
 * This is the true end-to-end check of the two-layer quoting (injection-safety).
 */
function decodeRemoteArgv(forwarded: string[]): string[] {
  const shim = `agents() { for a in "$@"; do printf '%s\\n' "$a"; done; }; export -f agents; `;
  const res = spawnSync('bash', ['-c', shim + buildRemoteCommand(forwarded)], { encoding: 'utf-8' });
  expect(res.status).toBe(0);
  return res.stdout.split('\n').slice(0, -1); // drop trailing empty from final newline
}

// argv as the runtime hands it to us: [runtime, script, 'sessions', ...userArgs]
const argv = (...userArgs: string[]) => ['/usr/bin/bun', '/path/agents', ...userArgs];

describe('buildForwardedArgs', () => {
  it('drops --host with a separate value but keeps everything else in order', () => {
    expect(buildForwardedArgs(argv('sessions', 'auth bug', '--last', '3', '--host', 'yosemite-s1')))
      .toEqual(['sessions', 'auth bug', '--last', '3']);
  });

  it('drops the --host=value form', () => {
    expect(buildForwardedArgs(argv('sessions', '--host=yosemite-s1', '--json', 'query')))
      .toEqual(['sessions', '--json', 'query']);
  });

  it('drops the -H short flag and its value', () => {
    expect(buildForwardedArgs(argv('sessions', '-H', 'box', '--since', '2h')))
      .toEqual(['sessions', '--since', '2h']);
  });

  it('drops the glued -Hvalue short form', () => {
    expect(buildForwardedArgs(argv('sessions', '-Hyosemite-s1', 'query')))
      .toEqual(['sessions', 'query']);
  });

  it('keeps a query that legitimately contains the word host', () => {
    expect(buildForwardedArgs(argv('sessions', 'fix the host header bug', '--host', 'box')))
      .toEqual(['sessions', 'fix the host header bug']);
  });

  it('forwards subcommands like tail verbatim', () => {
    expect(buildForwardedArgs(argv('sessions', 'tail', '--latest', '--host', 'box')))
      .toEqual(['sessions', 'tail', '--latest']);
  });

  it('strips every host in the variadic --host a b form (not just the first)', () => {
    // Commander's `<target...>` lets `--host box1 box2` set host=['box1','box2'].
    // Without the known-host set the scan would only drop box1 and leak box2
    // into the remote query. Passing the set strips both.
    expect(
      buildForwardedArgs(
        argv('sessions', 'auth bug', '--host', 'box1', 'box2', '--json'),
        new Set(['box1', 'box2']),
      ),
    ).toEqual(['sessions', 'auth bug', '--json']);
  });

  it('strips repeated --host flags when given the host set', () => {
    expect(
      buildForwardedArgs(
        argv('sessions', 'auth bug', '--host', 'box1', '--host', 'box2'),
        new Set(['box1', 'box2']),
      ),
    ).toEqual(['sessions', 'auth bug']);
  });

  it('stops consuming at the first token that is not a known host', () => {
    // The scan only swallows consecutive tokens present in the host set; a
    // trailing non-host token ('auth') is preserved rather than over-consumed.
    expect(
      buildForwardedArgs(
        argv('sessions', '--host', 'box1', 'box2', 'auth'),
        new Set(['box1', 'box2']),
      ),
    ).toEqual(['sessions', 'auth']);
  });
});

describe('shellQuote', () => {
  it('wraps a plain word in single quotes', () => {
    expect(shellQuote('agents')).toBe("'agents'");
  });

  it('escapes embedded single quotes (the injection-prone case)', () => {
    // A query carrying a single quote must not break out of the quoting.
    expect(shellQuote("o'brien")).toBe("'o'\\''brien'");
  });
});

describe('buildRemoteCommand', () => {
  it('wraps the invocation in bash -lc so the remote login PATH resolves agents', () => {
    expect(buildRemoteCommand(['sessions', 'q']).startsWith('bash -lc ')).toBe(true);
  });

  it('reconstructs the exact argv on the remote through both shell layers', () => {
    expect(decodeRemoteArgv(['sessions', 'auth bug', '--last', '3']))
      .toEqual(['sessions', 'auth bug', '--last', '3']);
  });

  it('keeps a query with a single quote injection-safe (no early quote-break)', () => {
    // A naive escaper lets the apostrophe close the outer quote and split the arg.
    expect(decodeRemoteArgv(['sessions', "it's broken"]))
      .toEqual(['sessions', "it's broken"]);
  });

  it('neutralizes shell metacharacters in a query (no command substitution)', () => {
    expect(decodeRemoteArgv(['sessions', '$(whoami); rm -rf /', '--json']))
      .toEqual(['sessions', '$(whoami); rm -rf /', '--json']);
  });
});

describe('assertValidSshTarget', () => {
  it('accepts a bare host alias and user@host', () => {
    expect(() => assertValidSshTarget('yosemite-s1')).not.toThrow();
    expect(() => assertValidSshTarget('deploy@staging.example.com')).not.toThrow();
  });

  it('rejects a leading dash (argv flag smuggling) and shell metacharacters', () => {
    expect(() => assertValidSshTarget('-oProxyCommand=evil')).toThrow(/Invalid SSH target/);
    expect(() => assertValidSshTarget('box; rm -rf /')).toThrow(/Invalid SSH target/);
    expect(() => assertValidSshTarget('box$(whoami)')).toThrow(/Invalid SSH target/);
  });
});

describe('classifySshFailure', () => {
  it('maps a clean exit to ok', () => {
    expect(classifySshFailure({ status: 0 })).toBe('ok');
  });

  it('maps ssh exit 255 to unreachable (connection layer, not the remote query)', () => {
    // 255 is ssh's own code for "could not establish the session" — the cache
    // fallback hinges on telling this apart from a forwarded non-zero.
    expect(classifySshFailure({ status: 255 })).toBe('unreachable');
  });

  it('maps any other non-zero to query-failed (remote agents ran and failed)', () => {
    expect(classifySshFailure({ status: 1 })).toBe('query-failed');
    expect(classifySshFailure({ status: 2 })).toBe('query-failed');
    expect(classifySshFailure({ status: null })).toBe('query-failed'); // killed by signal
  });

  it('maps a spawn error (ssh binary missing, etc.) to spawn-error', () => {
    expect(classifySshFailure({ error: new Error('ENOENT'), status: null })).toBe('spawn-error');
  });
});

describe('remoteCachePath', () => {
  it('is deterministic for the same host and args', () => {
    const a = remoteCachePath('mac-mini', ['sessions', '--last', '3']);
    const b = remoteCachePath('mac-mini', ['sessions', '--last', '3']);
    expect(a).toBe(b);
  });

  it('separates distinct queries into distinct files', () => {
    const a = remoteCachePath('mac-mini', ['sessions', '--last', '3']);
    const b = remoteCachePath('mac-mini', ['sessions', '--last', '5']);
    expect(a).not.toBe(b);
  });

  it('separates distinct hosts even for the same query', () => {
    const a = remoteCachePath('box-a', ['sessions', 'auth']);
    const b = remoteCachePath('box-b', ['sessions', 'auth']);
    expect(a).not.toBe(b);
  });

  it('keeps the host readable but filesystem-safe in the filename', () => {
    // user@host is a valid ssh target; the path segment must not contain a
    // separator or other unsafe char that would escape the cache dir.
    const p = remoteCachePath('deploy@staging.example.com', ['sessions']);
    const file = p.split('/').pop()!;
    expect(file.startsWith('deploy@staging.example.com__')).toBe(true);
    expect(file.endsWith('.txt')).toBe(true);
  });
});

describe('offline banners', () => {
  it('stale banner names the host and how old the cache is', () => {
    const twoHoursAgo = new Date('2026-06-29T00:00:00Z').getTime() - 2 * 3_600_000;
    const msg = formatStaleBanner('mac-mini', twoHoursAgo);
    expect(msg).toContain('mac-mini');
    expect(msg.toLowerCase()).toContain('cached');
  });

  it('unreachable message names the host and the cause', () => {
    const msg = formatUnreachable('mac-mini');
    expect(msg).toContain('mac-mini');
    expect(msg.toLowerCase()).toContain('unreachable');
  });
});
