import { describe, expect, it } from 'vitest';
import {
  planAutoDispatch,
  isEligible,
  priorityRank,
  dispatchPrompt,
  autoDispatchTick,
  type AutoDispatchProject,
  type DelegatedIssue,
  type LinearGateway,
  type Dispatcher,
} from './auto-dispatch.js';

const proj = (over: Partial<AutoDispatchProject> = {}): AutoDispatchProject => ({
  id: 'p1',
  name: 'Agents CLI',
  linearProjectId: 'lin-p1',
  repoSlug: 'phnx-labs/agents-cli',
  autoDispatch: true,
  maxAgents: 3,
  ...over,
});

const issue = (id: string, priority = 2, delegate = 'Claude'): DelegatedIssue => ({
  id,
  identifier: id,
  title: `${id} title`,
  delegateName: delegate,
  priority,
});

describe('isEligible — opt-in gating', () => {
  it('is eligible only with autoDispatch=true, positive cap, and a linearProjectId', () => {
    expect(isEligible(proj())).toBe(true);
    expect(isEligible(proj({ autoDispatch: false }))).toBe(false);
    expect(isEligible(proj({ autoDispatch: undefined }))).toBe(false);
    expect(isEligible(proj({ maxAgents: 0 }))).toBe(false);
    expect(isEligible(proj({ maxAgents: undefined }))).toBe(false);
    expect(isEligible(proj({ linearProjectId: undefined }))).toBe(false);
  });
});

describe('priorityRank', () => {
  it('orders urgent first and none last', () => {
    expect(priorityRank(1)).toBeLessThan(priorityRank(2));
    expect(priorityRank(4)).toBeLessThan(priorityRank(0));
  });
});

describe('planAutoDispatch', () => {
  it('dispatches nothing for a project that has not opted in', () => {
    const plan = planAutoDispatch([proj({ autoDispatch: false })], {}, { p1: [issue('RUSH-1')] });
    expect(plan).toEqual([]);
  });

  it('respects the cap minus in-flight', () => {
    const plan = planAutoDispatch(
      [proj({ maxAgents: 3 })],
      { p1: 1 },
      { p1: [issue('RUSH-1'), issue('RUSH-2'), issue('RUSH-3'), issue('RUSH-4')] },
    );
    expect(plan.map((d) => d.identifier)).toEqual(['RUSH-1', 'RUSH-2']);
  });

  it('dispatches nothing when already at or over the cap', () => {
    const plan = planAutoDispatch([proj({ maxAgents: 2 })], { p1: 2 }, { p1: [issue('RUSH-1')] });
    expect(plan).toEqual([]);
  });

  it('takes highest-priority issues first', () => {
    const plan = planAutoDispatch(
      [proj({ maxAgents: 2 })],
      { p1: 0 },
      { p1: [issue('RUSH-low', 4), issue('RUSH-urgent', 1), issue('RUSH-none', 0), issue('RUSH-high', 2)] },
    );
    expect(plan.map((d) => d.identifier)).toEqual(['RUSH-urgent', 'RUSH-high']);
  });

  it('carries delegate + repo + provider + title through to the plan', () => {
    const plan = planAutoDispatch([proj({ provider: 'codex' })], { p1: 0 }, { p1: [issue('RUSH-1', 2, 'Codex')] });
    expect(plan[0]).toMatchObject({
      delegateName: 'Codex',
      repoSlug: 'phnx-labs/agents-cli',
      provider: 'codex',
      issueId: 'RUSH-1',
      title: 'RUSH-1 title',
    });
  });
});

describe('dispatchPrompt', () => {
  it('names the ticket + title', () => {
    expect(dispatchPrompt('RUSH-1', 'Fix login')).toContain('RUSH-1');
    expect(dispatchPrompt('RUSH-1', 'Fix login')).toContain('Fix login');
  });
});

describe('autoDispatchTick', () => {
  const gw = (over: Partial<LinearGateway> = {}): LinearGateway => ({
    countInFlight: async () => 0,
    fetchDelegatedTodo: async () => [issue('RUSH-1'), issue('RUSH-2')],
    markStarted: async () => {},
    ...over,
  });
  const disp = (over: Partial<Dispatcher> = {}): Dispatcher => ({
    dispatch: async () => ({ id: 'task-x' }),
    ...over,
  });

  it('no-ops when no project is opted in', async () => {
    let dispatched = 0;
    const out = await autoDispatchTick({
      projects: [proj({ autoDispatch: false })],
      linear: gw(),
      dispatcher: disp({ dispatch: async () => { dispatched++; return { id: 'x' }; } }),
    });
    expect(out).toEqual([]);
    expect(dispatched).toBe(0);
  });

  it('dispatches via the provider, then marks the ticket started', async () => {
    const dispatchedAgents: string[] = [];
    const marked: string[] = [];
    const out = await autoDispatchTick({
      projects: [proj({ maxAgents: 5 })],
      linear: gw({ markStarted: async (id) => { marked.push(id); } }),
      dispatcher: disp({ dispatch: async ({ agent }) => { dispatchedAgents.push(agent); return { id: 't' }; } }),
    });
    expect(out.map((d) => d.identifier)).toEqual(['RUSH-1', 'RUSH-2']);
    expect(dispatchedAgents).toEqual(['claude', 'claude']); // delegate lower-cased
    expect(marked).toEqual(['RUSH-1', 'RUSH-2']);
  });

  it('does NOT mark started if the dispatch itself fails', async () => {
    let marked = 0;
    const out = await autoDispatchTick({
      projects: [proj({ maxAgents: 5 })],
      linear: gw({ markStarted: async () => { marked++; } }),
      dispatcher: disp({ dispatch: async () => { throw new Error('provider down'); } }),
    });
    expect(out).toEqual([]);
    expect(marked).toBe(0);
  });

  it('still counts as dispatched if only the mark-started bookkeeping fails', async () => {
    const out = await autoDispatchTick({
      projects: [proj({ maxAgents: 5 })],
      linear: gw({ markStarted: async () => { throw new Error('linear hiccup'); } }),
      dispatcher: disp(),
    });
    expect(out.map((d) => d.identifier)).toEqual(['RUSH-1', 'RUSH-2']);
  });

  it('fails closed — a Linear read error dispatches nothing for that project', async () => {
    let dispatched = 0;
    const out = await autoDispatchTick({
      projects: [proj()],
      linear: gw({ countInFlight: async () => { throw new Error('linear down'); } }),
      dispatcher: disp({ dispatch: async () => { dispatched++; return { id: 'x' }; } }),
    });
    expect(out).toEqual([]);
    expect(dispatched).toBe(0);
  });
});
