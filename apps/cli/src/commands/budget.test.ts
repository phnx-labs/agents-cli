import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate HOME before any module that captures path constants at import time.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-budget-test-'));
process.env.HOME = TEST_HOME;

const { Command } = await import('commander');
const { registerBudgetCommand } = await import('./budget.js');
const { recordSpend, localDay } = await import('../lib/budget/ledger.js');
const { getHistoryDir } = await import('../lib/state.js');

const PROJECT = TEST_HOME; // run the command with cwd == TEST_HOME
const userYaml = path.join(TEST_HOME, '.agents', 'agents.yaml');

function writeBudget(yamlBody: string): void {
  fs.mkdirSync(path.dirname(userYaml), { recursive: true });
  fs.writeFileSync(userYaml, yamlBody);
}

/** Run `agents budget <args>` from cwd=PROJECT, capturing stdout + console.log. */
async function runBudget(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerBudgetCommand(program);

  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
    chunks.push(typeof c === 'string' ? c : c.toString());
    return true;
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => {
    chunks.push(a.join(' '));
  });
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(PROJECT);
  try {
    await program.parseAsync(['node', 'agents', 'budget', ...args]);
  } finally {
    writeSpy.mockRestore();
    logSpy.mockRestore();
    cwdSpy.mockRestore();
  }
  return chunks.join('\n');
}

const ledgerPath = () => path.join(getHistoryDir(), 'spend', 'ledger.jsonl');

describe('agents budget', () => {
  beforeAll(() => {
    writeBudget('budget:\n  per_run: 5\n  per_day: 50\n  per_project: 100\n  on_exceed: block\n');
    // Cross-vendor spend today against the same project: claude $5 + codex $1.25.
    recordSpend({ runId: 'rA', agent: 'claude', project: PROJECT, model: 'claude-opus-4', usage: { inputTokens: 1_000_000 }, source: 'run', ts: new Date() }, ledgerPath());
    recordSpend({ runId: 'rB', agent: 'codex', project: PROJECT, model: 'gpt-5', usage: { inputTokens: 1_000_000 }, source: 'run', ts: new Date() }, ledgerPath());
  });

  afterAll(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('renders caps and spend-to-cap (cross-vendor day total)', async () => {
    const out = await runBudget([]);
    expect(out).toContain('per_run');
    expect(out).toContain('per_day');
    expect(out).toContain('per_project');
    // Day spend is claude $5 + codex $1.25 = $6.25 against the $50 cap.
    expect(out).toContain('$6.25');
    expect(out).toContain('$50.00');
  });

  it('--json emits the full snapshot with cross-vendor spend', async () => {
    const out = await runBudget(['--json']);
    const parsed = JSON.parse(out);
    expect(parsed.caps.per_run).toBe(5);
    expect(parsed.caps.per_day).toBe(50);
    expect(parsed.on_exceed).toBe('block');
    expect(parsed.spend.day).toBeCloseTo(6.25, 6);
    expect(parsed.spend.project).toBeCloseTo(6.25, 6);
    expect(parsed.configured).toBe(true);
    expect(parsed.day).toBe(localDay());
  });

  it('shows "no caps configured" when budget is empty', async () => {
    writeBudget('');
    const out = await runBudget(['--json']);
    const parsed = JSON.parse(out);
    expect(parsed.configured).toBe(false);
  });
});
