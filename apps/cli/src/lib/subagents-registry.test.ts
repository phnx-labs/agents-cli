/**
 * Tests for the declarative subagent-target registry. These lock the two
 * things the registry exists to guarantee:
 *   1. Every subagents-capable agent has a shape (no silently-half-wired agent).
 *   2. The generic engine round-trips install -> list -> remove for each layout,
 *      including agents (droid, copilot) that were previously missing arms in
 *      the hand-written per-agent chains.
 *
 * No mocking -- real temp directories on the actual filesystem.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { capableAgents } from './capabilities.js';
import {
  SUBAGENT_TARGETS,
  writeSubagentToHome,
  listInstalledSubagentNames,
  listInstalledSubagentsRich,
  removeSubagentFromHome,
  trashSubagentFromHome,
} from './subagents-registry.js';
import { installSubagentToAgent, listSubagentsForAgent, removeSubagentFromAgent } from './subagents.js';

const tempDirs: string[] = [];
function mkTemp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-registry-'));
  tempDirs.push(d);
  return d;
}
function makeSubagentDir(name: string): string {
  const base = mkTemp();
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'AGENT.md'),
    `---\nname: ${name}\ndescription: Test ${name}\nmodel: gpt-4o\n---\n\nYou are ${name}.`,
    'utf-8',
  );
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('subagent registry completeness', () => {
  it('has a shape for exactly every subagents-capable agent', () => {
    // The capability flag (agents.ts) is the version gate; the registry is the
    // shape. They MUST agree, or a capable agent gets silently half-wired -- the
    // exact drift this registry exists to prevent.
    const capable = capableAgents('subagents').sort();
    const shaped = Object.keys(SUBAGENT_TARGETS).sort();
    expect(shaped).toEqual(capable);
  });
});

describe('generic engine round-trips (droid: previously unwired in subagents.ts)', () => {
  it('installs, lists, and removes a droid subagent via the registry', () => {
    const home = mkTemp();
    const src = makeSubagentDir('reviewer');

    // Install through the public API (was `does not support subagents` before).
    const res = installSubagentToAgent(src, 'reviewer', 'droid', home);
    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(home, '.factory', 'droids', 'reviewer.md'))).toBe(true);

    // Listable (droid had no arm in listSubagentsForAgent before).
    const listed = listSubagentsForAgent('droid', home);
    expect(listed.map((s) => s.name)).toEqual(['reviewer']);
    expect(listed[0].frontmatter.description).toBe('Test reviewer');

    // Removable (droid had no arm in removeSubagentFromAgent before).
    const rm = removeSubagentFromAgent('reviewer', 'droid', home);
    expect(rm.success).toBe(true);
    expect(fs.existsSync(path.join(home, '.factory', 'droids', 'reviewer.md'))).toBe(false);
  });
});

describe('generic engine round-trips (copilot: previously unwired for install/remove)', () => {
  it('installs and lists a copilot subagent as <name>.agent.md', () => {
    const home = mkTemp();
    const src = makeSubagentDir('auditor');

    const res = installSubagentToAgent(src, 'auditor', 'copilot', home);
    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(home, '.copilot', 'agents', 'auditor.agent.md'))).toBe(true);

    const names = listInstalledSubagentNames('copilot', home);
    expect(names).toEqual(['auditor']);
  });
});

describe('trashSubagentFromHome (soft-delete semantics per layout)', () => {
  it('trashes a flat-file subagent as <basename>.<stamp>', () => {
    const home = mkTemp();
    writeSubagentToHome('droid', home, { name: 'w', path: makeSubagentDir('w') });
    const trashDir = path.join(mkTemp(), 'trash');

    const r = trashSubagentFromHome('droid', home, 'w', trashDir, 'STAMP');
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(home, '.factory', 'droids', 'w.md'))).toBe(false);
    expect(fs.existsSync(path.join(trashDir, 'w.md.STAMP'))).toBe(true);
  });

  it('trashes a directory-layout subagent as <stamp>/ (whole dir)', () => {
    const home = mkTemp();
    writeSubagentToHome('openclaw', home, { name: 'c', path: makeSubagentDir('c') });
    const trashDir = path.join(mkTemp(), 'trash');

    const r = trashSubagentFromHome('openclaw', home, 'c', trashDir, 'STAMP');
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(home, '.openclaw', 'c'))).toBe(false);
    // AGENT.md was renamed to AGENTS.md on install and moved with the dir.
    expect(fs.existsSync(path.join(trashDir, 'STAMP', 'AGENTS.md'))).toBe(true);
  });

  it('trashes both Kimi files (yaml + system.md) it emits', () => {
    const home = mkTemp();
    writeSubagentToHome('kimi', home, { name: 'k', path: makeSubagentDir('k') });
    const trashDir = path.join(mkTemp(), 'trash');

    const r = trashSubagentFromHome('kimi', home, 'k', trashDir, 'STAMP');
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(trashDir, 'k.yaml.STAMP'))).toBe(true);
    expect(fs.existsSync(path.join(trashDir, 'k.system.md.STAMP'))).toBe(true);
  });
});

describe('listInstalledSubagentNames excludes the Kimi parent index', () => {
  it('does not surface _agents-cli.yaml as a subagent', () => {
    const home = mkTemp();
    const dir = path.join(home, '.kimi-code', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'real.yaml'), 'version: 1\nagent: { name: real }\n');
    fs.writeFileSync(path.join(dir, '_agents-cli.yaml'), 'version: 1\n');

    expect(listInstalledSubagentNames('kimi', home)).toEqual(['real']);
    // The rich lister agrees.
    expect(listInstalledSubagentsRich('kimi', home).map((s) => s.name)).toEqual(['real']);
  });
});

describe('removeSubagentFromHome / writeSubagentToHome are no-ops for unshaped agents', () => {
  it('returns success without touching disk for an agent with no registry entry', () => {
    const home = mkTemp();
    expect(writeSubagentToHome('amp', home, { name: 'x', path: makeSubagentDir('x') })).toBe(false);
    expect(removeSubagentFromHome('amp', home, 'x').success).toBe(true);
    expect(listInstalledSubagentNames('amp', home)).toEqual([]);
  });
});
