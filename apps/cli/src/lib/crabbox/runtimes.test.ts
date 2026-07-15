import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { buildCredentialScript, pickRuntimes, resolveClaudeCredentialsBlob, inferLeaseRuntime, type DetectedRuntime } from './runtimes.js';

describe('inferLeaseRuntime', () => {
  const signedIn = (id: DetectedRuntime['id'], email: string | null): DetectedRuntime => ({
    id, label: id, email, signedIn: true, credPath: `/tmp/${id}.json`,
  });

  it('uses the agent itself when it is a lease-capable runtime', () => {
    const detected = [signedIn('claude', 'a@b.com'), signedIn('grok', 'g@x.ai')];
    expect(inferLeaseRuntime('grok', detected)).toBe('grok');
    expect(inferLeaseRuntime('codex', [signedIn('codex', null)])).toBe('codex');
  });

  it('returns null when the named runtime is not signed in — never substitutes another', () => {
    // `run codex --lease` while only claude is signed in must NOT provision claude.
    expect(inferLeaseRuntime('codex', [signedIn('claude', 'a@b.com')])).toBeNull();
    expect(inferLeaseRuntime('grok', [
      { id: 'grok', label: 'Grok CLI', email: null, signedIn: false, credPath: null },
      signedIn('claude', 'a@b.com'),
    ])).toBeNull();
  });

  it('falls back to the signed-in runtime (preferring claude) for a custom agent', () => {
    const detected = [signedIn('claude', 'a@b.com'), signedIn('grok', 'g@x.ai')];
    expect(inferLeaseRuntime('my-workflow', detected)).toBe('claude');
  });

  it('falls back to the only signed-in runtime when claude is absent', () => {
    expect(inferLeaseRuntime('my-workflow', [signedIn('grok', 'g@x.ai')])).toBe('grok');
  });

  it('ignores runtimes with no local credential', () => {
    const detected: DetectedRuntime[] = [
      { id: 'claude', label: 'Claude Code', email: null, signedIn: true, credPath: null },
      signedIn('grok', 'g@x.ai'),
    ];
    expect(inferLeaseRuntime('my-workflow', detected)).toBe('grok');
  });

  it('returns null when nothing is signed in', () => {
    expect(inferLeaseRuntime('my-workflow', [])).toBeNull();
    expect(inferLeaseRuntime('my-workflow', [
      { id: 'claude', label: 'Claude Code', email: null, signedIn: false, credPath: null },
    ])).toBeNull();
  });
});

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

  it('writes .claude/.credentials.json (0600) alongside the config when a claude blob is supplied', () => {
    const detected: DetectedRuntime[] = [
      { id: 'claude', label: 'Claude Code', email: 'a@b.com', signedIn: true, credPath: claudeCred },
    ];
    const token = '{"claudeAiOauth":{"accessToken":"tok"}}';
    const script = buildCredentialScript(['claude'], detected, { claudeCredentialsJson: token });
    // config still copied...
    expect(script).toContain('cat > "$HOME/.claude.json" <<');
    // ...plus the token, which is what actually logs the box in.
    expect(script).toContain('mkdir -p "$HOME/.claude"');
    expect(script).toContain('cat > "$HOME/.claude/.credentials.json" <<');
    expect(script).toContain(token);
    expect(script).toContain('chmod 600 "$HOME/.claude/.credentials.json"');
  });

  it('omits the credentials write when no claude blob is supplied (back-compat)', () => {
    const detected: DetectedRuntime[] = [
      { id: 'claude', label: 'Claude Code', email: 'a@b.com', signedIn: true, credPath: claudeCred },
    ];
    expect(buildCredentialScript(['claude'], detected)).not.toContain('.credentials.json');
    expect(buildCredentialScript(['claude'], detected, { claudeCredentialsJson: null })).not.toContain('.credentials.json');
  });
});

describe('resolveClaudeCredentialsBlob', () => {
  const WRAPPED = '{"claudeAiOauth":{"accessToken":"tok"}}';
  // Only the darwin branch is unit-tested (the Linux branch reads a real file).
  const itDarwin = process.platform === 'darwin' ? it : it.skip;

  itDarwin('returns the bare-service payload for a default native install', async () => {
    const blob = await resolveClaudeCredentialsBlob({
      service: (home) => (home ? `svc-${home}` : 'bare'),
      readItem: (svc) => (svc === 'bare' ? WRAPPED : (() => { throw new Error('miss'); })()),
      listVersions: () => ['2.1.0'],
      versionHome: (v) => `/home/${v}`,
      accountEmail: async () => null,
    });
    expect(blob).toBe(WRAPPED);
  });

  itDarwin('falls back to a managed version home when the bare service misses', async () => {
    const blob = await resolveClaudeCredentialsBlob({
      service: (home) => (home ? `svc:${home}` : 'bare'),
      readItem: (svc) => (svc === 'svc:/home/2.1.0' ? WRAPPED : (() => { throw new Error('miss'); })()),
      listVersions: () => ['2.1.0'],
      versionHome: (v) => `/home/${v}`,
      accountEmail: async () => null,
    });
    expect(blob).toBe(WRAPPED);
  });

  itDarwin('prefers the version whose account email matches preferEmail', async () => {
    const reads: string[] = [];
    const blob = await resolveClaudeCredentialsBlob({
      preferEmail: 'want@x.com',
      service: (home) => (home ? `svc:${home}` : 'bare'),
      readItem: (svc) => {
        reads.push(svc);
        if (svc === 'bare') throw new Error('miss');
        // Both managed homes have a token; the matching one must be read first.
        return WRAPPED;
      },
      listVersions: () => ['other', 'match'],
      versionHome: (v) => `/home/${v}`,
      accountEmail: async (home) => (home === '/home/match' ? 'want@x.com' : 'no@x.com'),
    });
    expect(blob).toBe(WRAPPED);
    // After the bare miss, the matching home is tried before the non-matching one.
    expect(reads.filter((r) => r !== 'bare')[0]).toBe('svc:/home/match');
  });

  itDarwin('rejects a payload without a claudeAiOauth.accessToken', async () => {
    const blob = await resolveClaudeCredentialsBlob({
      service: () => 'bare',
      readItem: () => '{"claudeAiOauth":{"refreshToken":"r"}}',
      listVersions: () => [],
      versionHome: (v) => v,
    });
    expect(blob).toBeNull();
  });

  itDarwin('returns null when every read misses', async () => {
    const blob = await resolveClaudeCredentialsBlob({
      service: (home) => (home ? `svc:${home}` : 'bare'),
      readItem: () => { throw new Error('miss'); },
      listVersions: () => ['2.1.0'],
      versionHome: (v) => `/home/${v}`,
      accountEmail: async () => null,
    });
    expect(blob).toBeNull();
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
