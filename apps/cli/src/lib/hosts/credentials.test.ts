import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildHostCredentialScript, wrapHostCommandWithCredentials } from './credentials.js';
import type { DetectedRuntime } from '../crabbox/runtimes.js';

function tempCredFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-creds-'));
  const file = path.join(dir, 'cred.json');
  fs.writeFileSync(file, contents);
  return file;
}

describe('buildHostCredentialScript', () => {
  it('writes credentials and shreds the expected paths for each runtime', () => {
    const detected: DetectedRuntime[] = [
      {
        id: 'claude',
        label: 'Claude Code',
        email: 'a@b.com',
        signedIn: true,
        credPath: tempCredFile('{"account":"claude"}'),
      },
      {
        id: 'codex',
        label: 'Codex CLI',
        email: null,
        signedIn: true,
        credPath: tempCredFile('{"account":"codex"}'),
      },
    ];

    const { setup, teardown } = buildHostCredentialScript({
      runtimes: ['claude', 'codex'],
      detected,
      claudeCredentialsJson: '{"claudeAiOauth":{"accessToken":"abc"}}',
    });

    expect(setup).toContain('cat > "$HOME/.claude.json"');
    expect(setup).toContain('{"account":"claude"}');
    expect(setup).toContain('cat > "$HOME/.claude/.credentials.json"');
    expect(setup).toContain('{"claudeAiOauth":{"accessToken":"abc"}}');
    expect(setup).toContain('cat > "$HOME/.codex/auth.json"');
    expect(setup).toContain('{"account":"codex"}');

    expect(teardown).toContain('rm -f "$HOME/.claude.json"');
    expect(teardown).toContain('rm -f "$HOME/.claude/.credentials.json"');
    expect(teardown).toContain('rm -f "$HOME/.codex/auth.json"');
  });

  it('skips the claude OAuth token file when no token is provided', () => {
    const detected: DetectedRuntime[] = [
      {
        id: 'claude',
        label: 'Claude Code',
        email: 'a@b.com',
        signedIn: true,
        credPath: tempCredFile('{"account":"claude"}'),
      },
    ];

    const { setup } = buildHostCredentialScript({
      runtimes: ['claude'],
      detected,
    });
    expect(setup).toContain('cat > "$HOME/.claude.json"');
    expect(setup).not.toContain('cat > "$HOME/.claude/.credentials.json"');
  });
});

describe('wrapHostCommandWithCredentials', () => {
  it('wraps an inner command with credential setup, teardown, and exit-code capture', () => {
    const detected: DetectedRuntime[] = [
      {
        id: 'claude',
        label: 'Claude Code',
        email: 'a@b.com',
        signedIn: true,
        credPath: tempCredFile('{"account":"claude"}'),
      },
    ];

    const wrapped = wrapHostCommandWithCredentials('cd "$HOME"/proj && agents run claude "hi" --quiet', {
      runtimes: ['claude'],
      detected,
      claudeCredentialsJson: '{"claudeAiOauth":{"accessToken":"abc"}}',
    });

    expect(wrapped).toContain('set -uo pipefail');
    expect(wrapped).toContain('cat > "$HOME/.claude.json"');
    expect(wrapped).toContain('cat > "$HOME/.claude/.credentials.json"');
    expect(wrapped).toContain('cd "$HOME"/proj && agents run claude "hi" --quiet');
    expect(wrapped).toContain('rc=$?');
    expect(wrapped).toContain('rm -f "$HOME/.claude.json"');
    expect(wrapped).toContain('rm -f "$HOME/.claude/.credentials.json"');
    expect(wrapped).toContain('exit $rc');

    // Setup comes before the inner command, teardown after.
    expect(wrapped.indexOf('cat > "$HOME/.claude.json"')).toBeLessThan(
      wrapped.indexOf('agents run claude'),
    );
    expect(wrapped.indexOf('agents run claude')).toBeLessThan(wrapped.indexOf('rc=$?'));
    expect(wrapped.indexOf('rc=$?')).toBeLessThan(wrapped.indexOf('rm -f'));
  });
});
