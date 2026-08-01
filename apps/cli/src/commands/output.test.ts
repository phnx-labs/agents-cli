import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the sessions DB (and repo scan root) under a temp HOME before any
// module that captures the DB path at import time loads.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-output-test-'));
process.env.HOME = TEST_HOME;

const { Command } = await import('commander');
const { registerOutputCommand } = await import('./output.js');
const { upsertSession, closeDB } = await import('../lib/session/db.js');
type SessionMeta = import('../lib/session/types.js').SessionMeta;

const FILES_DIR = path.join(TEST_HOME, 'output-cmd-files');
fs.mkdirSync(FILES_DIR, { recursive: true });

function seed(
  id: string,
  agent: SessionMeta['agent'],
  timestamp: string,
  costUsd: number,
  outputTokens: number,
  tokenCount: number,
  project: string,
): void {
  const filePath = path.join(FILES_DIR, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  const meta: SessionMeta = {
    id,
    shortId: id.slice(0, 8),
    agent,
    timestamp,
    project,
    cwd: FILES_DIR,
    filePath,
    topic: `${agent} work`,
    costUsd,
    outputTokens,
    tokenCount,
  };
  upsertSession(meta, '');
}

/** Run `agents output <args>` capturing stdout (JSON) and console.log (TTY). */
async function runOutput(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerOutputCommand(program);

  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
    chunks.push(typeof c === 'string' ? c : c.toString());
    return true;
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => {
    chunks.push(a.join(' '));
  });
  try {
    await program.parseAsync(['node', 'agents', 'output', ...args]);
  } finally {
    writeSpy.mockRestore();
    logSpy.mockRestore();
  }
  return chunks.join('\n');
}

// A wide --since so the fixed-date seeds are always in-window; --no-prs to keep
// tests offline (real gh is not mocked — that path is exercised manually).
const BASE = ['--since', '2020-01-01', '--no-prs'];

describe('agents output', () => {
  beforeAll(() => {
    // token_count is deliberately >> outputTokens to model cache-read inflation.
    seed('big0001', 'claude', '2026-05-20T10:00:00.000Z', 30, 1_000_000, 50_000_000, 'rush');
    seed('mid0002', 'claude', '2026-05-21T10:00:00.000Z', 10, 400_000, 12_000_000, 'agents-cli');
    seed('cdx0003', 'codex', '2026-05-21T12:00:00.000Z', 2, 100_000, 3_000_000, 'agents-cli');
  });

  afterAll(() => {
    closeDB();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('--json leads with real output tokens, not the inflated total', async () => {
    const out = await runOutput([...BASE, '--json']);
    const d = JSON.parse(out);
    expect(d.pricingVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.burn.sessionCount).toBe(3);
    expect(d.burn.costUsd).toBeCloseTo(42, 5);
    expect(d.burn.outputTokens).toBe(1_500_000);
    // The honest metric is far below the cache-inflated total.
    expect(d.burn.tokenCount).toBe(65_000_000);
    expect(d.burn.outputTokens).toBeLessThan(d.burn.tokenCount / 10);
  });

  it('computes burn-vs-output ratios', async () => {
    const out = await runOutput([...BASE, '--json']);
    const d = JSON.parse(out);
    // No PRs/commits in the temp HOME, so per-PR/per-commit are null...
    expect(d.ratios.costPerPr).toBeNull();
    expect(d.ratios.costPerCommit).toBeNull();
    // ...but output-tokens-per-dollar is defined: 1.5M / $42.
    expect(d.ratios.outputTokensPerUsd).toBeCloseTo(1_500_000 / 42, 2);
  });

  it('--by agent breakdown carries per-agent output tokens', async () => {
    const out = await runOutput([...BASE, '--by', 'agent', '--json']);
    const d = JSON.parse(out);
    expect(d.breakdown.by).toBe('agent');
    const byKey = Object.fromEntries(d.breakdown.rows.map((r: any) => [r.key, r]));
    expect(byKey.claude.outputTokens).toBe(1_400_000);
    expect(byKey.codex.outputTokens).toBe(100_000);
  });

  it('--by project groups by project', async () => {
    const out = await runOutput([...BASE, '--by', 'project', '--json']);
    const d = JSON.parse(out);
    const keys = d.breakdown.rows.map((r: any) => r.key);
    expect(keys).toContain('rush');
    expect(keys).toContain('agents-cli');
  });

  it('renders the burn/output table and shipped section in TTY mode', async () => {
    const out = await runOutput([...BASE]);
    expect(out).toContain('Output');
    expect(out).toContain('burned');
    expect(out).toContain('output tokens');
    expect(out).toContain('By agent');
    expect(out).toContain('Shipped');
    // Compact token formatting (1.5M).
    expect(out).toMatch(/\dM|\dK/);
    // Honesty footer present.
    expect(out).toContain('not counted');
  });
});
