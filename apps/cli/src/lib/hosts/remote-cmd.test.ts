import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import {
  stripRoutingFlags,
  buildRemoteAgentsInvocation,
  buildWindowsAgentsCommand,
  buildWindowsStdinImportCommand,
  remoteShellFor,
  powershellQuote,
  decodePowershell,
  HOST_ROUTING_SPECS,
  type StripSpec,
} from './remote-cmd.js';

/** Decode the PowerShell script a Windows `--host` invocation ships, by pulling
 * the base64 payload off `powershell -NoProfile -EncodedCommand <b64>` and
 * reversing the UTF-16LE encoding — the exact bytes the remote PowerShell runs. */
function decodeWindows(cmd: string): string {
  const m = cmd.match(/^powershell -NoProfile -EncodedCommand (\S+)$/);
  expect(m, `not an encoded PowerShell command: ${cmd}`).not.toBeNull();
  return decodePowershell(m![1]);
}

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

  it('drops the --device alias and its value so it never leaks to the remote binary', () => {
    // --device is an alias of --host; forwarding it would re-trigger routing on
    // the remote (which only knows --host). Both space and =value forms go.
    expect(stripRoutingFlags(['message', 'abc', 'hi', '--device', 'yosemite-s0'], SPECS)).toEqual([
      'message',
      'abc',
      'hi',
    ]);
    expect(stripRoutingFlags(['message', 'abc', 'hi', '--device=yosemite-s0'], SPECS)).toEqual([
      'message',
      'abc',
      'hi',
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

describe('secrets export --host push command (cross-platform)', () => {
  // The keychain export push drives `agents secrets import --from -` on the
  // remote (`--from -` reads the .env off ssh stdin — the cross-platform
  // replacement for the POSIX-only `/dev/stdin`; `import` auto-creates the
  // bundle so there is no `create … || true`, the POSIXism that broke on
  // PowerShell with `'true' is not recognized`).
  const importArgs = ['secrets', 'import', 'mybundle', '--from', '-'];

  it('POSIX target: bash -lc agents secrets import --from - (no /dev/stdin, no || true)', () => {
    // The remote actually receives these exact argv entries (shim round-trip).
    expect(decodeRemoteArgv(importArgs)).toEqual(['secrets', 'import', 'mybundle', '--from', '-']);
    const cmd = buildRemoteAgentsInvocation(importArgs, undefined, 'linux');
    expect(cmd).toBe(`bash -lc 'agents secrets import mybundle --from -'`);
    expect(cmd).not.toContain('/dev/stdin');
    expect(cmd).not.toContain('|| true');
  });

  it('Windows target: PowerShell EncodedCommand runs the same import (no bash, no /dev/stdin)', () => {
    const cmd = buildRemoteAgentsInvocation(importArgs, undefined, 'windows');
    const script = decodeWindows(cmd);
    expect(script).toBe(`& 'agents' 'secrets' 'import' 'mybundle' '--from' '-'; exit $LASTEXITCODE`);
    expect(script).not.toContain('/dev/stdin');
    expect(script).not.toContain('|| true');
    expect(script).not.toContain('bash');
  });
});

describe('remoteShellFor', () => {
  it('maps Windows platform/OS strings to PowerShell', () => {
    for (const os of ['windows', 'Windows', 'win32', 'WIN32']) {
      expect(remoteShellFor(os)).toBe('powershell');
    }
  });

  it('defaults every non-Windows / unknown / absent OS to POSIX', () => {
    for (const os of ['linux', 'Linux', 'darwin', 'macos', 'Darwin', 'unknown', '', undefined]) {
      expect(remoteShellFor(os as string | undefined)).toBe('posix');
    }
  });
});

describe('powershellQuote', () => {
  it('wraps in single quotes and doubles embedded single quotes', () => {
    expect(powershellQuote('agents')).toBe("'agents'");
    expect(powershellQuote("it's")).toBe("'it''s'");
    // `$()`, `;`, and spaces are all literal inside a single-quoted PS string.
    expect(powershellQuote('$(whoami); rm')).toBe("'$(whoami); rm'");
  });
});

describe('buildRemoteAgentsInvocation — POSIX targets stay byte-identical', () => {
  it('produces the same bash -lc string for undefined and non-Windows OS', () => {
    const base = buildRemoteAgentsInvocation(['view', 'claude']);
    expect(base).toBe("bash -lc 'agents view claude'");
    expect(buildRemoteAgentsInvocation(['view', 'claude'], undefined, 'linux')).toBe(base);
    expect(buildRemoteAgentsInvocation(['view', 'claude'], undefined, 'darwin')).toBe(base);
    expect(buildRemoteAgentsInvocation(['view', 'claude'], undefined, 'macos')).toBe(base);
  });

  it('keeps the cd prefix for --remote-cwd on POSIX unchanged', () => {
    expect(buildRemoteAgentsInvocation(['view'], '/srv/app')).toBe("bash -lc 'cd /srv/app && agents view'");
  });

  it('still round-trips through a real bash login shell (no OS = POSIX)', () => {
    expect(decodeRemoteArgv(['view', 'claude'])).toEqual(['view', 'claude']);
  });
});

describe('buildRemoteAgentsInvocation — Windows targets speak PowerShell', () => {
  it('emits powershell -EncodedCommand instead of bash -lc', () => {
    const cmd = buildRemoteAgentsInvocation(['view', 'claude'], undefined, 'windows');
    expect(cmd.startsWith('powershell -NoProfile -EncodedCommand ')).toBe(true);
    expect(cmd).not.toContain('bash -lc');
    expect(decodeWindows(cmd)).toBe("& 'agents' 'view' 'claude'; exit $LASTEXITCODE");
  });

  it('prefixes Set-Location for --remote-cwd', () => {
    const cmd = buildRemoteAgentsInvocation(['view'], 'C:\\srv\\app', 'windows');
    expect(decodeWindows(cmd)).toBe("Set-Location -LiteralPath 'C:\\srv\\app'; & 'agents' 'view'; exit $LASTEXITCODE");
  });

  it('neutralizes injection — metacharacters are literal inside single quotes', () => {
    const cmd = buildRemoteAgentsInvocation(['view', '$(whoami); rm -rf /', '--json'], undefined, 'windows');
    expect(decodeWindows(cmd)).toBe("& 'agents' 'view' '$(whoami); rm -rf /' '--json'; exit $LASTEXITCODE");
  });

  it('carries env vars as $env: assignments (buildWindowsAgentsCommand)', () => {
    const cmd = buildWindowsAgentsCommand({
      args: ['sessions', '--active', '--json'],
      env: { AGENTS_SESSIONS_LOCAL: '1', COLUMNS: '120' },
    });
    expect(decodeWindows(cmd)).toBe(
      "$env:AGENTS_SESSIONS_LOCAL = '1'; $env:COLUMNS = '120'; & 'agents' 'sessions' '--active' '--json'; exit $LASTEXITCODE",
    );
  });

  it('can drop the exit-code propagation for sentinel-based probes', () => {
    const cmd = buildWindowsAgentsCommand({ args: ['--version'], propagateExit: false });
    expect(decodeWindows(cmd)).toBe("& 'agents' '--version'");
  });
});

describe('buildWindowsStdinImportCommand', () => {
  it('bridges ssh stdin through a temp file (never a hanging --from -)', () => {
    const script = decodeWindows(buildWindowsStdinImportCommand('linear.app', { force: true }));
    // Reads the piped .env in PowerShell (the shim can't forward stdin to node).
    expect(script).toContain('[Console]::In.ReadToEnd()');
    expect(script).toContain('[System.IO.Path]::GetTempFileName()');
    // Imports from the temp FILE, not stdin — a plain file read the shim handles.
    expect(script).toContain('agents secrets import \'linear.app\' --from $tmp --force');
    expect(script).not.toContain('--from -');
    // Temp file is always cleaned up, and the import's exit code propagates.
    expect(script).toContain('Remove-Item -LiteralPath $tmp -Force');
    expect(script).toContain('exit $code');
  });

  it('omits --force when not requested', () => {
    const script = decodeWindows(buildWindowsStdinImportCommand('linear.app'));
    expect(script).toContain('agents secrets import \'linear.app\' --from $tmp;');
    expect(script).not.toContain('--force');
  });
});
