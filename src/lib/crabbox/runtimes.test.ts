import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { buildCredentialScript, pickRuntimes, type DetectedRuntime } from './runtimes.js';

describe('buildCredentialScript', () => {
  let tmpDir: string;
  let claudeCred: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-cred-'));
    claudeCred = path.join(tmpDir, 'claude.json');
    fs.writeFileSync(claudeCred, '{"oauthAccount":{"emailAddress":"a@b.com"}}');
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('writes the picked runtime token via a quoted heredoc + chmod 600', () => {
    const detected: DetectedRuntime[] = [
      { id: 'claude', label: 'Claude Code', email: 'a@b.com', signedIn: true, credPath: claudeCred },
    ];
    const script = buildCredentialScript(['claude'], detected);
    expect(script).toContain('cat > "$HOME/.claude.json" <<');
    expect(script).toContain('{"oauthAccount":{"emailAddress":"a@b.com"}}');
    expect(script).toContain('chmod 600 "$HOME/.claude.json"');
    // Quoted heredoc delimiter → no shell expansion of the token body.
    expect(script).toMatch(/<<'AGENTS_LEASE_CRED_EOF_[0-9a-f]+'/);
  });

  it('skips runtimes with no local credential', () => {
    const detected: DetectedRuntime[] = [
      { id: 'codex', label: 'Codex CLI', email: null, signedIn: false, credPath: null },
    ];
    expect(buildCredentialScript(['codex'], detected)).toBe('');
  });

  it('creates the parent dir for nested remote paths (codex)', () => {
    const codexCred = path.join(tmpDir, 'codex.json');
    fs.writeFileSync(codexCred, '{"tokens":{}}');
    const detected: DetectedRuntime[] = [
      { id: 'codex', label: 'Codex CLI', email: 'x@y.com', signedIn: true, credPath: codexCred },
    ];
    const script = buildCredentialScript(['codex'], detected);
    expect(script).toContain('mkdir -p "$HOME/.codex"');
    expect(script).toContain('cat > "$HOME/.codex/auth.json" <<');
  });
});

describe('pickRuntimes', () => {
  const detected: DetectedRuntime[] = [
    { id: 'claude', label: 'Claude Code', email: 'a@b.com', signedIn: true, credPath: '/tmp/claude.json' },
    { id: 'codex', label: 'Codex CLI', email: null, signedIn: false, credPath: null },
  ];

  it('defaults the checkbox to signed-in runtimes that have a credential', async () => {
    let captured: any[] = [];
    await pickRuntimes(detected, async (choices) => {
      captured = choices;
      return choices.filter((c) => c.checked).map((c) => c.value);
    });
    const claude = captured.find((c) => c.value === 'claude');
    const codex = captured.find((c) => c.value === 'codex');
    expect(claude.checked).toBe(true);
    expect(codex.checked).toBe(false);
    // No local credential → disabled with an explanation.
    expect(typeof codex.disabled).toBe('string');
  });

  it('returns exactly the selected runtime ids', async () => {
    const picked = await pickRuntimes(detected, async () => ['claude']);
    expect(picked).toEqual(['claude']);
  });
});
