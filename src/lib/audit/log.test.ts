import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  appendAuditRecord,
  verifyAuditChain,
  readAuditLog,
  getAuditLogPath,
  GENESIS_HASH,
  type AuditEntry,
} from './log.js';

/** Absolute path to the log module under test — imported by the spawned workers. */
const LOG_MODULE = fileURLToPath(new URL('./log.ts', import.meta.url));

/** Resolve a `bun` executable: the runtime that runs the real suite (setup-bun in CI). */
function bunBin(): string {
  const candidates = [
    process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin', 'bun') : '',
    path.join(os.homedir(), '.bun', 'bin', 'bun'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'bun'; // fall back to PATH (CI: oven-sh/setup-bun)
}

function tmpLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-audit-test-'));
  return path.join(dir, 'log.jsonl');
}

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: '2026-07-05T12:00:00.000Z',
    agent: 'claude',
    version: '2.1.170',
    repo: 'git@github.com:phnx-labs/agents-cli.git',
    mode: 'edit',
    outcome: 'ok',
    exit: 0,
    ...overrides,
  };
}

describe('audit hash chain', () => {
  it('links records genesis -> prev -> prev and verifies clean', () => {
    const log = tmpLog();
    const r0 = appendAuditRecord(entry({ mode: 'plan' }), log);
    const r1 = appendAuditRecord(entry({ mode: 'edit', exit: 0 }), log);
    const r2 = appendAuditRecord(entry({ mode: 'skip', outcome: 'fail', exit: 1 }), log);

    // The chain is anchored at GENESIS and each record points at the prior hash.
    expect(r0.prevHash).toBe(GENESIS_HASH);
    expect(r1.prevHash).toBe(r0.hash);
    expect(r2.prevHash).toBe(r1.hash);

    expect(readAuditLog(log)).toHaveLength(3);
    expect(verifyAuditChain(log)).toEqual({ ok: true });
  });

  it('detects a tampered middle record at its index', () => {
    const log = tmpLog();
    appendAuditRecord(entry({ mode: 'plan' }), log);
    appendAuditRecord(entry({ mode: 'edit', outcome: 'ok', exit: 0 }), log); // index 1 — victim
    appendAuditRecord(entry({ mode: 'skip', outcome: 'fail', exit: 1 }), log);

    // Sanity: intact before tampering.
    expect(verifyAuditChain(log)).toEqual({ ok: true });

    // Tamper the MIDDLE record on disk: flip its outcome 'ok' -> 'fail' and exit
    // 0 -> 1, leaving its stored `hash` untouched. The recomputed hash no longer
    // matches, so the chain must fail exactly at index 1.
    const lines = fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean);
    const middle = JSON.parse(lines[1]);
    middle.outcome = 'fail';
    middle.exit = 1;
    lines[1] = JSON.stringify(middle);
    fs.writeFileSync(log, lines.join('\n') + '\n');

    expect(verifyAuditChain(log)).toEqual({ ok: false, brokenAt: 1 });
  });

  it('empty log verifies as ok', () => {
    const log = tmpLog();
    expect(verifyAuditChain(log)).toEqual({ ok: true });
    expect(readAuditLog(log)).toEqual([]);
  });

  it('stores the log under .history (machine-local, gitignored, never synced)', () => {
    // The default path must sit in the durable-runtime bucket, NOT a top-level
    // ~/.agents/ path that `agents repo push` tracks — the token-bearing `repo`
    // field must never reach a version-controlled DotAgents repo (issue #347).
    const p = getAuditLogPath();
    expect(p).toContain(`${path.sep}.history${path.sep}audit${path.sep}`);
    expect(p.endsWith(`${path.sep}log.jsonl`)).toBe(true);
    // Must not sit directly under a synced top-level ~/.agents/audit/ path.
    expect(p).not.toMatch(new RegExp(`\\.agents\\${path.sep}audit\\${path.sep}`));
  });

  it('serializes concurrent appends so the chain never forks', async () => {
    // The real race: N `agents run` processes (parallel teams/routines dispatch)
    // append at once. Without the advisory lock each reads the same last hash
    // and writes prevHash=H, forking the chain into a false "tampered" verdict.
    // Exercise it with REAL OS-level concurrency — one bun subprocess per writer,
    // each importing the actual appendAuditRecord (no mocking of code under test).
    const log = tmpLog();
    const worker = path.join(path.dirname(log), 'worker.ts');
    fs.writeFileSync(
      worker,
      `import { appendAuditRecord } from ${JSON.stringify(LOG_MODULE)};\n` +
      `const [logPath, idx] = process.argv.slice(2);\n` +
      `appendAuditRecord({\n` +
      `  ts: new Date().toISOString(),\n` +
      `  agent: 'claude', version: '2.1.170',\n` +
      `  repo: 'git@github.com:phnx-labs/agents-cli.git',\n` +
      `  mode: 'edit', outcome: 'ok', exit: 0,\n` +
      `}, logPath);\n`,
    );

    const N = 30;
    const bun = bunBin();
    await Promise.all(
      Array.from({ length: N }, (_, i) => new Promise<void>((resolve, reject) => {
        const child = spawn(bun, ['run', worker, log, String(i)], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', d => { err += d; });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`worker ${i} exited ${code}: ${err}`)));
      })),
    );

    // Every writer's record landed, and the chain reproduces end-to-end.
    expect(readAuditLog(log)).toHaveLength(N);
    expect(verifyAuditChain(log)).toEqual({ ok: true });
  }, 30000);

  it('two interleaved appends still chain and verify', async () => {
    // Two writers whose critical sections deliberately overlap in wall-clock:
    // both launch together, each does read-last-hash + append under the lock.
    // The lock forces a total order, so record 1 links off record 0's hash
    // rather than both linking off GENESIS.
    const log = tmpLog();
    const worker = path.join(path.dirname(log), 'worker2.ts');
    fs.writeFileSync(
      worker,
      `import { appendAuditRecord } from ${JSON.stringify(LOG_MODULE)};\n` +
      `const [logPath] = process.argv.slice(2);\n` +
      `appendAuditRecord({ ts: new Date().toISOString(), agent: 'claude', version: '2.1.170',\n` +
      `  repo: 'r', mode: 'edit', outcome: 'ok', exit: 0 }, logPath);\n`,
    );
    const bun = bunBin();
    await Promise.all([0, 1].map(i => new Promise<void>((resolve, reject) => {
      const child = spawn(bun, ['run', worker, log], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`worker ${i} exited ${code}`)));
    })));

    const records = readAuditLog(log);
    expect(records).toHaveLength(2);
    expect(records[0].prevHash).toBe(GENESIS_HASH);
    expect(records[1].prevHash).toBe(records[0].hash); // chained, not both off GENESIS
    expect(verifyAuditChain(log)).toEqual({ ok: true });
  }, 30000);
});
