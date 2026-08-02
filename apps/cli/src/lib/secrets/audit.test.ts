/**
 * Tests for the canonical secret-access/unlock audit emitter.
 *
 * Two layers, both on the real path (no mocking of the emit sink or the decrypt):
 *  1. `emitSecretAudit` writes a value-free `secrets.get` / `secrets.unlocked`
 *     record to the append-only audit log, tagged with the resolving agent, at
 *     audit level, non-milestone, and surfaced by `agents events`.
 *  2. The real bundle read chokepoint (`readAndResolveBundleEnv`, file backend so
 *     it runs cross-platform with real AES-GCM crypto) emits `secrets.get` with
 *     the right metadata and never the decrypted value.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { emitSecretAudit, resolveAuditAgent } from './audit.js';
import { query, levelFor, _resetForTest } from '../events.js';
import { readUnifiedEvents } from '../event-stream.js';
import { MILESTONE_EVENTS } from '../activity.js';
import {
  bundleItemStore,
  keychainRef,
  readAndResolveBundleEnv,
  writeBundle,
  type SecretsBundle,
} from './bundles.js';
import { _resetFileStoreForTest } from './filestore.js';
import { secretsKeychainItem, setKeychainBackendForTest, type KeychainBackend } from './index.js';
import { saveSession } from './session-store.js';
import { GLOBAL_HARNESS } from './scope.js';

const tmpDirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secret-audit-'));
  tmpDirs.push(d);
  return d;
}

/** Redirect the audit sink to a temp file and give an empty activity root. */
let activityRoot: string;
function setupEvents(): void {
  _resetForTest(path.join(tempDir(), 'events.jsonl'));
  activityRoot = tempDir();
}

afterEach(() => {
  delete process.env.AGENTS_AGENT_NAME;
  _resetForTest();
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tmpDirs.length = 0;
});

describe('emitSecretAudit', () => {
  it('writes a value-free secrets.get to the audit log, tagged with the agent', () => {
    setupEvents();
    process.env.AGENTS_AGENT_NAME = 'codex';
    emitSecretAudit({
      event: 'secrets.get',
      bundle: 'prod',
      operation: 'export to shell',
      source: 'reveal',
      status: 'success',
      keyCount: 2,
      keys: ['API_KEY', 'DB_URL'],
    });

    const recs = query({ eventTypes: ['secrets.get'] });
    expect(recs).toHaveLength(1);
    const r = recs[0];
    expect(r.event).toBe('secrets.get');
    expect(r.module).toBe('secrets');
    expect(r.level).toBe('audit');
    expect(r.bundle).toBe('prod');
    expect(r.agent).toBe('codex');
    expect(r.keys).toEqual(['API_KEY', 'DB_URL']);
    // Metadata only — the record must never carry a value column.
    expect(r).not.toHaveProperty('value');
    expect(r).not.toHaveProperty('env');
  });

  it('records secrets.unlocked as an audit, non-milestone event that `agents events` surfaces', () => {
    setupEvents();
    emitSecretAudit({
      event: 'secrets.unlocked',
      bundle: 'ci',
      operation: 'unlock',
      source: 'broker+durable',
      status: 'success',
      keyCount: 1,
      keys: ['TOKEN'],
      agent: '*',
      ttlMs: 604_800_000,
    });

    // Persisted at audit level (the audit trail) ...
    expect(levelFor('secrets.unlocked')).toBe('audit');
    // ... and NOT a milestone, so `agents activity` / `agents feed` are not
    // required to surface it (requirement 2: operational / raw only) ...
    expect((MILESTONE_EVENTS as readonly string[])).not.toContain('secrets.unlocked');
    // ... yet the raw `agents events` stream does surface it.
    const surfaced = readUnifiedEvents({ module: 'secrets', activityRoot });
    const r = surfaced.find((e) => e.event === 'secrets.unlocked');
    expect(r).toBeDefined();
    expect(r!.bundle).toBe('ci');
    expect(r!.agent).toBe('*');
    expect(r!.ttlMs).toBe(604_800_000);
    expect(r!.keys).toEqual(['TOKEN']);
    expect(r!).not.toHaveProperty('value');
  });

  it('resolveAuditAgent prefers the explicit scope, else $AGENTS_AGENT_NAME, else undefined', () => {
    delete process.env.AGENTS_AGENT_NAME;
    expect(resolveAuditAgent('claude')).toBe('claude');
    process.env.AGENTS_AGENT_NAME = 'kimi';
    expect(resolveAuditAgent()).toBe('kimi');
    expect(resolveAuditAgent('grok')).toBe('grok');
    delete process.env.AGENTS_AGENT_NAME;
    expect(resolveAuditAgent()).toBeUndefined();
  });

  it('omits the agent field entirely when no scope is known', () => {
    setupEvents();
    delete process.env.AGENTS_AGENT_NAME;
    emitSecretAudit({ event: 'secrets.get', bundle: 'b', keyCount: 0 });
    const r = query({ eventTypes: ['secrets.get'] })[0];
    expect(r).not.toHaveProperty('agent');
  });
});

describe('secret access audit — real read path (file backend)', () => {
  let restore: KeychainBackend | null = null;
  const PASS = 'audit-test-passphrase';

  beforeEach(() => {
    setupEvents();
    // In-memory keychain so the keychain branch never touches the real Keychain.
    const store = new Map<string, { value: string }>();
    const backend: KeychainBackend = {
      has: (i) => store.has(i),
      get: (i) => { const v = store.get(i); if (!v) throw new Error(`missing ${i}`); return v.value; },
      set: (i, v) => { store.set(i, { value: v }); },
      delete: (i) => store.delete(i),
      list: (p) => [...store.keys()].filter((k) => k.startsWith(p)),
    };
    restore = setKeychainBackendForTest(backend);
    process.env.AGENTS_SECRETS_PASSPHRASE = PASS;
    _resetFileStoreForTest({ fileDir: tempDir(), passphrase: PASS });
  });

  afterEach(() => {
    setKeychainBackendForTest(restore);
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    _resetFileStoreForTest();
  });

  it('readAndResolveBundleEnv emits an agent-tagged secrets.get with no value that `agents events` surfaces', () => {
    const bundle: SecretsBundle = { name: 'rel', backend: 'file', vars: {} };
    bundleItemStore('file').set(secretsKeychainItem('rel', 'TOKEN'), 'sealed-value');
    bundle.vars['TOKEN'] = keychainRef('TOKEN');
    writeBundle(bundle);

    const { env } = readAndResolveBundleEnv('rel', { caller: 'command deploy', agent: 'claude' });
    expect(env.TOKEN).toBe('sealed-value'); // real decrypt happened

    const recs = query({ eventTypes: ['secrets.get'] });
    expect(recs).toHaveLength(1);
    const r = recs[0];
    expect(r.module).toBe('secrets');
    expect(r.bundle).toBe('rel');
    expect(r.operation).toBe('command deploy');
    expect(r.agent).toBe('claude');
    expect(r.keys).toEqual(['TOKEN']);
    expect(r.status).toBe('success');
    // The decrypted value never enters the audit record.
    expect(JSON.stringify(r)).not.toContain('sealed-value');

    // And the read shows up in the raw `agents events` stream.
    const surfaced = readUnifiedEvents({ module: 'secrets', activityRoot });
    expect(surfaced.map((e) => e.event)).toContain('secrets.get');
  });

  it('fast-path durable-session read audits with the resolved harness scope, not opts.agent', () => {
    // No explicit agent and no $AGENTS_AGENT_NAME ⇒ the reader resolves to the
    // GLOBAL scope ('*'). The keychain backend fast-path misses the broker (no
    // socket off darwin) and falls through to the durable-session hit — the
    // branch whose audit emit this fix corrects. Before the fix that emit passed
    // `opts.agent` (undefined), so a global-scoped read was logged with no agent
    // at all; it must instead carry the resolved scope, '*'.
    delete process.env.AGENTS_AGENT_NAME;
    // The agent fast-path is off by default in this environment via
    // AGENTS_SECRETS_NO_AGENT=1; clear it so the keychain fast-path (and its
    // durable-session fallback) actually runs. Restored in afterEach.
    const prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
    delete process.env.AGENTS_SECRETS_NO_AGENT;
    try {
    const bundle: SecretsBundle = { name: 'warm', vars: { TOKEN: keychainRef('TOKEN') } };
    saveSession('warm', {
      bundle,
      env: { TOKEN: 'sealed-value' },
      expiresAt: Date.now() + 60_000,
      sleepPersist: false,
      harness: GLOBAL_HARNESS,
    });

    const { env } = readAndResolveBundleEnv('warm', { caller: 'export to shell' });
    expect(env.TOKEN).toBe('sealed-value'); // served from the durable session

    const recs = query({ eventTypes: ['secrets.get'] });
    expect(recs).toHaveLength(1);
    const r = recs[0];
    expect(r.source).toBe('session');
    expect(r.bundle).toBe('warm');
    expect(r.agent).toBe('*'); // the resolved harness scope, not undefined
    } finally {
      if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
      else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
    }
  });
});
