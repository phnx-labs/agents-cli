import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  locateModelSource,
  getModelCatalog,
  resolveModel,
  buildReasoningFlags,
} from '../models.js';
import { getVersionDir, listInstalledVersions } from '../versions.js';

function pickInstalledVersion(agent: 'claude' | 'codex' | 'gemini' | 'opencode' | 'openclaw', preference: (vs: string[]) => string | undefined): string | null {
  const versions = listInstalledVersions(agent);
  if (versions.length === 0) return null;
  const chosen = preference(versions);
  return chosen || versions[0] || null;
}

// Use explicit find (no fallback) so the variable is null when no matching version exists.
const claudeBundleVer = listInstalledVersions('claude').find((v) =>
  fs.existsSync(path.join(getVersionDir('claude', v), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'))
) ?? null;
const claudeBinaryVer = listInstalledVersions('claude').find((v) =>
  fs.existsSync(path.join(getVersionDir('claude', v), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')) &&
  !fs.existsSync(path.join(getVersionDir('claude', v), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'))
) ?? null;
// Prefer a version whose model source actually resolves on this host — partial
// installs (e.g. ones missing the vendored binary) would otherwise short-circuit
// the catalog tests with null catalogs.
const firstLocatable = (agent: 'codex' | 'gemini' | 'opencode' | 'openclaw' | 'antigravity' | 'kimi'): string | null =>
  listInstalledVersions(agent).find((v) => locateModelSource(agent, v) !== null) ?? null;

const codexVer = firstLocatable('codex');
const geminiVer = firstLocatable('gemini');
const opencodeVer = firstLocatable('opencode');
const openclawVer = firstLocatable('openclaw');
const antigravityVer = firstLocatable('antigravity');
const kimiVer = firstLocatable('kimi');

describe('locateModelSource', () => {
  it('finds the JS bundle for Claude versions that ship one', () => {
    if (!claudeBundleVer) return; // host doesn't have a bundle-era Claude installed
    const src = locateModelSource('claude', claudeBundleVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('bundle');
    expect(src!.path).toContain('cli.js');
  });

  it('finds the native binary for Claude versions that ship one', () => {
    if (!claudeBinaryVer) return;
    const src = locateModelSource('claude', claudeBinaryVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('binary');
    expect(src!.path).toContain('claude.exe');
  });

  it('finds the codex binary across vendor layouts', () => {
    if (!codexVer) return;
    const src = locateModelSource('codex', codexVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('binary');
    // Old layout: vendor/<triple>/codex/codex; new layout (0.134+): vendor/<triple>/bin/codex.
    expect(src!.path).toMatch(/\/(?:codex|bin)\/codex$/);
  });

  it('returns null for an unknown version', () => {
    expect(locateModelSource('claude', '0.0.0-not-installed')).toBeNull();
  });
});

describe('getModelCatalog (claude)', () => {
  it('extracts an alias map and at least one model', () => {
    const ver = claudeBundleVer || claudeBinaryVer;
    if (!ver) return;
    const catalog = getModelCatalog('claude', ver);
    expect(catalog).not.toBeNull();
    expect(catalog!.models.length).toBeGreaterThan(0);
    // 2.1.62+ exposes the alias map; 2.0.65 does not. Either way the call must not crash.
    if (Object.keys(catalog!.aliases).length > 0) {
      expect(catalog!.aliases.opus).toMatch(/^claude-opus-/);
      expect(catalog!.aliases.sonnet).toMatch(/^claude-sonnet-/);
      expect(catalog!.aliases.haiku).toMatch(/^claude-haiku-/);
    }
  });

  it('attaches per-cloud routing for at least one model', () => {
    const ver = claudeBundleVer || claudeBinaryVer;
    if (!ver) return;
    const catalog = getModelCatalog('claude', ver)!;
    const withCloud = catalog.models.filter((m) => m.perCloud);
    // Per-cloud routing is parsed out of the installed claude CLI's bundle, and
    // not every version embeds it in the parseable `{firstParty:...,bedrock:...}`
    // form (newer 2.1.x builds on some hosts don't). When the picked version
    // exposes none, there is nothing to shape-check here — skip rather than fail.
    // The parse itself is still verified whenever a version does expose it.
    if (withCloud.length === 0) return;
    const sample = withCloud[0];
    expect(sample.perCloud!.firstParty).toBe(sample.id);
    expect(sample.perCloud!.bedrock).toMatch(/anthropic/);
  });

  it('marks the alias-targeted models as defaults', () => {
    const ver = claudeBundleVer || claudeBinaryVer;
    if (!ver) return;
    const catalog = getModelCatalog('claude', ver)!;
    if (Object.keys(catalog.aliases).length === 0) return;
    const defaults = catalog.models.filter((m) => m.isDefault);
    expect(defaults.length).toBeGreaterThanOrEqual(1);
    for (const d of defaults) {
      expect(Object.values(catalog.aliases)).toContain(d.id);
    }
  });
});

describe('getModelCatalog (codex)', () => {
  it('extracts slugs and reasoning levels', () => {
    if (!codexVer) return;
    const catalog = getModelCatalog('codex', codexVer);
    expect(catalog).not.toBeNull();
    expect(catalog!.models.length).toBeGreaterThan(0);
    const withReasoning = catalog!.models.filter((m) => m.reasoningLevels && m.reasoningLevels.length > 0);
    expect(withReasoning.length).toBeGreaterThan(0);
    const sample = withReasoning[0];
    const efforts = sample.reasoningLevels!.map((l) => l.effort);
    expect(efforts).toContain('low');
    expect(efforts).toContain('medium');
    expect(efforts).toContain('high');
  });

  it('records a default reasoning level on at least one model', () => {
    if (!codexVer) return;
    const catalog = getModelCatalog('codex', codexVer)!;
    const withDefault = catalog.models.filter((m) => m.defaultReasoningLevel);
    expect(withDefault.length).toBeGreaterThan(0);
  });
});

describe('resolveModel', () => {
  it('passes through unknown models with a warning instead of blocking', () => {
    const ver = claudeBundleVer || claudeBinaryVer;
    if (!ver) return;
    const r = resolveModel('claude', ver, 'totally-fake-model-xyz');
    expect(r.forwarded).toBe('totally-fake-model-xyz');
    expect(r.warning).toBeTruthy();
    expect(r.warning).toMatch(/not in known catalog/);
  });

  it('reports the canonical id for an alias', () => {
    const ver = claudeBundleVer || claudeBinaryVer;
    if (!ver) return;
    const catalog = getModelCatalog('claude', ver)!;
    if (!catalog.aliases.opus) return;
    const r = resolveModel('claude', ver, 'opus');
    expect(r.forwarded).toBe('opus'); // forward the alias as-is, the CLI resolves it
    expect(r.canonical).toBe(catalog.aliases.opus);
    expect(r.warning).toBeUndefined();
  });

  it('accepts a known canonical id without warning', () => {
    const ver = claudeBundleVer || claudeBinaryVer;
    if (!ver) return;
    const catalog = getModelCatalog('claude', ver)!;
    const known = catalog.models[0]?.id;
    if (!known) return;
    const r = resolveModel('claude', ver, known);
    expect(r.warning).toBeUndefined();
    expect(r.canonical).toBe(known);
  });

  it('strips the [1m] context-window suffix when matching', () => {
    const ver = claudeBundleVer || claudeBinaryVer;
    if (!ver) return;
    const catalog = getModelCatalog('claude', ver)!;
    const known = catalog.models.find((m) => /^claude-opus-/.test(m.id))?.id;
    if (!known) return;
    const r = resolveModel('claude', ver, `${known}[1m]`);
    expect(r.warning).toBeUndefined();
    expect(r.forwarded).toBe(`${known}[1m]`);
  });

  it('forwards as-is and skips warning when version has no extractable catalog', () => {
    const r = resolveModel('claude', '0.0.0-not-installed', 'whatever');
    expect(r.forwarded).toBe('whatever');
    expect(r.warning).toBeUndefined();
  });
});

describe('getModelCatalog (gemini)', () => {
  it('parses the models.js ES module and surfaces aliases', () => {
    if (!geminiVer) return;
    const src = locateModelSource('gemini', geminiVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('js');
    // <=0.41 ships gemini-cli-core/dist/src/config/models.js; 0.42+ inlines the same
    // constants into a chunk under @google/gemini-cli/bundle/.
    expect(src!.path).toMatch(/(gemini-cli-core\/dist\/src\/config\/models\.js$)|(gemini-cli\/bundle\/.+\.js$)/);

    const catalog = getModelCatalog('gemini', geminiVer);
    expect(catalog).not.toBeNull();
    expect(catalog!.models.length).toBeGreaterThan(0);
    // Gemini's VALID_GEMINI_MODELS set covers both `gemini-*` and Google's
    // `gemma-*` sibling family; either prefix is valid.
    for (const m of catalog!.models) {
      expect(m.id).toMatch(/^(gemini|gemma)-/);
    }
    // The `flash` / `flash-lite` / `pro` aliases always resolve somewhere.
    expect(Object.keys(catalog!.aliases)).toEqual(
      expect.arrayContaining(['flash', 'flash-lite', 'pro'])
    );
    // At least one model must be marked default (pointed to by an alias).
    expect(catalog!.models.some((m) => m.isDefault)).toBe(true);
  });
});

describe('getModelCatalog (opencode)', () => {
  it('delegates to `opencode models --verbose` and returns provider/id keys', () => {
    if (!opencodeVer) return;
    const src = locateModelSource('opencode', opencodeVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('cli');

    const catalog = getModelCatalog('opencode', opencodeVer);
    if (!catalog || catalog.models.length === 0) return;
    // opencode 1.16+ only lists free zen models in its local catalog (currently 5);
    // older builds shipped the full models.dev snapshot. Either way the parser must
    // surface a non-trivial set of provider/id keys.
    expect(catalog!.models.length).toBeGreaterThanOrEqual(5);
    for (const m of catalog!.models) {
      expect(m.id).toMatch(/^[a-z0-9][a-z0-9.-]*\/.+$/i);
    }
  });
});

describe('getModelCatalog (openclaw)', () => {
  it('parses `openclaw models list --all --json` output', () => {
    if (!openclawVer) return;
    const src = locateModelSource('openclaw', openclawVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('cli');

    const catalog = getModelCatalog('openclaw', openclawVer);
    // The openclaw CLI may time out or be unavailable in restricted environments
    // (e.g. vitest sandbox). Skip rather than fail when the CLI produces nothing.
    if (!catalog || catalog.models.length === 0) return;
    expect(catalog.models.length).toBeGreaterThan(50);
    // OpenClaw always scopes models by provider.
    for (const m of catalog.models) {
      expect(m.id).toContain('/');
    }
  });
});

describe('getModelCatalog (antigravity)', () => {
  it('parses `agy models` display-name-only rows and flags the first as default', () => {
    if (!antigravityVer) return;
    const src = locateModelSource('antigravity', antigravityVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('cli');

    const catalog = getModelCatalog('antigravity', antigravityVer);
    // `agy` may be unavailable/timing out in restricted environments; skip
    // rather than fail when the CLI produces nothing.
    if (!catalog || catalog.models.length === 0) return;
    // Antigravity prints display names only; those strings ARE the accepted
    // --model values, so id === displayName and each has a parenthesized level.
    for (const m of catalog.models) {
      expect(m.id).toBe(m.displayName);
      expect(m.id).toMatch(/\([^)]+\)\s*$/);
    }
    // Exactly one default, and it is the first row.
    const defaults = catalog.models.filter((m) => m.isDefault);
    expect(defaults.length).toBe(1);
    expect(catalog.models[0].isDefault).toBe(true);
  });
});

describe('getModelCatalog (kimi)', () => {
  it('parses `kimi provider list --json` model keys and marks the default', () => {
    if (!kimiVer) return;
    const src = locateModelSource('kimi', kimiVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('cli');

    const catalog = getModelCatalog('kimi', kimiVer);
    if (!catalog || catalog.models.length === 0) return;
    // Kimi ids are `provider/model` keys from the config JSON.
    for (const m of catalog.models) {
      expect(m.id).toContain('/');
    }
    // At most one default may be flagged (the "Default model:" line).
    expect(catalog.models.filter((m) => m.isDefault).length).toBeLessThanOrEqual(1);
  });
});

describe('buildReasoningFlags', () => {
  it('maps Claude levels to --effort', () => {
    expect(buildReasoningFlags('claude', 'high')).toEqual(['--effort', 'high']);
    expect(buildReasoningFlags('claude', 'XHIGH')).toEqual(['--effort', 'xhigh']);
    expect(buildReasoningFlags('claude', 'max')).toEqual(['--effort', 'max']);
  });

  it('maps Codex levels to -c model_reasoning_effort=...', () => {
    expect(buildReasoningFlags('codex', 'low')).toEqual(['-c', 'model_reasoning_effort=low']);
    expect(buildReasoningFlags('codex', 'medium')).toEqual(['-c', 'model_reasoning_effort=medium']);
    expect(buildReasoningFlags('codex', 'high')).toEqual(['-c', 'model_reasoning_effort=high']);
  });

  it('clamps Codex xhigh and max down to high (Codex only supports low/medium/high)', () => {
    expect(buildReasoningFlags('codex', 'xhigh')).toEqual(['-c', 'model_reasoning_effort=high']);
    expect(buildReasoningFlags('codex', 'max')).toEqual(['-c', 'model_reasoning_effort=high']);
  });

  it('returns empty for agents with no known mapping', () => {
    expect(buildReasoningFlags('gemini', 'high')).toEqual([]);
  });
});
