import { describe, it, expect } from 'vitest';
import { agentKindFromName, shortIdFromName, resolveNamesToSessionIds, resolvePaneIdentity } from './active.js';
import type { HookSessionIndex } from './hook-sessions.js';

// These are pure functions — the DB dependency is injected — so no fixtures or
// tmux are needed. The name-based tier is the recovery that makes a detached
// agent findable when its durable identity records are gone.

describe('agentKindFromName / shortIdFromName (parse ag-<agent>-<shortid>)', () => {
  it('splits a plain agent name', () => {
    expect(agentKindFromName('ag-claude-2373284d')).toBe('claude');
    expect(shortIdFromName('ag-claude-2373284d')).toBe('2373284d');
  });

  it('handles a hyphenated agent kind, anchoring on the 8-hex suffix', () => {
    expect(agentKindFromName('ag-cursor-agent-abcd1234')).toBe('cursor-agent');
    expect(shortIdFromName('ag-cursor-agent-abcd1234')).toBe('abcd1234');
  });

  it('recognizes agents NOT in the ps-scan comm map (grok/kimi) — harness parity', () => {
    expect(agentKindFromName('ag-grok-af7d9ff4')).toBe('grok');
    expect(agentKindFromName('ag-kimi-1deeba96')).toBe('kimi');
  });

  it('rejects non-ag names and malformed suffixes', () => {
    expect(agentKindFromName('main')).toBeUndefined();
    expect(agentKindFromName('bash')).toBeUndefined();
    expect(shortIdFromName('ag-claude-nothex!!')).toBeUndefined();
    // suffix must be exactly 8 hex chars
    expect(agentKindFromName('ag-claude-2373284')).toBeUndefined();
    expect(agentKindFromName('ag-claude-2373284da')).toBeUndefined();
  });
});

describe('resolveNamesToSessionIds (batched short-id -> full UUID)', () => {
  it('maps each ag-* name to its full UUID via the injected resolver', () => {
    const find = (shortIds: string[]) => {
      expect(shortIds).toContain('abcd1234');
      return new Map([['abcd1234', { id: 'abcd1234-0000-0000-0000-000000000001' }]]);
    };
    const out = resolveNamesToSessionIds(
      ['ag-claude-abcd1234', 'main', 'ag-codex-ffffffff'],
      { findSessionsByShortIds: find },
    );
    expect(out.get('ag-claude-abcd1234')).toBe('abcd1234-0000-0000-0000-000000000001');
    expect(out.get('main')).toBeUndefined();
    expect(out.get('ag-codex-ffffffff')).toBeUndefined(); // not returned by the DB
  });

  it('makes exactly ONE batched call regardless of pane count (not per-pane)', () => {
    let calls = 0;
    const find = (_ids: string[]) => { calls++; return new Map<string, { id: string }>(); };
    resolveNamesToSessionIds(
      ['ag-claude-aaaaaaaa', 'ag-codex-bbbbbbbb', 'ag-codex-bbbbbbbb', 'notanagentpane'],
      { findSessionsByShortIds: find },
    );
    expect(calls).toBe(1);
  });

  it('short-circuits with no DB call when no ag-* names are present', () => {
    let calls = 0;
    const find = (_ids: string[]) => { calls++; return new Map<string, { id: string }>(); };
    const out = resolveNamesToSessionIds(['main', 'bash', 'vim'], { findSessionsByShortIds: find });
    expect(calls).toBe(0);
    expect(out.size).toBe(0);
  });
});

describe('resolvePaneIdentity — name-based recovery (the fleet fix)', () => {
  const emptyHook = (): HookSessionIndex => ({ byLaunchId: new Map(), byTerminalId: new Map(), byPid: new Map() });
  const names = new Map([['ag-claude-abcd1234', 'abcd1234-0000-0000-0000-000000000001']]);

  it('recovers a full session id from the pane name when meta AND registry are absent', () => {
    const id = resolvePaneIdentity('%5', 'ag-claude-abcd1234', null, undefined, emptyHook, names);
    expect(id).toEqual({ agent: 'claude', sessionId: 'abcd1234-0000-0000-0000-000000000001' });
  });

  it('surfaces the agent kind even when the short id is not in the DB (id-less but visible)', () => {
    const id = resolvePaneIdentity('%6', 'ag-codex-ffffffff', null, undefined, emptyHook, new Map());
    expect(id).toEqual({ agent: 'codex', sessionId: undefined });
  });

  it('a live registry entry with no id falls back to the name id', () => {
    const id = resolvePaneIdentity(
      '%7', 'ag-claude-abcd1234', null,
      { pid: 9, agent: 'claude', startedAtMs: 1 },
      emptyHook, names,
    );
    expect(id?.sessionId).toBe('abcd1234-0000-0000-0000-000000000001');
  });

  it('still drops a genuinely foreign pane (no name, no meta, no registry)', () => {
    expect(resolvePaneIdentity('%8', 'main', null, undefined, emptyHook, names)).toBeUndefined();
  });
});
