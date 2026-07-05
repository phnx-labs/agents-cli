/**
 * Declarative dynamic fan-out (issue #343).
 *
 * The `for_each:` construct is a declarative layer over the existing teams
 * substrate: a producer emits a list at runtime, one stage teammate runs per
 * item, optionally gated by a verify panel. These tests exercise the real
 * critical path with no mocking:
 *
 *   - `parseForEachBlock` / `parseVerifyBlock` — the defensive frontmatter parse.
 *   - `expandForEach` — the pure expansion into teammate descriptors.
 *   - Real `AgentProcess` + `AgentManager` persistence — proving the expansion
 *     stages a valid `--after` DAG the supervisor can pick up mid-flight.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  AgentManager,
  AgentProcess,
  AgentStatus,
  type AgentType,
} from '../agents.js';
import {
  parseForEachBlock,
  parseVerifyBlock,
  expandForEach,
  renderForEachTemplate,
  DEFAULT_FOR_EACH_CAP,
  type ForEachSpec,
  type ForEachTeammate,
} from '../../workflows.js';

describe('parseForEachBlock — defensive coercion (issue #343)', () => {
  it('parses a well-formed for_each block with a verify panel', () => {
    const spec = parseForEachBlock({
      produce: "rg -l 'router\\.(get|post)' src/routes/",
      agent: 'auth-checker',
      name: 'audit',
      prompt: 'Audit {{item}} for missing auth checks',
      concurrency: 8,
      max_items: 50,
      verify: { agent: 'skeptic', votes: 3, keep_if: 'majority' },
    });
    expect(spec).toEqual({
      produce: "rg -l 'router\\.(get|post)' src/routes/",
      agent: 'auth-checker',
      name: 'audit',
      prompt: 'Audit {{item}} for missing auth checks',
      concurrency: 8,
      max_items: 50,
      verify: { agent: 'skeptic', votes: 3, keep_if: 'majority' },
    });
  });

  it('drops the block unless both agent and prompt are present', () => {
    expect(parseForEachBlock({ agent: 'x' })).toBeUndefined();
    expect(parseForEachBlock({ prompt: 'do {{item}}' })).toBeUndefined();
    expect(parseForEachBlock({ agent: '  ', prompt: 'p' })).toBeUndefined();
    expect(parseForEachBlock(undefined)).toBeUndefined();
    expect(parseForEachBlock([1, 2])).toBeUndefined();
    expect(parseForEachBlock('for_each')).toBeUndefined();
  });

  it('captures an itemsRef from a for_each reference or items_ref', () => {
    expect(parseForEachBlock({ for_each: '${endpoints}', agent: 'a', prompt: 'p' }))
      .toMatchObject({ itemsRef: '${endpoints}' });
    expect(parseForEachBlock({ items_ref: '${prior}', agent: 'a', prompt: 'p' }))
      .toMatchObject({ itemsRef: '${prior}' });
  });

  it('drops malformed numeric fields rather than passing a bad shape', () => {
    const spec = parseForEachBlock({
      agent: 'a',
      prompt: 'p',
      concurrency: 0,
      max_items: 2.5,
    })!;
    expect(spec.concurrency).toBeUndefined();
    expect(spec.max_items).toBeUndefined();
  });

  it('parseVerifyBlock defaults votes to 1 and keep_if to majority', () => {
    expect(parseVerifyBlock({ agent: 'skeptic' }))
      .toEqual({ agent: 'skeptic', votes: 1, keep_if: 'majority' });
    // An unknown keep_if falls back to majority; a bad votes falls back to 1.
    expect(parseVerifyBlock({ agent: 'skeptic', votes: -3, keep_if: 'whenever' }))
      .toEqual({ agent: 'skeptic', votes: 1, keep_if: 'majority' });
    // No agent -> no panel.
    expect(parseVerifyBlock({ votes: 3 })).toBeUndefined();
  });

  it('drops a malformed verify sub-block but keeps the for_each', () => {
    const spec = parseForEachBlock({ agent: 'a', prompt: 'p', verify: { votes: 3 } })!;
    expect(spec.verify).toBeUndefined();
    expect(spec.agent).toBe('a');
  });
});

describe('renderForEachTemplate', () => {
  it('substitutes item, index (0-based), and n (1-based)', () => {
    expect(renderForEachTemplate('audit {{item}} (#{{n}}, idx {{index}})', 'src/a.ts', 2))
      .toBe('audit src/a.ts (#3, idx 2)');
  });
  it('leaves unknown tokens intact', () => {
    expect(renderForEachTemplate('{{item}} — {{unknown}}', 'x', 0)).toBe('x — {{unknown}}');
  });
});

describe('expandForEach — one stage per produced item + verify (issue #343)', () => {
  const spec: ForEachSpec = {
    agent: 'auth-checker',
    name: 'audit',
    prompt: 'Audit {{item}} for missing auth checks',
    verify: { agent: 'skeptic', votes: 3, keep_if: 'majority' },
  };

  it('fans out exactly one stage teammate per item, N unknown until produced', () => {
    const items = ['src/routes/a.ts', 'src/routes/b.ts', 'src/routes/c.ts'];
    const { teammates, producedCount, usedCount, truncated } = expandForEach(spec, items);

    const stages = teammates.filter((t) => t.role === 'stage');
    expect(stages).toHaveLength(items.length);
    expect(stages.map((t) => t.item)).toEqual(items);
    expect(stages.map((t) => t.name)).toEqual(['audit-1', 'audit-2', 'audit-3']);
    // Template substitution happened per item.
    expect(stages[0].prompt).toBe('Audit src/routes/a.ts for missing auth checks');
    expect(producedCount).toBe(3);
    expect(usedCount).toBe(3);
    expect(truncated).toBe(0);
  });

  it('expands `votes` skeptics per item, each depending on that item stage', () => {
    const items = ['a', 'b'];
    const { teammates } = expandForEach(spec, items);

    const verifiers = teammates.filter((t) => t.role === 'verify');
    // 2 items * 3 votes.
    expect(verifiers).toHaveLength(6);

    // Each item's skeptics wait on ONLY that item's stage teammate.
    const forA = verifiers.filter((t) => t.item === 'a');
    expect(forA.map((t) => t.name)).toEqual(['audit-1-verify-1', 'audit-1-verify-2', 'audit-1-verify-3']);
    expect(forA.every((t) => t.after.length === 1 && t.after[0] === 'audit-1')).toBe(true);
    expect(forA.every((t) => t.agentType === 'skeptic')).toBe(true);
    expect(forA.every((t) => t.votes === 3 && t.keep_if === 'majority')).toBe(true);
  });

  it('links stage teammates after the producer when a producerName is given', () => {
    const { teammates } = expandForEach(spec, ['a'], { producerName: 'endpoints' });
    const stage = teammates.find((t) => t.role === 'stage')!;
    expect(stage.after).toEqual(['endpoints']);
  });

  it('omits verify teammates when no verify panel is declared', () => {
    const bare: ForEachSpec = { agent: 'x', prompt: 'do {{item}}' };
    const { teammates } = expandForEach(bare, ['a', 'b']);
    expect(teammates).toHaveLength(2);
    expect(teammates.every((t) => t.role === 'stage')).toBe(true);
  });

  it('enforces the runaway-producer hard cap (default and explicit)', () => {
    const many = Array.from({ length: DEFAULT_FOR_EACH_CAP + 25 }, (_, i) => `item-${i}`);
    const dflt = expandForEach({ agent: 'x', prompt: 'p' }, many);
    expect(dflt.usedCount).toBe(DEFAULT_FOR_EACH_CAP);
    expect(dflt.truncated).toBe(25);
    expect(dflt.teammates.filter((t) => t.role === 'stage')).toHaveLength(DEFAULT_FOR_EACH_CAP);

    const capped = expandForEach({ agent: 'x', prompt: 'p', max_items: 4 }, many);
    expect(capped.usedCount).toBe(4);
    expect(capped.producedCount).toBe(DEFAULT_FOR_EACH_CAP + 25);
    expect(capped.truncated).toBe(DEFAULT_FOR_EACH_CAP + 21);
  });
});

describe('expandForEach stages a valid teams DAG through real persistence', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'foreach-dag-'));
  });
  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  /**
   * Persist an expanded descriptor as a real `AgentProcess` meta.json — the
   * same on-disk shape `AgentManager.spawn` writes and the supervisor rescans.
   * (We plant directly rather than `spawn` so the test needs no installed CLI,
   * exactly like supervisor.test.ts's `plantAgent`.)
   */
  async function plant(team: string, t: ForEachTeammate): Promise<void> {
    const agent = new AgentProcess(
      `agent-${t.name}`,
      team,
      t.agentType as AgentType,
      t.prompt,
      null,
      'edit',
      null,
      AgentStatus.PENDING,
      new Date(),
      null,
      tmpBase,
      null, null, null, null, null, null, null,
      t.name,
      t.after,
      'medium', null, null,
      null,
    );
    await agent.saveMeta();
  }

  it('reloads the fanned-out DAG with correct --after linkage', async () => {
    const spec: ForEachSpec = {
      agent: 'auth-checker',
      name: 'audit',
      prompt: 'Audit {{item}}',
      verify: { agent: 'skeptic', votes: 2, keep_if: 'majority' },
    };
    const items = ['src/routes/a.ts', 'src/routes/b.ts'];
    const { teammates } = expandForEach(spec, items, { producerName: 'endpoints' });

    // Plant the producer plus every expanded teammate as the substrate would.
    const producer = new AgentProcess(
      'agent-endpoints', 'sweep', 'claude' as AgentType, 'produce list',
      null, 'edit', null, AgentStatus.COMPLETED,
      new Date(Date.now() - 100), new Date(),
      tmpBase, null, null, null, null, null, null, null,
      'endpoints', [], 'medium', null, null, null,
    );
    await producer.saveMeta();
    for (const t of teammates) await plant('sweep', t);

    // A fresh manager reads the persisted DAG back off disk — the real path
    // the supervisor uses via rescanFromDisk().
    const mgr = new AgentManager(50, tmpBase);
    const loaded = await mgr.listByTask('sweep');
    const byName = new Map(loaded.map((a) => [a.name, a]));

    // 2 stages + (2 items * 2 votes) verifiers + 1 producer.
    expect(loaded).toHaveLength(2 + 4 + 1);

    // Stages depend on the producer.
    expect(byName.get('audit-1')!.after).toEqual(['endpoints']);
    expect(byName.get('audit-2')!.after).toEqual(['endpoints']);

    // Skeptics depend only on their own item's stage — the verify gate.
    expect(byName.get('audit-1-verify-1')!.after).toEqual(['audit-1']);
    expect(byName.get('audit-1-verify-2')!.after).toEqual(['audit-1']);
    expect(byName.get('audit-2-verify-1')!.after).toEqual(['audit-2']);

    // Everything staged PENDING, waiting on its deps.
    expect(loaded.filter((a) => a.status === AgentStatus.PENDING)).toHaveLength(6);
  });
});
