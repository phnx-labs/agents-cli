import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bundleExists, bundlePolicy, readBundle, writeBundle } from '../lib/secrets/bundles.js';
import { _resetFileStoreForTest } from '../lib/secrets/filestore.js';
import { setKeychainBackendForTest, type KeychainBackend } from '../lib/secrets/index.js';
import {
  assertValidSshTarget,
  assertNeverPolicyAcknowledged,
  buildRemoteUnlockArgs,
  resolveUnlockTtlMs,
  buildSecretsExecEnv,
  bundleEnvToDotenv,
  exportBundleToFile,
  formatHoldWindow,
  importBundleFromFile,
  parseImportSource,
  parsePolicyOpt,
  quoteWin32ExecArg,
  readImportDotenv,
  registerSecretsCommands,
  resolveImportBundle,
  renderHoldSummary,
  renderPolicyCol,
  renderExpiringCol,
  liveHold,
  compactDurationMs,
  buildRemoteListArgs,
  NO_BUNDLES_HELD_LINE,
} from './secrets.js';
import { MIN_HOLD_MS as MIN_HOLD, MAX_HOLD_MS as MAX_HOLD } from '../lib/secrets/agent.js';
import { visibleWidth } from '../lib/format.js';
import { parseDotenv, type SecretsBundle } from '../lib/secrets/bundles.js';

// On macOS, `secrets create --backend file` still stores bundle METADATA in the
// Keychain, which requires the signed `Agents CLI.app` helper. GitHub macOS CI
// runners can't codesign that helper, so a fresh CLI subprocess dies with
// "Source Agents CLI.app not found". These subprocess tests must therefore skip
// when the helper bundle is absent — matching install-helper.ts's own resolver
// paths (dist/lib/secrets sibling, or <repo>/bin). Linux has no keychain gate,
// so it always runs; local macOS with the helper installed also runs.
const keychainHelperAvailable =
  process.platform !== 'darwin' ||
  fs.existsSync(path.resolve(__dirname, '../lib/secrets/Agents CLI.app')) ||
  fs.existsSync(path.resolve(__dirname, '../../bin/Agents CLI.app')) ||
  fs.existsSync(path.resolve(__dirname, '../../dist/lib/secrets/Agents CLI.app'));

describe('parseImportSource', () => {
  it('treats a plain value as a .env path, including stdin', () => {
    expect(parseImportSource({ from: '.env.prod' })).toEqual({ kind: 'dotenv', path: '.env.prod' });
    expect(parseImportSource({ from: '-' })).toEqual({ kind: 'dotenv', path: '-' });
    // Explicit path escape for a file literally named like a source keyword.
    expect(parseImportSource({ from: './icloud' })).toEqual({ kind: 'dotenv', path: './icloud' });
  });

  it('parses the 1password scheme with and without an inline vault', () => {
    expect(parseImportSource({ from: '1password:Private' })).toEqual({ kind: '1password', vault: 'Private' });
    expect(parseImportSource({ from: '1password:' })).toEqual({ kind: '1password', vault: undefined });
    expect(parseImportSource({ from: '1password' })).toEqual({ kind: '1password', vault: undefined });
    // A vault name containing a colon survives (only the first colon splits).
    expect(parseImportSource({ from: '1password:Team: Shared' })).toEqual({ kind: '1password', vault: 'Team: Shared' });
  });

  it('parses the icloud source', () => {
    expect(parseImportSource({ from: 'icloud' })).toEqual({ kind: 'icloud' });
  });

  it('maps the deprecated --from-1password --vault pair onto the 1password source', () => {
    expect(parseImportSource({ from1password: true, vault: 'Personal' })).toEqual({ kind: '1password', vault: 'Personal' });
    expect(parseImportSource({ from1password: true })).toEqual({ kind: '1password', vault: undefined });
  });

  it('rejects missing and conflicting sources', () => {
    expect(() => parseImportSource({})).toThrow(/--from <source>/);
    expect(() => parseImportSource({ from: '.env', from1password: true })).toThrow(/mutually exclusive/);
  });
});

describe('secrets --device wiring', () => {
  function secretsSub(name: string): Command {
    const program = new Command();
    registerSecretsCommands(program);
    const secrets = program.commands.find((c) => c.name() === 'secrets');
    if (!secrets) throw new Error('secrets command not registered');
    const sub = secrets.commands.find((c) => c.name() === name || c.aliases().includes(name));
    if (!sub) throw new Error(`secrets ${name} not registered`);
    return sub;
  }

  it('registers --device / --devices on export, list, and view', () => {
    for (const name of ['export', 'list', 'view']) {
      const longs = secretsSub(name).options.map((o) => o.long);
      expect(longs).toContain('--device');
    }
  });

  it('export accepts repeatable --device without an unknown-option error and parses the target', () => {
    const cmd = secretsSub('export');
    cmd.exitOverride();
    expect(() => cmd.parseOptions(['apple.com', '--device', 'mac-mini'])).not.toThrow();
    expect(cmd.opts().device).toEqual(['mac-mini']);
    const cmd2 = secretsSub('export');
    cmd2.exitOverride();
    cmd2.parseOptions(['apple.com', '--device', 'a', '--device', 'b']);
    expect(cmd2.opts().device).toEqual(['a', 'b']);
  });

  it('list/view accept --device and --devices without an unknown-option error', () => {
    for (const name of ['list', 'view']) {
      const cmd = secretsSub(name);
      cmd.exitOverride();
      expect(() => cmd.parseOptions(['--device', 'mac-mini'])).not.toThrow();
      expect(cmd.opts().device).toBe('mac-mini');
      const cmd2 = secretsSub(name);
      cmd2.exitOverride();
      expect(() => cmd2.parseOptions(['--devices', 'a,b'])).not.toThrow();
      expect(cmd2.opts().devices).toBe('a,b');
    }
  });
});

describe('assertValidSshTarget', () => {
  it('accepts bare ssh-config aliases and user@host', () => {
    expect(() => assertValidSshTarget('yosemite-s0')).not.toThrow();
    expect(() => assertValidSshTarget('yosemite-s1')).not.toThrow();
    expect(() => assertValidSshTarget('muqsit@yosemite-s0')).not.toThrow();
    expect(() => assertValidSshTarget('user@10.0.0.1')).not.toThrow();
    expect(() => assertValidSshTarget('host.example.com')).not.toThrow();
  });

  it('rejects argv-flag injection and shell metacharacters', () => {
    // A leading '-' would be parsed by ssh as a flag rather than a target.
    expect(() => assertValidSshTarget('-oProxyCommand=evil')).toThrow();
    expect(() => assertValidSshTarget('a b')).toThrow();
    expect(() => assertValidSshTarget('a;rm -rf /')).toThrow();
    expect(() => assertValidSshTarget('a$(whoami)')).toThrow();
    expect(() => assertValidSshTarget('a`id`')).toThrow();
    expect(() => assertValidSshTarget('a@b@c')).toThrow();
    expect(() => assertValidSshTarget('')).toThrow();
  });
});

// The `--json` payload is a machine surface: it now reports `hold` where it
// reported `daily`. That is a deliberate, documented break (see the changelog
// fragment), so pin it — an accidental revert to `daily`, or a future rename
// that forgets this surface, should fail here rather than silently move a
// string that scripts match on.
describe('policy in the --json discovery payload', () => {
  it('reports the current policy vocabulary, not the retired name', () => {
    const bundle = { name: 'x', vars: {}, policy: undefined } as unknown as SecretsBundle;
    expect(bundlePolicy(bundle)).toBe('hold');
    expect(bundlePolicy(bundle)).not.toBe('daily');
  });

  it('still accepts the retired name as INPUT, so configs and scripts keep working', () => {
    expect(parsePolicyOpt('daily')).toBe('hold');
    expect(bundlePolicy({ name: 'x', vars: {}, policy: parsePolicyOpt('daily') } as unknown as SecretsBundle)).toBe('hold');
  });
});

describe('parsePolicyOpt', () => {
  it('accepts the three policies and their legacy aliases', () => {
    expect(parsePolicyOpt('always')).toBe('always');
    expect(parsePolicyOpt('biometry')).toBe('always');
    expect(parsePolicyOpt('hold')).toBe('hold');
    // `daily` was the old name for this tier and `session` its wire token. Both
    // MUST keep parsing: they are in users' agents.yaml, in scripts, and in the
    // `tier` key of every bundle already written to a keychain on every machine.
    expect(parsePolicyOpt('daily')).toBe('hold');
    expect(parsePolicyOpt('session')).toBe('hold');
    expect(parsePolicyOpt('DAILY')).toBe('hold');
    // The whole point of #421: `never` (and its `none` alias) is now accepted,
    // not rejected by the old stub.
    expect(parsePolicyOpt('never')).toBe('never');
    expect(parsePolicyOpt('none')).toBe('never');
    expect(parsePolicyOpt('NEVER')).toBe('never');
  });

  it('throws on an unknown policy', () => {
    expect(() => parsePolicyOpt('sometimes')).toThrow(/Invalid policy/);
  });
});

describe('assertNeverPolicyAcknowledged', () => {
  it('is a no-op for non-never policies regardless of flags', () => {
    expect(assertNeverPolicyAcknowledged('always', { interactive: false })).toBe('ok');
    expect(assertNeverPolicyAcknowledged('hold', { interactive: false })).toBe('ok');
    expect(assertNeverPolicyAcknowledged(undefined, { interactive: false })).toBe('ok');
  });

  it('REQUIRES confirmation for never: headless without --i-understand is rejected', () => {
    // This is the guard — a headless `create --policy never` must not silently
    // downgrade a bundle's protection.
    expect(() => assertNeverPolicyAcknowledged('never', { interactive: false }))
      .toThrow(/Refusing to set the 'never' prompt-policy/);
  });

  it('accepts never when --i-understand is passed (headless opt-in)', () => {
    expect(assertNeverPolicyAcknowledged('never', { iUnderstand: true, interactive: false })).toBe('ok');
  });

  it('defers to an interactive prompt for never in a TTY', () => {
    expect(assertNeverPolicyAcknowledged('never', { interactive: true })).toBe('prompt');
  });
});

describe('formatHoldWindow', () => {
  it('renders whole hours and days for common holds', () => {
    expect(formatHoldWindow(24 * 60 * 60 * 1000)).toBe('24 hours');
    expect(formatHoldWindow(7 * 24 * 60 * 60 * 1000)).toBe('7 days');
    expect(formatHoldWindow(60 * 60 * 1000)).toBe('1 hour');
  });

  it('never renders a confusing "0 hours" — sub-hour holds show minutes', () => {
    expect(formatHoldWindow(60 * 1000)).toBe('1 minute');      // the 1m floor
    expect(formatHoldWindow(30 * 60 * 1000)).toBe('30 minutes');
    expect(formatHoldWindow(1)).toBe('1 minute');              // clamps up, never "0"
  });

  it('rounds 59.99 minutes to "1 hour", not "60 minutes"', () => {
    expect(formatHoldWindow(3_599_999)).toBe('1 hour');
  });
});

describe('renderHoldSummary', () => {
  it('names the hold policy, never the retired `daily` name', () => {
    const line = renderHoldSummary('7 days', false);
    expect(line).toContain('hold policy');
    // The rename in #1604 retired `daily`; this line kept saying it for two
    // releases. `daily` is no longer a name the CLI's own help accepts.
    expect(line).not.toMatch(/daily/i);
  });

  it('attributes the window to config only when it is actually configured', () => {
    expect(renderHoldSummary('24 hours', true)).toContain('(secrets.agent.holdMs)');
    expect(renderHoldSummary('7 days', false)).toContain('(default)');
    expect(renderHoldSummary('7 days', false)).not.toContain('secrets.agent.holdMs');
  });

  it('the empty-broker line names hold too — it drifted with the header', () => {
    expect(NO_BUNDLES_HELD_LINE).toContain('hold-policy bundle');
    expect(NO_BUNDLES_HELD_LINE).not.toMatch(/daily/i);
  });
});

describe('buildRemoteListArgs', () => {
  it('forwards every filter, so a remote list narrows the same way', () => {
    // browseRemote sends this argv verbatim. A flag missing here is not an
    // error — the remote just lists everything, and `--host zion --expired`
    // reports every bundle on zion as expired.
    const args = buildRemoteListArgs({
      json: true,
      policy: 'never',
      backend: 'file',
      type: 'token',
      kind: 'literal',
      expired: true,
      unused: '90d',
      sort: 'used',
      limit: '5',
    }, 'github');
    expect(args).toEqual([
      'list', 'github', '--json',
      '--policy', 'never',
      '--backend', 'file',
      '--type', 'token',
      '--kind', 'literal',
      '--expired',
      '--unused', '90d',
      '--sort', 'used',
      '--limit', '5',
    ]);
  });

  it('sends a bare --expiring without a value, and a valued one with it', () => {
    expect(buildRemoteListArgs({ expiring: true })).toEqual(['list', '--expiring']);
    expect(buildRemoteListArgs({ expiring: '7' })).toEqual(['list', '--expiring', '7']);
  });

  it('forwards the held pair, which the remote resolves against its own broker', () => {
    expect(buildRemoteListArgs({ held: true })).toEqual(['list', '--held']);
    expect(buildRemoteListArgs({ notHeld: true })).toEqual(['list', '--not-held']);
  });

  it('is just `list` when nothing is set', () => {
    expect(buildRemoteListArgs({})).toEqual(['list']);
  });
});

describe('liveHold', () => {
  it('is the one definition of held, shared by the column, the filter, and --json', () => {
    const now = Date.now();
    expect(liveHold(now + 60_000, now)).toBe(now + 60_000);
    // A broker entry past its expiry is not held. Before this, the column and
    // the --held filter said "not held" while --json still reported the stale
    // timestamp for the same bundle.
    expect(liveHold(now - 1, now)).toBeNull();
    expect(liveHold(undefined, now)).toBeNull();
  });
});

describe('renderExpiringCol', () => {
  const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  it('shows a dash when nothing expires', () => {
    expect(renderExpiringCol({ name: 'b', vars: {} })).toContain('-');
  });

  it('counts an already-expired key, which used to render as a dash', () => {
    // countExpiringSoon guards on d >= 0, so a lapsed key was indistinguishable
    // from a bundle with no expiry at all.
    const col = renderExpiringCol({ name: 'b', vars: {}, meta: { K: { expires: iso(-30) } } });
    expect(col).toContain('1');
    expect(col).not.toContain('-');
  });

  it('counts lapsed and upcoming together', () => {
    const col = renderExpiringCol({
      name: 'b',
      vars: {},
      meta: { DEAD: { expires: iso(-5) }, SOON: { expires: iso(3) }, FAR: { expires: iso(400) } },
    });
    expect(col).toContain('2');
  });
});

describe('compactDurationMs', () => {
  it('rounds onto minute/hour/day thresholds', () => {
    expect(compactDurationMs(45 * 60_000)).toBe('45m');
    expect(compactDurationMs(19 * 3_600_000)).toBe('19h');
    expect(compactDurationMs(2 * 86_400_000)).toBe('2d');
  });

  it('covers the whole clamp range, so the POLICY column width is bounded', () => {
    // clampHoldMs pins the window to [1m, 30d], so these are the real extremes.
    expect(compactDurationMs(MIN_HOLD)).toBe('1m');
    expect(compactDurationMs(MAX_HOLD)).toBe('30d');
  });
});

describe('renderPolicyCol', () => {
  const bundle = (policy: SecretsBundle['policy']): SecretsBundle => ({ name: 'b', vars: {}, policy });
  const HOLD_7D = 7 * 24 * 60 * 60 * 1000;

  it('marks a never bundle distinctly and loudly', () => {
    const never = renderPolicyCol(bundle('never'), HOLD_7D);
    expect(never).toMatch(/never/);
    expect(never).toMatch(/no prompt/i);
    // Distinct from the other tiers — the marking is not shared.
    expect(never).not.toBe(renderPolicyCol(bundle('always'), HOLD_7D));
    expect(never).not.toBe(renderPolicyCol(bundle('hold'), HOLD_7D));
  });

  it('does not label always/hold bundles as never', () => {
    expect(renderPolicyCol(bundle('always'), HOLD_7D)).not.toMatch(/never/i);
    expect(renderPolicyCol(bundle('hold'), HOLD_7D)).not.toMatch(/never/i);
  });

  it('states the window, because `hold` IS a duration', () => {
    const col = renderPolicyCol(bundle('hold'), HOLD_7D);
    expect(col).toContain('hold 7d');
    // Not currently held — no countdown to show.
    expect(col).not.toMatch(/held/);
  });

  it('renders the window from the configured hold, not a hardcoded 7d', () => {
    // Same thresholds as the countdown, so a 24h hold reads `1d` — the two
    // halves of the cell must never round differently for the same span.
    expect(renderPolicyCol(bundle('hold'), 24 * 3_600_000)).toContain('hold 1d');
    expect(renderPolicyCol(bundle('hold'), 12 * 3_600_000)).toContain('hold 12h');
    expect(renderPolicyCol(bundle('hold'), 30 * 60_000)).toContain('hold 30m');
  });

  it('appends the countdown while the broker actually holds it', () => {
    const held = new Map([['b', Date.now() + 2 * 86_400_000]]);
    const col = renderPolicyCol(bundle('hold'), HOLD_7D, held);
    expect(col).toContain('hold 7d');
    expect(col).toContain('held 2d');
  });

  it('treats a lapsed hold as not held — never renders the `expired` sentinel', () => {
    // A stale broker row past its expiry used to render `hold · held expired`,
    // because the branch tested the map entry for truthiness, not for liveness.
    const stale = new Map([['b', Date.now() - 60_000]]);
    const col = renderPolicyCol(bundle('hold'), HOLD_7D, stale);
    expect(col).not.toMatch(/expired/);
    expect(col).not.toMatch(/held/);
    expect(col).toContain('hold 7d');
  });

  it('gives always/never no window, whatever the hold is', () => {
    // Neither tier has a window; annotating one would repeat the `daily` lie.
    for (const holdMs of [1, HOLD_7D, MAX_HOLD]) {
      expect(renderPolicyCol(bundle('always'), holdMs)).toBe(renderPolicyCol(bundle('always'), HOLD_7D));
      expect(renderPolicyCol(bundle('never'), holdMs)).toBe(renderPolicyCol(bundle('never'), HOLD_7D));
    }
  });

  it('never exceeds the POLICY column width at the widest possible cell', () => {
    const held = new Map([['b', Date.now() + MAX_HOLD]]);
    const widest = renderPolicyCol(bundle('hold'), MAX_HOLD, held);
    expect(visibleWidth(widest)).toBeLessThanOrEqual(20);
  });
});

describe('bundleEnvToDotenv', () => {
  it('round-trips arbitrary single-line values through parseDotenv', () => {
    // These are exactly the inputs the naive shell-quoting serializer corrupts:
    // embedded quotes, backslashes, $, spaces, leading/trailing whitespace.
    const env = {
      EMAIL: 'muqsit@getrush.ai',
      PASSWORD: 'p@ss w0rd',
      WITH_SINGLE_QUOTE: "it's a secret",
      WITH_DOUBLE_QUOTE: 'say "hi"',
      WITH_BOTH: `mix'd "quotes"`,
      WITH_BACKSLASH: 'a\\b\\c',
      WITH_DOLLAR: '$HOME/and/$(cmd)',
      WITH_SPACES: '  padded value  ',
      WITH_EQUALS: 'key=val=ue',
      WITH_HASH: 'token#frag',
      'GITHUB_USERNAME.personal': 'muqsit',
      EMPTY: '',
    };
    const dotenv = bundleEnvToDotenv(env);
    expect(parseDotenv(dotenv)).toEqual(env);
  });

  it('rejects multi-line values instead of silently corrupting them', () => {
    expect(() => bundleEnvToDotenv({ KEY: 'line1\nline2' })).toThrow(/multi-line/);
    expect(() => bundleEnvToDotenv({ KEY: 'has\rcarriage' })).toThrow(/multi-line/);
  });
});

describe('secrets export (transport-only json; shell print mode removed, RUSH-2774)', () => {
  function runSecrets(home: string, args: string[], extraEnv: Record<string, string | undefined> = {}): ReturnType<typeof spawnSync> {
    return spawnSync('node', ['--import', 'tsx', 'src/index.ts', 'secrets', ...args], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        // os.homedir() reads USERPROFILE on Windows, so HOME alone leaves the
        // spawned CLI resolving the real profile ('agents-cli is not set up').
        USERPROFILE: home,
        AGENTS_SECRETS_PASSPHRASE: 'rush-668-test',
        AGENTS_NO_USAGE_TRACK: '1',
        // This suite itself often runs inside an agent session; those inherited
        // markers must not leak into the spawned CLI, or every materialization
        // test would exercise the agent-refusal branch instead of its subject.
        AGENTS_RUNTIME: undefined,
        AGENT_SESSION_ID: undefined,
        AGENTS_SESSION_ID: undefined,
        CLAUDECODE: undefined,
        ...extraEnv,
      },
    });
  }

  function seedGithubBundle(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-json-'));
    fs.mkdirSync(path.join(home, '.agents/.system'), { recursive: true });
    spawnSync('git', ['init', '--quiet'], {
      cwd: path.join(home, '.agents/.system'),
      encoding: 'utf-8',
    });
    expect(runSecrets(home, ['create', 'github.com', '--backend', 'file']).status).toBe(0);
    expect(runSecrets(home, ['add', 'github.com', 'GITHUB_USERNAME.work', '--value', 'workbot']).status).toBe(0);
    return home;
  }

  it.skipIf(!keychainHelperAvailable)('emits json for the remote-resolve transport (marker set, non-agent env)', ({ skip }) => {
    // Belt-and-suspenders: the release matrix has shown `it.skipIf` failing to
    // keep a test off a runner, so also skip explicitly at runtime.
    if (!keychainHelperAvailable) {
      skip();
      return;
    }
    const home = seedGithubBundle();
    try {
      const exported = runSecrets(home, ['export', 'github.com', '--plaintext', '--format', 'json'], {
        AGENTS_SECRETS_REMOTE_TRANSPORT: '1',
      });
      expect(exported.status, exported.stderr).toBe(0);
      expect(JSON.parse(exported.stdout)).toEqual({ GITHUB_USERNAME: 'workbot' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!keychainHelperAvailable)('refuses the same invocation without the transport marker — the eval surface is gone', ({ skip }) => {
    if (!keychainHelperAvailable) {
      skip();
      return;
    }
    const home = seedGithubBundle();
    try {
      const noMarker = runSecrets(home, ['export', 'github.com', '--plaintext', '--format', 'json']);
      expect(noMarker.status).toBe(1);
      expect(noMarker.stderr).toMatch(/export no longer prints values/);
      expect(noMarker.stdout).not.toContain('workbot');

      // Bare export (the old `--plaintext`-nag path) gets the same refusal with
      // the paved alternatives named.
      const bare = runSecrets(home, ['export', 'github.com']);
      expect(bare.status).toBe(1);
      expect(bare.stderr).toMatch(/agents secrets exec github\.com -- <cmd>/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!keychainHelperAvailable)('refuses the transport shape inside an agent session even with the marker', ({ skip }) => {
    if (!keychainHelperAvailable) {
      skip();
      return;
    }
    const home = seedGithubBundle();
    try {
      const res = runSecrets(home, ['export', 'github.com', '--plaintext', '--format', 'json'], {
        AGENTS_SECRETS_REMOTE_TRANSPORT: '1',
        AGENT_SESSION_ID: 'test-session',
      });
      expect(res.status).toBe(1);
      expect(res.stdout).not.toContain('workbot');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!keychainHelperAvailable)('secrets get <bundle> <KEY> is removed and points at exec', ({ skip }) => {
    if (!keychainHelperAvailable) {
      skip();
      return;
    }
    const home = seedGithubBundle();
    try {
      const res = runSecrets(home, ['get', 'github.com', 'GITHUB_USERNAME.work']);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/has been removed/);
      expect(res.stderr).toMatch(/secrets exec github\.com -- printenv/);
      expect(res.stdout).not.toContain('workbot');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!keychainHelperAvailable)('raw-item get stays available inside an agent session (shell hooks depend on it)', ({ skip }) => {
    if (!keychainHelperAvailable) {
      skip();
      return;
    }
    const home = seedGithubBundle();
    try {
      // A missing item exits 1 QUIETLY (the hook-probe contract) — the point
      // here is that no agent-session refusal fires for the raw-item form,
      // unlike the removed bundle-key form. See the posthog analytics hook.
      const res = runSecrets(home, ['get', 'some-raw-item'], { CLAUDECODE: '1' });
      expect(res.stderr).not.toMatch(/agent session/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('secrets list/view --json (agent discovery, RUSH-1834)', () => {
  function runSecrets(home: string, args: string[]): ReturnType<typeof spawnSync> {
    return spawnSync('node', ['--import', 'tsx', 'src/index.ts', 'secrets', ...args], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        // os.homedir() reads USERPROFILE on Windows, so HOME alone leaves the
        // spawned CLI resolving the real profile ('agents-cli is not set up').
        USERPROFILE: home,
        AGENTS_SECRETS_PASSPHRASE: 'rush-1834-test',
        AGENTS_NO_USAGE_TRACK: '1',
      },
    });
  }

  function seed(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-disc-'));
    fs.mkdirSync(path.join(home, '.agents/.system'), { recursive: true });
    spawnSync('git', ['init', '--quiet'], { cwd: path.join(home, '.agents/.system'), encoding: 'utf-8' });
    expect(runSecrets(home, ['create', 'github.com', '--backend', 'file', '--description', 'gh creds']).status).toBe(0);
    expect(runSecrets(home, ['add', 'github.com', 'API_TOKEN', '--value', 'sk-live-xyz']).status).toBe(0);
    return home;
  }

  it.skipIf(!keychainHelperAvailable)('list --json emits a machine-readable bundle array with metadata but no secret values', ({ skip }) => {
    if (!keychainHelperAvailable) {
      skip();
      return;
    }
    const home = seed();
    try {
      const res = runSecrets(home, ['list', '--json']);
      expect(res.status, res.stderr).toBe(0);
      const arr = JSON.parse(res.stdout);
      expect(Array.isArray(arr)).toBe(true);
      const gh = arr.find((b: { name: string }) => b.name === 'github.com');
      expect(gh).toBeTruthy();
      expect(gh.keys).toBe(1);
      expect(gh.backend).toBe('file');
      expect(gh.description).toBe('gh creds');
      expect(typeof gh.policy).toBe('string');
      // A machine caller shouldn't have to know that `hold` means a duration,
      // nor read agents.yaml to find which one — the window rides the record.
      if (gh.policy === 'hold') {
        expect(typeof gh.holdMs).toBe('number');
        expect(gh.holdMs).toBeGreaterThan(0);
      } else {
        expect(gh.holdMs).toBeNull();
      }
      // The list is a discovery surface — it must never carry the secret value.
      expect(res.stdout).not.toContain('sk-live-xyz');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!keychainHelperAvailable)('view --json lists keys with value=null when not revealed (never leaks the secret)', ({ skip }) => {
    if (!keychainHelperAvailable) {
      skip();
      return;
    }
    const home = seed();
    try {
      const res = runSecrets(home, ['view', 'github.com', '--json']);
      expect(res.status, res.stderr).toBe(0);
      const obj = JSON.parse(res.stdout);
      expect(obj.name).toBe('github.com');
      expect(obj.revealed).toBe(false);
      // Same window field as list --json, so the two surfaces agree.
      if (obj.policy === 'hold') expect(typeof obj.holdMs).toBe('number');
      else expect(obj.holdMs).toBeNull();
      expect(Array.isArray(obj.keys)).toBe(true);
      const k = obj.keys.find((e: { key: string }) => e.key === 'API_TOKEN');
      expect(k).toBeTruthy();
      expect(k.value).toBeNull();
      expect(res.stdout).not.toContain('sk-live-xyz');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!keychainHelperAvailable)('view --json --reveal fails fast outside an interactive terminal — the old --plaintext escape is gone (RUSH-2774)', ({ skip }) => {
    if (!keychainHelperAvailable) {
      skip();
      return;
    }
    const home = seed();
    try {
      const res = runSecrets(home, ['view', 'github.com', '--json', '--reveal']);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/interactive terminal outside an agent session/);
      expect(res.stdout).not.toContain('sk-live-xyz');

      // `--plaintext` no longer exists on view; passing it is an unknown option,
      // not a reveal escape.
      const escape = runSecrets(home, ['view', 'github.com', '--json', '--reveal', '--plaintext']);
      expect(escape.status).not.toBe(0);
      expect(escape.stdout).not.toContain('sk-live-xyz');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('buildSecretsExecEnv', () => {
  it('strips AGENTS_SECRETS_PASSPHRASE and loader-hijack vars from the child env', () => {
    const parent = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      AGENTS_SECRETS_PASSPHRASE: 'master-key',
      LD_PRELOAD: '/evil.so',
      NODE_OPTIONS: '--require /evil',
      DYLD_INSERT_LIBRARIES: '/evil.dylib',
    };
    const secretEnv = { API_KEY: 'sk-live', AGENTS_SECRETS_PASSPHRASE: 'bundle-leak' };
    const child = buildSecretsExecEnv(parent, secretEnv);
    expect(child.API_KEY).toBe('sk-live');
    expect(child.PATH).toBe('/usr/bin');
    expect(child.HOME).toBe('/home/user');
    expect(child.AGENTS_SECRETS_PASSPHRASE).toBeUndefined();
    expect(child.LD_PRELOAD).toBeUndefined();
    expect(child.NODE_OPTIONS).toBeUndefined();
    expect(child.DYLD_INSERT_LIBRARIES).toBeUndefined();
  });

  it('bundle vars override sanitized parent vars but not the stripped master key', () => {
    const child = buildSecretsExecEnv(
      { PATH: '/old', AGENTS_SECRETS_PASSPHRASE: 'parent' },
      { PATH: '/new/from-bundle' },
    );
    expect(child.PATH).toBe('/new/from-bundle');
    expect(child.AGENTS_SECRETS_PASSPHRASE).toBeUndefined();
  });
});

// `agents secrets exec` spawns with shell:true on win32; cmd.exe does no quoting
// of its own, so args must be quoted here or a spaced path splits into two args.
describe('quoteWin32ExecArg', () => {
  it('leaves simple args untouched', () => {
    expect(quoteWin32ExecArg('npm')).toBe('npm');
    expect(quoteWin32ExecArg('--version')).toBe('--version');
    expect(quoteWin32ExecArg('sk-proj-AbC123_xyz.789')).toBe('sk-proj-AbC123_xyz.789');
  });

  it('quotes args containing spaces so they stay a single argument', () => {
    expect(quoteWin32ExecArg('hello world')).toBe('"hello world"');
    expect(quoteWin32ExecArg('C:\\Program Files\\node\\node.exe'))
      .toBe('"C:\\Program Files\\node\\node.exe"');
  });

  it('quotes cmd metacharacters so the shell treats them literally', () => {
    expect(quoteWin32ExecArg('a&b')).toBe('"a&b"');
    expect(quoteWin32ExecArg('a|b')).toBe('"a|b"');
    expect(quoteWin32ExecArg('a>b')).toBe('"a>b"');
  });

  it('escapes embedded double quotes (CommandLineToArgvW rules)', () => {
    expect(quoteWin32ExecArg('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('doubles a run of backslashes that precedes a quote', () => {
    // a\"b -> the backslash before the quote is doubled, the quote escaped.
    expect(quoteWin32ExecArg('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it('doubles trailing backslashes before the closing quote (when quoting)', () => {
    // Space forces quoting; the trailing backslash must be doubled so it does
    // not escape the closing quote. Input `a b\` -> `"a b\\"`.
    expect(quoteWin32ExecArg('a b\\')).toBe('"a b\\\\"');
    // Interior backslashes NOT before a quote stay literal. Input `two\\ end`
    // (2 backslashes) -> `"two\\ end"` (still 2).
    expect(quoteWin32ExecArg('two\\\\ end')).toBe('"two\\\\ end"');
  });

  it('leaves a lone trailing backslash unquoted (no trigger char)', () => {
    expect(quoteWin32ExecArg('ends\\')).toBe('ends\\');
  });

  it('turns an empty arg into an explicit ""', () => {
    expect(quoteWin32ExecArg('')).toBe('""');
  });
});

describe('readImportDotenv', () => {
  it('reads a .env from a filesystem path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-import-'));
    const p = path.join(dir, '.env');
    fs.writeFileSync(p, 'A="1"\nB="two words"\n');
    try {
      expect(readImportDotenv(p)).toBe('A="1"\nB="two words"\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // POSIX-only by design, NOT a harness dodge: `--from -` (readStdinSync ->
  // fs.readSync(0)) is the POSIX way `export --device` pipes a .env into a remote
  // `import`. On Windows the export deliberately does NOT use `--from -` — the
  // npm `agents.ps1` shim doesn't forward piped stdin to node, so it routes
  // through the temp-file bridge in `buildWindowsStdinImportCommand` instead
  // (verified end-to-end: 13 keys -> win-mini; unit-tested by the decoded-script
  // assertions in remote-cmd.test.ts). So this test exercises the POSIX branch on
  // the POSIX CI legs; the Windows branch is covered by that separate test.
  it.skipIf(process.platform === 'win32')('reads the .env from stdin when passed "-"', ({ skip }) => {
    // The in-process fd 0 can't be swapped, so exercise the real helper end to
    // end in a child process with piped stdin. Run it with `bun` (repo-standard,
    // on CI PATH): bun executes TS natively with no ESM loader hook — cleaner
    // than the old `node --import tsx`, whose loader also failed to register on
    // Windows.
    //
    // Belt-and-suspenders: the release matrix showed `it.skipIf` failing to keep
    // this test off Windows runners, so also call the runtime skip explicitly.
    if (process.platform === 'win32') {
      skip();
      return;
    }
    const srcUrl = new URL('./secrets.ts', import.meta.url).href;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-stdin-'));
    const probe = path.join(dir, 'probe.ts');
    fs.writeFileSync(
      probe,
      `import { readImportDotenv } from ${JSON.stringify(srcUrl)};\n` +
        `process.stdout.write(JSON.stringify(readImportDotenv('-')));\n`,
    );
    try {
      const res = spawnSync('bun', [probe], { input: 'A="1"\nB="two words"\n', encoding: 'utf-8' });
      expect(res.status, res.stderr).toBe(0);
      // readStdinSync trims trailing whitespace; parseDotenv is line-based so a
      // single trailing newline is immaterial — the KEY="VALUE" lines round-trip.
      expect(JSON.parse(res.stdout)).toBe('A="1"\nB="two words"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveUnlockTtlMs', () => {
  const now = Date.parse('2026-08-05T12:00:00Z');

  it('converts an absolute date to the remaining TTL', () => {
    expect(resolveUnlockTtlMs(undefined, '2026-08-06T12:00:00Z', now)).toBe(86_400_000);
  });

  it('rejects invalid, past, and conflicting dates', () => {
    expect(() => resolveUnlockTtlMs(undefined, 'not-a-date', now)).toThrow('Invalid --until');
    expect(() => resolveUnlockTtlMs(undefined, '2026-08-04', now)).toThrow('date must be in the future');
    expect(() => resolveUnlockTtlMs('2h', '2026-08-06', now)).toThrow('mutually exclusive');
  });
});

describe('buildRemoteUnlockArgs (unlock --device wiring)', () => {
  it('forwards explicit bundle names', () => {
    expect(buildRemoteUnlockArgs(['a', 'b'], {})).toEqual(['unlock', 'a', 'b']);
  });

  it('passes --ttl through verbatim for the remote to parse', () => {
    expect(buildRemoteUnlockArgs(['a'], { ttl: '8h' })).toEqual(['unlock', 'a', '--ttl', '8h']);
  });

  it('forwards --all instead of the (empty) name list', () => {
    expect(buildRemoteUnlockArgs([], { all: true, ttl: '30m' })).toEqual(['unlock', '--all', '--ttl', '30m']);
  });

  it('--all wins over any stray names', () => {
    expect(buildRemoteUnlockArgs(['x'], { all: true })).toEqual(['unlock', '--all']);
  });

  it('forwards --until verbatim for the remote to parse', () => {
    expect(buildRemoteUnlockArgs(['a'], { until: '2026-08-06T12:00:00Z' }))
      .toEqual(['unlock', 'a', '--until', '2026-08-06T12:00:00Z']);
  });

  it('forwards --durable so the remote honors it (not silently downgraded)', () => {
    expect(buildRemoteUnlockArgs(['a'], { durable: true })).toEqual(['unlock', 'a', '--durable']);
    expect(buildRemoteUnlockArgs([], { all: true, ttl: '2h', durable: true }))
      .toEqual(['unlock', '--all', '--ttl', '2h', '--durable']);
    expect(buildRemoteUnlockArgs(['a'], {})).not.toContain('--durable');
  });
});

describe('exportBundleToFile / importBundleFromFile file round-trip', () => {
  const PASS = 'test-passphrase-for-offline-file';

  it('round-trips arbitrary values including quotes, backslashes, equals, and spaces', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-file-bundle-'));
    const filePath = path.join(dir, 'bundle.enc');
    const env = {
      API_KEY: 'sk-test-abc123',
      SECRET: 'p@ss w0rd',
      WITH_SINGLE_QUOTE: "it's a secret",
      WITH_DOUBLE_QUOTE: 'say "hi"',
      WITH_BOTH: `mix'd "quotes"`,
      WITH_BACKSLASH: 'a\\b\\c',
      WITH_DOLLAR: '$HOME/and/$(cmd)',
      WITH_SPACES: '  padded value  ',
      WITH_EQUALS: 'key=val=ue',
      WITH_HASH: 'token#frag',
      EMPTY: '',
    };
    try {
      exportBundleToFile(env, filePath, PASS);
      expect(importBundleFromFile(filePath, PASS)).toEqual(env);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips multi-line values (not possible through the SSH dotenv path)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-file-bundle-'));
    const filePath = path.join(dir, 'bundle.enc');
    const env = { SSH_KEY: '-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIA==\n-----END EC PRIVATE KEY-----\n' };
    try {
      exportBundleToFile(env, filePath, PASS);
      expect(importBundleFromFile(filePath, PASS)).toEqual(env);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the encrypted file is written with mode 0600 and is not plain JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-file-bundle-'));
    const filePath = path.join(dir, 'bundle.enc');
    try {
      exportBundleToFile({ KEY: 'val' }, filePath, PASS);
      const stat = fs.statSync(filePath);
      // POSIX perms don't survive on Windows — Node reports 0o666 regardless of
      // the mode we pass, so asserting 0o600 there tests the OS, not us.
      if (process.platform !== 'win32') {
        expect(stat.mode & 0o777).toBe(0o600);
      }
      // The raw file must not expose plaintext keys.
      const raw = fs.readFileSync(filePath, 'utf-8');
      expect(raw).not.toContain('KEY');
      expect(raw).not.toContain('val');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a wrong passphrase with an actionable error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-file-bundle-'));
    const filePath = path.join(dir, 'bundle.enc');
    try {
      exportBundleToFile({ KEY: 'val' }, filePath, PASS);
      expect(() => importBundleFromFile(filePath, 'wrong-passphrase')).toThrow(/decrypt.*tampered/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a corrupt file with an actionable error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-file-bundle-'));
    const filePath = path.join(dir, 'bundle.enc');
    try {
      fs.writeFileSync(filePath, 'not-valid-json');
      expect(() => importBundleFromFile(filePath, PASS)).toThrow(/corrupt.*not valid JSON/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Regression for #2305: `import --force` could not repair a bundle whose
 * metadata RECORD was undecryptable.
 *
 * That is the exact state provisioning exists to fix — a box whose file-store
 * key was lost or rotated out from under it, so its bundles are present but
 * unreadable. `agents secrets export <bundle> --device <box> --remote-backend
 * file --force` drives the remote's own `import`, which died on `readBundle`:
 *
 *   remote import failed (exit 1): Bundle 'higgsfield.ai': failed to decrypt
 *
 * The push wrote nothing (clean failure, no corruption), but the only route
 * left was deleting the record by hand on an already-degraded store. Found
 * while remediating yosemite-s0's 57 orphaned items (RUSH-2351).
 */
describe('resolveImportBundle — an undecryptable bundle record', () => {
  const NAME = 'import-undecryptable-fixture.test';
  let dir: string;
  let prevBackend: ReturnType<typeof setKeychainBackendForTest>;
  let prevPassphrase: string | undefined;

  /** An always-empty keychain, so the encrypted FILE store is what answers. */
  class EmptyKeychain implements KeychainBackend {
    store = new Map<string, string>();
    has(item: string) { return this.store.has(item); }
    get(item: string): string { throw new Error(`missing ${item}`); }
    set(item: string, value: string) { this.store.set(item, value); }
    delete(item: string) { return this.store.delete(item); }
    list(prefix: string) { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
  }

  /** Re-key the store, making the on-disk ciphertext a genuine key loss. */
  function usePassphrase(phrase: string): void {
    process.env.AGENTS_SECRETS_PASSPHRASE = phrase;
    _resetFileStoreForTest({ fileDir: dir, passphrase: null });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-import-undecryptable-'));
    prevPassphrase = process.env.AGENTS_SECRETS_PASSPHRASE;
    prevBackend = setKeychainBackendForTest(new EmptyKeychain());
    usePassphrase('the-original-passphrase');
  });

  afterEach(() => {
    setKeychainBackendForTest(prevBackend);
    if (prevPassphrase === undefined) delete process.env.AGENTS_SECRETS_PASSPHRASE;
    else process.env.AGENTS_SECRETS_PASSPHRASE = prevPassphrase;
    _resetFileStoreForTest({});
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  /** Write a file-backed bundle, then lose the key it was written under. */
  function strandBundle(): void {
    writeBundle({ name: NAME, backend: 'file', vars: { NPM_TOKEN: 'literal:shhh' } });
    expect(readBundle(NAME).vars.NPM_TOKEN).toBe('literal:shhh');
    usePassphrase('a-different-passphrase');
    expect(bundleExists(NAME)).toBe(true);
    expect(() => readBundle(NAME)).toThrow(/failed to decrypt/i);
  }

  it('is recreated under --force, so provisioning can repair the box', () => {
    strandBundle();
    const bundle = resolveImportBundle(NAME, 'file', false, true);
    expect(bundle.name).toBe(NAME);
    expect(bundle.backend).toBe('file');
    // Empty: the old ciphertext is unreadable, so the import starts clean and
    // the pushed keys land under the CURRENT key.
    expect(bundle.vars).toEqual({});
  });

  it('still refuses without --force — a forgotten passphrase must not wipe a healthy bundle', () => {
    strandBundle();
    expect(() => resolveImportBundle(NAME, 'file', false, false)).toThrow(/failed to decrypt/i);
  });

  it('does not recreate a bundle that decrypts fine, even with --force', () => {
    writeBundle({ name: NAME, backend: 'file', vars: { NPM_TOKEN: 'literal:keep-me' } });
    const bundle = resolveImportBundle(NAME, 'file', false, true);
    // --force means "overwrite the keys I am importing", never "discard the rest".
    expect(bundle.vars.NPM_TOKEN).toBe('literal:keep-me');
  });

  it('still throws for a genuinely missing name rather than reporting it unreadable', () => {
    // Not-found is a different state from unreadable; --force must not blur them
    // into "create it silently" for a caller that typo'd the bundle name... it
    // creates, which is import's documented behavior — but via the not-exists
    // path, carrying the requested backend rather than inheriting a stale one.
    const fresh = resolveImportBundle('no-such-bundle.test', 'file', false, true);
    expect(fresh.vars).toEqual({});
    expect(fresh.backend).toBe('file');
  });
});

describe('secrets unlock when the broker is disabled', () => {
  function runSecrets(home: string, args: string[]): ReturnType<typeof spawnSync> {
    return spawnSync('node', ['--import', 'tsx', 'src/index.ts', 'secrets', ...args], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGENTS_SECRETS_PASSPHRASE: 'rush-disabled-broker-test',
        AGENTS_NO_USAGE_TRACK: '1',
      },
    });
  }

  it.skipIf(process.platform !== 'darwin')('exits with a clear message when secrets-broker is disabled', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-disabled-'));
    try {
      fs.mkdirSync(path.join(home, '.agents', '.system'), { recursive: true });
      spawnSync('git', ['init', '--quiet'], { cwd: path.join(home, '.agents', '.system'), encoding: 'utf-8' });
      fs.mkdirSync(path.join(home, '.agents', 'daemon'), { recursive: true });
      fs.writeFileSync(path.join(home, '.agents', 'daemon', 'services.yaml'), 'services:\n  secrets-broker: false\n', 'utf-8');

      const res = runSecrets(home, ['unlock', 'some-bundle']);
      expect(res.status).toBe(1);
      expect(res.stderr + res.stdout).toContain('Secrets broker is disabled');
      expect(res.stderr + res.stdout).toContain('agents daemon services enable secrets-broker');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'darwin')('status reports broker disabled without starting anything', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-disabled-status-'));
    try {
      fs.mkdirSync(path.join(home, '.agents', '.system'), { recursive: true });
      spawnSync('git', ['init', '--quiet'], { cwd: path.join(home, '.agents', '.system'), encoding: 'utf-8' });
      fs.mkdirSync(path.join(home, '.agents', 'daemon'), { recursive: true });
      fs.writeFileSync(path.join(home, '.agents', 'daemon', 'services.yaml'), 'services:\n  secrets-broker: false\n', 'utf-8');

      const res = runSecrets(home, ['status']);
      expect(res.status).toBe(0);
      expect(res.stderr + res.stdout).toContain('broker: disabled');
      expect(res.stderr + res.stdout).toContain('agents daemon services enable secrets-broker');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
