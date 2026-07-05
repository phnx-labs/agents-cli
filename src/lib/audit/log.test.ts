import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendAuditRecord,
  verifyAuditChain,
  readAuditLog,
  GENESIS_HASH,
  type AuditEntry,
} from './log.js';

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
});
