import { describe, it, expect } from 'vitest';
import {
  parseReadyProbe,
  viewHasAgent,
  buildProbeCommand,
  buildRemoteVersionCommand,
  buildBootstrapCommand,
  buildReadyProbeCommand,
} from './ready.js';
import { decodePowershell } from './remote-cmd.js';

const MARK = '@@AGENTS_READY@@';

/** Decode the PowerShell script off a `-EncodedCommand` remote command. */
function decodeWindows(cmd: string): string {
  const m = cmd.match(/^powershell -NoProfile -EncodedCommand (\S+)$/);
  expect(m, `not an encoded PowerShell command: ${cmd}`).not.toBeNull();
  return decodePowershell(m![1]);
}

describe('parseReadyProbe', () => {
  it('parses version + agent listing from one compound probe', () => {
    const stdout = `2.1.170\n${MARK}\nClaude (balanced)\nCodex (balanced)\n`;
    const p = parseReadyProbe(stdout);
    expect(p.reachable).toBe(true);
    expect(p.version).toBe('2.1.170');
    expect(p.view).toContain('Claude');
  });

  it('strips a leading v from the version', () => {
    expect(parseReadyProbe(`v2.1.170\n${MARK}\nClaude`).version).toBe('2.1.170');
  });

  it('reports reachable-but-not-installed when the version half is empty', () => {
    // agents-cli missing: `agents --version` printed nothing, but the login
    // shell still ran our printf so the marker (and thus reachability) is intact.
    const p = parseReadyProbe(`\n${MARK}\n`);
    expect(p.reachable).toBe(true);
    expect(p.version).toBeNull();
  });

  it('treats a missing marker as unreachable (ssh never ran our shell)', () => {
    const p = parseReadyProbe('');
    expect(p.reachable).toBe(false);
    expect(p.version).toBeNull();
    expect(p.view).toBe('');
  });
});

describe('viewHasAgent', () => {
  const view = 'Claude (balanced) 2.1.170\nCodex (balanced) 0.134.0';
  it('matches an installed agent case-insensitively', () => {
    expect(viewHasAgent(view, 'claude')).toBe(true);
    expect(viewHasAgent(view, 'codex')).toBe(true);
  });
  it('does not match an absent agent', () => {
    expect(viewHasAgent(view, 'gemini')).toBe(false);
  });
});

describe('ready commands — POSIX branch unchanged', () => {
  it('probe uses uname, version/readyProbe/bootstrap use bash -lc', () => {
    expect(buildProbeCommand()).toBe('uname -s 2>/dev/null || echo unknown');
    expect(buildProbeCommand('linux')).toBe('uname -s 2>/dev/null || echo unknown');
    expect(buildRemoteVersionCommand('darwin')).toBe('bash -lc "agents --version 2>/dev/null"');
    expect(buildReadyProbeCommand()).toBe(
      `bash -lc 'agents --version 2>/dev/null; printf '\\''\\n${MARK}\\n'\\''; agents view 2>/dev/null || agents list 2>/dev/null'`,
    );
    expect(buildBootstrapCommand('@phnx-labs/agents-cli@2.1.170')).toBe(
      "bash -lc 'npm install -g @phnx-labs/agents-cli@2.1.170 2>&1 | tail -3; " +
        "if [ ! -d ~/.agents/.system ]; then agents setup 2>&1 | tail -3 || true; fi; agents --version'",
    );
  });
});

describe('ready commands — Windows branch speaks PowerShell', () => {
  it('probe runs a PowerShell OS check instead of uname', () => {
    const cmd = buildProbeCommand('windows');
    expect(cmd).not.toContain('uname');
    expect(decodeWindows(cmd)).toBe('[System.Environment]::OSVersion.Platform.ToString()');
  });

  it('version probe runs `agents --version` via PowerShell', () => {
    expect(decodeWindows(buildRemoteVersionCommand('windows'))).toBe("& 'agents' '--version'; exit $LASTEXITCODE");
  });

  it('readyProbe emits the sentinel with Write-Output and branches on $LASTEXITCODE', () => {
    // Parser keys off the sentinel substring — this output must still parse.
    const script = decodeWindows(buildReadyProbeCommand('windows'));
    expect(script).toBe(
      `agents --version 2>$null; Write-Output "${MARK}"; agents view 2>$null; if ($LASTEXITCODE -ne 0) { agents list 2>$null }`,
    );
    // The script's stdout shape (marker on its own line) round-trips through parseReadyProbe.
    const p = parseReadyProbe(`2.1.170\n${MARK}\nClaude (balanced)\n`);
    expect(p.reachable).toBe(true);
    expect(p.version).toBe('2.1.170');
  });

  it('bootstrap uses Select-Object -Last / Test-Path, never tail / [ -d ]', () => {
    const script = decodeWindows(buildBootstrapCommand('@phnx-labs/agents-cli@2.1.170', 'windows'));
    expect(script).toBe(
      "npm install -g '@phnx-labs/agents-cli@2.1.170' 2>&1 | Select-Object -Last 3; " +
        'if (-not (Test-Path "$HOME/.agents/.system")) { agents setup 2>&1 | Select-Object -Last 3 }; agents --version',
    );
    expect(script).not.toContain('tail -3');
    expect(script).not.toContain('[ ! -d');
  });
});
