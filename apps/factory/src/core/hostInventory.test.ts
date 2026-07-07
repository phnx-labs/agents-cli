import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseHostAgents, parseHostMeta, summarizeResources, isSafeHostToken, isSafeCap } from './hostInventory';

const DIR = join(import.meta.dir, 'testdata', 'hostInventory');
const viewJson = readFileSync(join(DIR, 'view-host.json'), 'utf8');
const hostsListJson = readFileSync(join(DIR, 'hosts-list.json'), 'utf8');

describe('parseHostAgents', () => {
  const agents = parseHostAgents(viewJson);

  test('parses every agent + version from real view --json --resources shape', () => {
    expect(agents.map((a) => a.agent)).toEqual(['claude', 'codex']);
    expect(agents[0].versions.map((v) => v.version)).toEqual(['2.1.181', '2.1.170']);
  });

  test('extracts account, default flag, and session/week usage from windows', () => {
    const v = agents[0].versions[0];
    expect(v.isDefault).toBe(true);
    expect(v.signedIn).toBe(true);
    expect(v.email).toBe('muqsit@icloud.com');
    expect(v.plan).toBe('Pro');
    expect(v.sessionPercent).toBe(69);
    expect(v.weekPercent).toBe(22);
  });

  test('signed-out version has null account and null usage', () => {
    const v = agents[0].versions[1];
    expect(v.signedIn).toBe(false);
    expect(v.email).toBeNull();
    expect(v.sessionPercent).toBeNull();
    expect(v.resources).toBeNull();
  });

  test('accepts a single (non-array) agent object too', () => {
    const single = parseHostAgents(JSON.stringify(JSON.parse(viewJson)[0]));
    expect(single).toHaveLength(1);
    expect(single[0].agent).toBe('claude');
  });

  test('malformed JSON yields empty array, never throws', () => {
    expect(parseHostAgents('not json')).toEqual([]);
    expect(parseHostAgents('{}')).toEqual([]);
  });

  test('a null/garbage element inside a versions array is skipped, not thrown', () => {
    const out = parseHostAgents('[{"agent":"claude","versions":[null,42,{"version":"1.0.0"}]}]');
    expect(out[0].versions.map((v) => v.version)).toEqual(['1.0.0']);
  });
});

describe('summarizeResources drift', () => {
  const claudeDefault = parseHostAgents(viewJson)[0].versions[0].resources!;

  test('counts each section', () => {
    expect(claudeDefault.skills).toBe(3);
    expect(claudeDefault.plugins).toBe(2);
    expect(claudeDefault.mcp).toBe(1);
    expect(claudeDefault.commands).toBe(1);
  });

  test('drift counts only non-synced items (new + modified), ignoring synced and project-scoped', () => {
    // skills: 1password=new (drift), audit=synced, browser=project(no syncState);
    // commands: commit=modified (drift). Everything else synced. Total drift = 2.
    expect(claudeDefault.drift).toBe(2);
  });

  test('null/garbage resources summarize to null', () => {
    expect(summarizeResources(null)).toBeNull();
    expect(summarizeResources('x')).toBeNull();
  });
});

describe('parseHostMeta', () => {
  test('finds an ssh-config host and maps its fields', () => {
    const first = JSON.parse(hostsListJson)[0].name as string;
    const meta = parseHostMeta(hostsListJson, first);
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe(first);
    expect(meta!.source).toBe('ssh-config');
    // ssh-config hosts use the alias as their target.
    expect(meta!.target).toBe(first);
  });

  test('returns null for an unknown host', () => {
    expect(parseHostMeta(hostsListJson, 'no-such-host-xyz')).toBeNull();
  });
});

describe('input guards', () => {
  test('accepts real host tokens, rejects shell-smuggling', () => {
    expect(isSafeHostToken('yosemite-s0')).toBe(true);
    expect(isSafeHostToken('muqsit@100.71.4.9')).toBe(true);
    expect(isSafeHostToken('a; rm -rf /')).toBe(false);
    expect(isSafeHostToken('a$(touch pwned)')).toBe(false);
    expect(isSafeHostToken('')).toBe(false);
  });

  test('rejects a leading dash so a value cannot be parsed as a CLI flag', () => {
    expect(isSafeHostToken('-x')).toBe(false);
    expect(isSafeHostToken('--force')).toBe(false);
    expect(isSafeCap('-rf')).toBe(false);
  });

  test('caps are alnum/dash only', () => {
    expect(isSafeCap('gpu')).toBe(true);
    expect(isSafeCap('fast-box')).toBe(true);
    expect(isSafeCap('gpu; rm')).toBe(false);
  });
});
