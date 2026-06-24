import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the sessions DB under a temp HOME before any module that captures
// the DB path at import time loads.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-cost-test-'));
process.env.HOME = TEST_HOME;

const { Command } = await import('commander');
const { registerCostCommand } = await import('./cost.js');
const { upsertSession, closeDB } = await import('../lib/session/db.js');
const { costOfUsage } = await import('../lib/pricing/index.js');
type SessionMeta = import('../lib/session/types.js').SessionMeta;

const FILES_DIR = path.join(TEST_HOME, 'cost-cmd-files');
fs.mkdirSync(FILES_DIR, { recursive: true });

function seed(
  id: string,
  agent: SessionMeta['agent'],
  timestamp: string,
  costUsd: number,
  durationMs: number,
  project: string,
  topic: string,
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
    topic,
    costUsd,
    durationMs,
  };
  upsertSession(meta, '');
}

/** Run `agents cost <args>` capturing stdout (JSON path) and console.log (TTY path). */
async function runCost(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerCostCommand(program);

  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
    chunks.push(typeof c === 'string' ? c : c.toString());
    return true;
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => {
    chunks.push(a.join(' '));
  });
  try {
    await program.parseAsync(['node', 'agents', 'cost', ...args]);
  } finally {
    writeSpy.mockRestore();
    logSpy.mockRestore();
  }
  return chunks.join('\n');
}

describe('agents cost', () => {
  beforeAll(() => {
    // Two priced opus sessions and one haiku, spread over two days / projects.
    const big = costOfUsage({ model: 'claude-opus-4', inputTokens: 2_000_000, outputTokens: 1_000_000 });   // ~$35
    const mid = costOfUsage({ model: 'claude-opus-4', inputTokens: 1_000_000, outputTokens: 200_000 });      // ~$10
    const small = costOfUsage({ model: 'claude-haiku-4', inputTokens: 500_000, outputTokens: 100_000 });     // ~$1
    seed('big0001', 'claude', '2026-05-20T10:00:00.000Z', big, 3_600_000, 'rush', 'expensive refactor');
    seed('mid0002', 'claude', '2026-05-21T10:00:00.000Z', mid, 1_800_000, 'agents-cli', 'mid task');
    seed('sml0003', 'codex', '2026-05-21T12:00:00.000Z', small, 300_000, 'agents-cli', 'small fix');
  });

  afterAll(() => {
    closeDB();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('--json reports totals, daily, breakdown, and topSessions', async () => {
    const out = await runCost(['--json']);
    const data = JSON.parse(out);
    expect(data.pricingVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.totals.sessionCount).toBe(3);
    expect(data.totals.costUsd).toBeGreaterThan(0);
    // top sessions ordered by cost desc, priciest first
    expect(data.topSessions[0].id).toBe('big0001');
    expect(data.topSessions[0].costUsd).toBeGreaterThan(data.topSessions[1].costUsd);
    // daily has the two seeded days
    const dailyKeys = data.daily.map((d: any) => d.key);
    expect(dailyKeys).toContain('2026-05-20');
    expect(dailyKeys).toContain('2026-05-21');
  });

  it('renders a histogram, top-sessions, and per-agent breakdown in TTY mode', async () => {
    const out = await runCost([]);
    expect(out).toContain('Daily');
    expect(out).toContain('Top sessions by cost');
    expect(out).toContain('By agent');
    // sparkline block char present
    expect(out).toMatch(/[▁▂▃▄▅▆▇█]/);
    // priciest session topic surfaces
    expect(out).toContain('expensive refactor');
    // dollar figure rendered cents-precise
    expect(out).toMatch(/\$\d+\.\d{2}/);
  });

  it('--by project groups the breakdown by project', async () => {
    const out = await runCost(['--by', 'project', '--json']);
    const data = JSON.parse(out);
    expect(data.breakdown.by).toBe('project');
    const keys = data.breakdown.rows.map((r: any) => r.key);
    expect(keys).toContain('rush');
    expect(keys).toContain('agents-cli');
  });
});
