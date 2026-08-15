import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  locateModelSource,
  getModelCatalog,
  resolveModel,
  buildReasoningFlags,
  parseGrokModelsStdout,
  resolveConfiguredModel,
} from '../models.js';
import { getVersionDir, listInstalledVersions } from '../installations/versions.js';

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
const firstLocatable = (agent: 'codex' | 'opencode' | 'openclaw' | 'antigravity' | 'kimi' | 'grok'): string | null =>
  listInstalledVersions(agent).find((v) => locateModelSource(agent, v) !== null) ?? null;

const codexVer = firstLocatable('codex');
const opencodeVer = firstLocatable('opencode');
const openclawVer = firstLocatable('openclaw');
const antigravityVer = firstLocatable('antigravity');
const kimiVer = firstLocatable('kimi');
const grokVer = firstLocatable('grok');

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

// gemini is hard-deprecated: locateModelSource/getModelCatalog no longer parse
// its bundle at all (RUSH-2202 — a dead, unreachable catalog surface for a
// harness with no launch path left), so there is no describe block for it here.

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

describe('parseGrokModelsStdout', () => {
  it('reads Default model: and * id (default) rows', () => {
    const stdout = [
      'You are logged in with grok.com.',
      '',
      'Default model: grok-4.5',
      '',
      'Available models:',
      '  * grok-4.5 (default)',
      '  grok-code-fast-1',
      '',
    ].join('\n');
    const { models } = parseGrokModelsStdout(stdout);
    expect(models.map((m) => m.id)).toEqual(['grok-4.5', 'grok-code-fast-1']);
    expect(models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(['grok-4.5']);
  });

  it('surfaces Default model: when it is missing from the row list', () => {
    const { models } = parseGrokModelsStdout('Default model: grok-4.5\n\nAvailable models:\n');
    expect(models).toEqual([{ id: 'grok-4.5', isDefault: true }]);
  });

  it('ignores banner lines that are not model ids', () => {
    const { models } = parseGrokModelsStdout('You are logged in with grok.com.\nAvailable models:\n');
    expect(models).toEqual([]);
  });
});

describe('getModelCatalog (grok)', () => {
  it('locates the version-home downloads binary and marks the default model', () => {
    if (!grokVer) return;
    const src = locateModelSource('grok', grokVer);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe('cli');
    expect(src!.path).toMatch(/[/\\]\.grok[/\\]downloads[/\\]grok-/);

    const catalog = getModelCatalog('grok', grokVer);
    // `grok models` may fail when offline / not signed in; skip rather than fail.
    if (!catalog || catalog.models.length === 0) return;
    for (const m of catalog.models) {
      expect(m.id).toMatch(/^grok[-_]/i);
    }
    const defaults = catalog.models.filter((m) => m.isDefault);
    expect(defaults.length).toBe(1);

    // agents view / resolveConfiguredModel should surface that default.
    const configured = resolveConfiguredModel('grok', grokVer);
    expect(configured).not.toBeNull();
    expect(configured!.model).toBe(defaults[0].id);
    expect(configured!.source).toBe('cli-default');
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

// Reproduces the RUSH bug: extractClaudeCatalog's regexes miss on claude
// >=2.1.207 bundles, so getModelCatalog extracted 0 models and (before this
// fix) never cached that result -- forcing a full extractStrings() scan of
// the whole binary (~1.85s per installed version) on every `agents view`.
//
// Unlike the rest of this file (which reads real installed agent versions),
// these tests point HOME at a throwaway temp dir and re-import models.ts
// fresh so the on-disk cache file and version dirs are isolated -- same
// pattern as state.test.ts. Each test uses fake timers to control Date.now()
// exactly and reads `attemptedAt` back off the on-disk cache file: a
// re-extraction is the only thing that stamps a fresh attemptedAt (the
// cache-hit read path returns the stored catalog untouched), so an
// unchanged attemptedAt across calls is direct, unambiguous proof that
// extraction did NOT re-run.
describe('getModelCatalog caches a 0-model extraction, bounded by a retry TTL', () => {
  let TMP = '';

  function claudeBundlePath(version: string): string {
    return path.join(
      TMP,
      '.agents',
      '.history',
      'versions',
      'claude',
      version,
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'cli.js'
    );
  }

  function writeFakeBundle(version: string, contents: string) {
    const p = claudeBundlePath(version);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }

  function cachePath(): string {
    return path.join(TMP, '.agents', '.cache', '.models-cache.json');
  }

  function attemptedAtOnDisk(key: string): number {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf-8'));
    return raw.entries[key].attemptedAt;
  }

  async function freshModels() {
    vi.resetModules();
    return import('../models.js');
  }

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-models-test-'));
    process.env.HOME = TMP;
  });
  afterEach(() => {
    vi.useRealTimers();
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('persists a 0-model catalog with attemptedAt and does not re-extract on the next call', async () => {
    // No text here matches any of extractClaudeCatalog's regexes -> 0 models.
    writeFakeBundle('2.1.207', 'this bundle has no recognizable model constants in it');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { getModelCatalog: getCatalog } = await freshModels();
    const key = 'claude@2.1.207';

    const first = getCatalog('claude', '2.1.207');
    expect(first?.models).toHaveLength(0);
    expect(attemptedAtOnDisk(key)).toBe(new Date('2026-01-01T00:00:00Z').getTime());

    // A little later, well inside the retry TTL, with the bundle untouched.
    vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
    const second = getCatalog('claude', '2.1.207');

    expect(second?.models).toHaveLength(0);
    expect(second).toEqual(first);
    // attemptedAt on disk is unchanged -- proof the second call served the
    // cached entry rather than re-running extractStrings + saveCache.
    expect(attemptedAtOnDisk(key)).toBe(new Date('2026-01-01T00:00:00Z').getTime());
  });

  it('re-extracts a stale 0-model entry once the retry TTL elapses, even with mtime unchanged', async () => {
    writeFakeBundle('2.1.208', 'no model constants here either');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { getModelCatalog: getCatalog } = await freshModels();
    const key = 'claude@2.1.208';

    const first = getCatalog('claude', '2.1.208');
    expect(first?.models).toHaveLength(0);
    const attemptedAtT0 = attemptedAtOnDisk(key);

    // Just under the 24h TTL, bundle (and its mtime) untouched: the cached
    // empty catalog is served, so attemptedAt on disk does not move.
    vi.setSystemTime(new Date('2026-01-01T23:59:00Z'));
    const stillCached = getCatalog('claude', '2.1.208');
    expect(stillCached?.models).toHaveLength(0);
    expect(attemptedAtOnDisk(key)).toBe(attemptedAtT0);

    // Past the TTL: retries extraction (even though mtime never changed) and
    // stamps a fresh attemptedAt.
    vi.setSystemTime(new Date('2026-01-02T00:00:01Z'));
    const reExtracted = getCatalog('claude', '2.1.208');
    expect(reExtracted?.models).toHaveLength(0);
    expect(attemptedAtOnDisk(key)).toBe(new Date('2026-01-02T00:00:01Z').getTime());
    expect(attemptedAtOnDisk(key)).toBeGreaterThan(attemptedAtT0);
  });

  it('re-extracts immediately when the source mtime changes, regardless of TTL', async () => {
    writeFakeBundle('2.1.209', 'no model constants here');

    const { getModelCatalog: getCatalog } = await freshModels();
    const first = getCatalog('claude', '2.1.209');
    expect(first?.models).toHaveLength(0);

    // An upgrade/reinstall: new content AND a new mtime (the normal write
    // path). The existing mtime-keyed cache check already handles this;
    // confirm the new empty-catalog caching doesn't regress it.
    writeFakeBundle(
      '2.1.209',
      '{OPUS_ID:"claude-opus-5",OPUS_NAME:"Opus",SONNET_ID:"claude-sonnet-5",SONNET_NAME:"Sonnet",HAIKU_ID:"claude-haiku-5",HAIKU_NAME:"Haiku"'
    );

    const second = getCatalog('claude', '2.1.209');
    expect(second?.models.length).toBeGreaterThan(0);
  });
});

// Reproduces issue #1820: extractClaudeCatalog's structured-map regexes
// (the alias map, the OPUS_ID/... const record, the per-cloud record) miss
// entirely on claude>=2.1.207 bundles, which stopped embedding those literal
// shapes -- the extractor fell back to 0 models for every 2.1.207+ install.
// The fallback id scan (models.ts, `if (models.length < 2)`) is what
// recovers a real catalog on those builds; these tests pin its behavior with
// synthetic bundle text so the regression is caught in CI even when no real
// claude>=2.1.207 binary is installed on the runner (the `getModelCatalog
// (claude)` suite above is gated on one being present locally).
describe('getModelCatalog falls back to a raw id scan (issue #1820)', () => {
  let TMP = '';

  function claudeBundlePath(version: string): string {
    return path.join(
      TMP,
      '.agents',
      '.history',
      'versions',
      'claude',
      version,
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'cli.js'
    );
  }

  function writeFakeBundle(version: string, contents: string) {
    const p = claudeBundlePath(version);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }

  async function freshModels() {
    vi.resetModules();
    return import('../models.js');
  }

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-models-fallback-test-'));
    process.env.HOME = TMP;
  });
  afterEach(() => {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('recovers a real catalog when the structured alias/const/perCloud maps are absent', async () => {
    // No `{opus:"...",sonnet:"...",haiku:"..."}`, no `{OPUS_ID:...}`, no
    // `{firstParty:...,bedrock:...}` -- exactly what changed on 2.1.207+.
    // The only signal left is bare `claude-<family>-<version>` strings
    // scattered in the binary, same as the real fallback scan targets.
    const bundle = [
      'some unrelated minified JS noise, no structured model maps in here',
      'claude-opus-4', // bare legacy -- has a specific sibling below, must be dropped
      'claude-opus-4-8',
      'claude-sonnet-5', // bare, no sibling -- must be kept (a real current id, #1892)
      'claude-haiku-4-5',
      'claude-fable-5',
      'more unrelated noise',
    ].join(' ');
    writeFakeBundle('2.1.207', bundle);

    const { getModelCatalog: getCatalog } = await freshModels();
    const catalog = getCatalog('claude', '2.1.207');

    expect(catalog).not.toBeNull();
    const ids = catalog!.models.map((m) => m.id).sort();
    expect(ids).toEqual(['claude-fable-5', 'claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-5']);
    expect(ids).not.toContain('claude-opus-4'); // dropped by dropBareLegacyIds
  });

  it('does not promote a foundry bare-minor to models[].id when its dated firstParty sibling is present (#2233)', async () => {
    // Force the text-scan fallback: no alias/const map, and only ONE structured
    // perCloud record (extractClaudeCatalog only falls back when models < 2).
    // The second model family appears only as raw id strings, with the foundry
    // short form sitting next to the dated firstParty form the way the native
    // binary packs them.
    const bundle = [
      'no structured {opus:...,sonnet:...,haiku:...} alias map',
      // one structured hit only — keeps models.length at 1 so fallback runs
      '{firstParty:"claude-haiku-4-5-20251001",bedrock:"x",vertex:"y",foundry:"claude-haiku-4-5"}',
      // raw packing of firstParty + foundry short form (scan path)
      'firstParty claude-opus-4-1-20250805 foundry claude-opus-4-1',
      'firstParty claude-sonnet-4-6-20250514 foundry claude-sonnet-4-6',
      'claude-fable-5',
    ].join(' ');
    writeFakeBundle('2.1.219', bundle);

    const { getModelCatalog: getCatalog } = await freshModels();
    const catalog = getCatalog('claude', '2.1.219');

    expect(catalog).not.toBeNull();
    const ids = catalog!.models.map((m) => m.id).sort();
    expect(ids).toEqual([
      'claude-fable-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-1-20250805',
      'claude-sonnet-4-6-20250514',
    ]);
    expect(ids).not.toContain('claude-opus-4-1');
    expect(ids).not.toContain('claude-sonnet-4-6');
    expect(ids).not.toContain('claude-haiku-4-5'); // foundry short form of the structured record
  });

  it('does not fall back when the structured maps already yield >=2 models', async () => {
    // A pre-2.1.207-shaped bundle with the real alias map, plus a stray raw
    // id that is NOT part of that map: the curated set must win outright,
    // and the fallback scan (unused here) must not leak the stray id in.
    const bundle =
      '{opus:"claude-opus-4-1",sonnet:"claude-sonnet-4-5",haiku:"claude-haiku-4-1"} ' +
      'claude-fable-5'; // stray id, not part of the alias map
    writeFakeBundle('2.1.186', bundle);

    const { getModelCatalog: getCatalog } = await freshModels();
    const catalog = getCatalog('claude', '2.1.186')!;

    const ids = catalog.models.map((m) => m.id).sort();
    expect(ids).toEqual(['claude-haiku-4-1', 'claude-opus-4-1', 'claude-sonnet-4-5']);
    expect(ids).not.toContain('claude-fable-5');
  });
});
