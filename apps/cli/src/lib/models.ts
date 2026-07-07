/**
 * Model catalog extraction, caching, and resolution for all supported agents.
 *
 * Each agent ships its model list differently -- Claude and Codex embed it in
 * compiled bundles/binaries, Gemini exports it from a JS module, and OpenCode/
 * Cursor/OpenClaw expose it via CLI commands. This module provides a unified
 * `getModelCatalog()` and `resolveModel()` interface over all of them, backed
 * by a file-system cache keyed on source mtime.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import type { AgentId } from './types.js';
import { getVersionDir } from './versions.js';
import { getModelsCachePath } from './state.js';

/** Model identifiers per cloud provider (used by Claude's multi-cloud routing). */
export interface ModelPerCloud {
  firstParty: string;
  bedrock?: string;
  vertex?: string;
  foundry?: string;
  anthropicAws?: string;
  mantle?: string | null;
}

/** A reasoning effort level exposed by an agent's model. */
export interface ReasoningLevel {
  effort: string;
  description?: string;
}

/** Metadata for a single model within an agent's catalog. */
export interface ModelInfo {
  id: string;
  displayName?: string;
  description?: string;
  /** alias label (e.g. "opus", "sonnet", "haiku") that resolves to this id */
  alias?: string;
  /** true if this is the agent's default model */
  isDefault?: boolean;
  /** Per-cloud routing IDs (claude only) */
  perCloud?: ModelPerCloud;
  /** Reasoning levels (codex; claude exposes via --effort with global levels) */
  reasoningLevels?: ReasoningLevel[];
  /** Default reasoning level if applicable */
  defaultReasoningLevel?: string;
}

/** The complete model catalog for a specific (agent, version) pair. */
export interface ModelCatalog {
  agent: AgentId;
  version: string;
  source: ModelSourceKind;
  sourcePath: string;
  models: ModelInfo[];
  /** Aliases that the CLI resolves to a canonical id (e.g. { opus: "claude-opus-4-7" } for claude, { flash: "gemini-3-flash-preview" } for gemini) */
  aliases: Record<string, string>;
}

const CACHE_PATH = getModelsCachePath();

/**
 * Bump when the extractor logic changes shape in an incompatible way so cached
 * catalogs from older agents-cli builds are re-extracted.
 */
const CACHE_SCHEMA_VERSION = 2;

/** A single cached model catalog entry keyed by source path and mtime. */
interface CacheEntry {
  sourcePath: string;
  mtime: number;
  catalog: ModelCatalog;
}

/** On-disk shape of the model catalog cache file. */
interface CacheFile {
  schema: number;
  entries: Record<string, CacheEntry>;
}

let memoryCache: CacheFile | null = null;

function cacheKey(agent: AgentId, version: string): string {
  return `${agent}@${version}`;
}

/** Load the cache file from disk (or return the in-memory copy). */
function loadCache(): CacheFile {
  if (memoryCache) return memoryCache;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    if (raw && raw.schema === CACHE_SCHEMA_VERSION && raw.entries) {
      memoryCache = raw as CacheFile;
    } else {
      // Legacy (pre-schema) or stale-schema cache -- drop it.
      memoryCache = { schema: CACHE_SCHEMA_VERSION, entries: {} };
    }
  } catch {
    memoryCache = { schema: CACHE_SCHEMA_VERSION, entries: {} };
  }
  return memoryCache!;
}

/** Persist the in-memory cache to disk. Best-effort; failures are silent. */
function saveCache(): void {
  if (!memoryCache) return;
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(memoryCache));
  } catch {
    /* best-effort */
  }
}

/** How the model catalog source was obtained. */
export type ModelSourceKind = 'bundle' | 'binary' | 'js' | 'cli';

/** Describes the location and extraction strategy for a model catalog source. */
export interface ModelSource {
  path: string;
  kind: ModelSourceKind;
}

/**
 * Locate the file that authoritatively describes the installed model catalog
 * for a given (agent, version). The `kind` tells `getModelCatalog` how to
 * read it:
 *   bundle/binary -- strings(1)-style extraction (claude/codex)
 *   js            -- read + regex-parse an exported JS module (gemini)
 *   cli           -- spawn the agent's own `models` command (opencode/cursor/openclaw)
 *
 * Returns null if nothing usable is found.
 */
export function locateModelSource(
  agent: AgentId,
  version: string
): ModelSource | null {
  const versionDir = getVersionDir(agent, version);

  if (agent === 'claude') {
    const bundle = path.join(versionDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(bundle)) return { path: bundle, kind: 'bundle' };
    // 2.1.113+ ships a native Mach-O binary
    const bin = path.join(versionDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(bin)) return { path: bin, kind: 'binary' };
    return null;
  }

  if (agent === 'codex') {
    // Codex's vendored binary has moved across releases:
    //   <=0.98:     @openai/codex/vendor/<triple>/codex/codex
    //   0.99..0.13: @openai/codex-<plat>-<arch>/vendor/<triple>/codex/codex
    //   0.134+:     @openai/codex-<plat>-<arch>/vendor/<triple>/bin/codex
    // We probe all known shapes; first hit wins.
    const triples = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl', 'x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'];
    const triple = currentTargetTriple();
    const orderedTriples = triple ? [triple, ...triples.filter((t) => t !== triple)] : triples;

    const platformPkgFor = (t: string) => `codex-${t.includes('apple') ? 'darwin' : t.includes('linux') ? 'linux' : 'win32'}-${t.includes('aarch64') ? 'arm64' : 'x64'}`;

    for (const t of orderedTriples) {
      const candidates = [
        path.join(versionDir, 'node_modules', '@openai', platformPkgFor(t), 'vendor', t, 'bin', 'codex'),
        path.join(versionDir, 'node_modules', '@openai', platformPkgFor(t), 'vendor', t, 'codex', 'codex'),
        path.join(versionDir, 'node_modules', '@openai', 'codex', 'vendor', t, 'bin', 'codex'),
        path.join(versionDir, 'node_modules', '@openai', 'codex', 'vendor', t, 'codex', 'codex'),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) return { path: p, kind: 'binary' };
      }
    }
    return null;
  }

  if (agent === 'gemini') {
    // <=0.41 shipped a clean ES module at @google/gemini-cli-core/dist/src/config/models.js.
    // 0.42+ inlines the same constants into a minified chunk under @google/gemini-cli/bundle/.
    const modelsJs = path.join(
      versionDir,
      'node_modules',
      '@google',
      'gemini-cli-core',
      'dist',
      'src',
      'config',
      'models.js'
    );
    if (fs.existsSync(modelsJs)) return { path: modelsJs, kind: 'js' };

    const bundleDir = path.join(versionDir, 'node_modules', '@google', 'gemini-cli', 'bundle');
    if (fs.existsSync(bundleDir)) {
      try {
        const entries = fs.readdirSync(bundleDir);
        // The model constants live in a single chunk; pick the first .js file
        // whose contents contain VALID_GEMINI_MODELS. Skip subdirectories.
        for (const name of entries) {
          if (!name.endsWith('.js')) continue;
          const full = path.join(bundleDir, name);
          let stat: fs.Stats;
          try { stat = fs.statSync(full); } catch { continue; }
          if (!stat.isFile()) continue;
          // Most chunks just re-export the constants; only the defining chunk
          // actually has `var VALID_GEMINI_MODELS = ... new Set(`. Match that
          // shape so we pick the chunk that the extractor can parse.
          let body: string;
          try {
            body = fs.readFileSync(full, 'utf-8');
          } catch { continue; }
          if (/var\s+VALID_GEMINI_MODELS\s*=[^\n]*new\s+Set/.test(body) &&
              /var\s+DEFAULT_GEMINI_MODEL\s*=/.test(body)) {
            return { path: full, kind: 'js' };
          }
        }
      } catch { /* unreadable bundle dir */ }
    }
    return null;
  }

  if (agent === 'opencode') {
    // The `opencode` shim under node_modules/.bin dispatches to a platform-
    // specific native binary. We don't parse the 100MB binary; we let the CLI
    // produce its own catalog via `opencode models --verbose`.
    const cli = path.join(versionDir, 'node_modules', '.bin', 'opencode');
    if (fs.existsSync(cli)) return { path: cli, kind: 'cli' };
    return null;
  }

  if (agent === 'openclaw') {
    const cli = path.join(versionDir, 'node_modules', '.bin', 'openclaw');
    if (fs.existsSync(cli)) return { path: cli, kind: 'cli' };
    // Fallback: installed outside agents-cli version management (e.g. global npm).
    const pathBin = findOnPath('openclaw');
    if (pathBin) return { path: pathBin, kind: 'cli' };
    return null;
  }

  if (agent === 'antigravity') {
    // The `agy` shim under node_modules/.bin exposes `agy models`. We don't parse
    // any bundle; the CLI produces its own (display-name-only) catalog.
    const cli = path.join(versionDir, 'node_modules', '.bin', 'agy');
    if (fs.existsSync(cli)) return { path: cli, kind: 'cli' };
    const pathBin = findOnPath('agy');
    if (pathBin) return { path: pathBin, kind: 'cli' };
    return null;
  }

  if (agent === 'kimi') {
    const cli = path.join(versionDir, 'node_modules', '.bin', 'kimi');
    if (fs.existsSync(cli)) return { path: cli, kind: 'cli' };
    const pathBin = findOnPath('kimi');
    if (pathBin) return { path: pathBin, kind: 'cli' };
    return null;
  }

  if (agent === 'cursor') {
    // cursor-agent is installed via curl script, not agents-cli. Version argument
    // is accepted for API symmetry but ignored -- cursor lives on PATH.
    const pathBin = findOnPath('cursor-agent');
    if (pathBin) return { path: pathBin, kind: 'cli' };
    return null;
  }

  return null;
}

/** Search PATH for a command and return its absolute path, or null. */
function findOnPath(command: string): string | null {
  const pathEnv = process.env.PATH || '';
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '').split(';') : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, command + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** Map the current Node.js platform/arch pair to a Rust-style target triple. */
function currentTargetTriple(): string | null {
  switch (`${process.platform}-${process.arch}`) {
    case 'darwin-arm64': return 'aarch64-apple-darwin';
    case 'darwin-x64': return 'x86_64-apple-darwin';
    case 'linux-x64': return 'x86_64-unknown-linux-musl';
    case 'linux-arm64': return 'aarch64-unknown-linux-musl';
    case 'win32-x64': return 'x86_64-pc-windows-msvc';
    case 'win32-arm64': return 'aarch64-pc-windows-msvc';
    default: return null;
  }
}

/**
 * Read a file and return only the printable ASCII runs of length >= minLen,
 * joined with newlines. Mirrors `strings(1)` for portability.
 */
function extractStrings(filePath: string, minLen = 6): string {
  const buf = fs.readFileSync(filePath);
  const out: string[] = [];
  let run: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    // printable ASCII (incl. tab, newline)
    if ((b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a) {
      run.push(b);
    } else {
      if (run.length >= minLen) out.push(Buffer.from(run).toString('utf8'));
      run = [];
    }
  }
  if (run.length >= minLen) out.push(Buffer.from(run).toString('utf8'));
  return out.join('\n');
}

/**
 * Extract Claude's model catalog from its bundle/binary.
 *
 * Bundle/binary contains:
 *   - alias map: {opus:"claude-opus-4-7",sonnet:"claude-sonnet-4-6",haiku:"..."}
 *   - per-cloud maps: {firstParty:"claude-opus-4-5-...",bedrock:"...",vertex:"...",...}
 *   - constants: {OPUS_ID:"...",OPUS_NAME:"...",SONNET_ID:"...",...}
 */
function extractClaudeCatalog(text: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  const aliases: Record<string, string> = {};

  const aliasMapMatch = text.match(/\{opus:"(claude-[^"]+)",sonnet:"(claude-[^"]+)",haiku:"(claude-[^"]+)"\}/);
  if (aliasMapMatch) {
    aliases.opus = aliasMapMatch[1];
    aliases.sonnet = aliasMapMatch[2];
    aliases.haiku = aliasMapMatch[3];
  }

  const constMatch = text.match(/\{OPUS_ID:"([^"]+)",OPUS_NAME:"([^"]+)",SONNET_ID:"([^"]+)",SONNET_NAME:"([^"]+)",HAIKU_ID:"([^"]+)",HAIKU_NAME:"([^"]+)"/);
  const displayNames: Record<string, string> = {};
  if (constMatch) {
    displayNames[constMatch[1]] = constMatch[2];
    displayNames[constMatch[3]] = constMatch[4];
    displayNames[constMatch[5]] = constMatch[6];
  }

  const perCloud: Record<string, ModelPerCloud> = {};
  // The record may carry additional trailing fields (e.g. gateway, eagerInputStreaming)
  // in newer Claude bundles, so the regex does not anchor at the closing brace.
  const perCloudRe = /\{firstParty:"(claude-[^"]+)",bedrock:"([^"]+)"(?:,vertex:"([^"]+)")?(?:,foundry:"([^"]+)")?(?:,anthropicAws:"([^"]+)")?(?:,mantle:(?:null|"([^"]*)"))?/g;
  let m: RegExpExecArray | null;
  while ((m = perCloudRe.exec(text)) !== null) {
    const id = m[1];
    if (perCloud[id]) continue;
    perCloud[id] = {
      firstParty: id,
      bedrock: m[2],
      vertex: m[3],
      foundry: m[4],
      anthropicAws: m[5],
      mantle: m[6] ?? null,
    };
  }

  const allIds = new Set<string>([
    ...Object.values(aliases),
    ...Object.keys(displayNames),
    ...Object.keys(perCloud),
  ]);

  const aliasReverse: Record<string, string> = {};
  for (const [a, id] of Object.entries(aliases)) aliasReverse[id] = a;

  const defaults = new Set(Object.values(aliases));

  const models: ModelInfo[] = Array.from(allIds)
    .filter((id) => /^claude-(opus|sonnet|haiku)-/.test(id))
    .sort()
    .map((id) => ({
      id,
      displayName: displayNames[id],
      alias: aliasReverse[id],
      isDefault: defaults.has(id),
      perCloud: perCloud[id],
    }));

  return { models, aliases };
}

/**
 * Extract Codex's model catalog. Catalog is embedded as JSON-ish records:
 *   "slug": "...", "display_name": "...", "description": "...",
 *   "default_reasoning_level": "...", "supported_reasoning_levels": [...]
 */
function extractCodexCatalog(text: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  // Anchor on each "slug" then walk forward for the related fields within ~1500 chars
  const slugRe = /"slug":\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = slugRe.exec(text)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);

    const window = text.slice(Math.max(0, m.index - 200), m.index + 1500);

    const displayMatch = window.match(/"display_name":\s*"([^"]+)"/);
    const descMatch = window.match(/"description":\s*"([^"]+)"/);
    const defaultLevelMatch = window.match(/"default_reasoning_level":\s*"([^"]+)"/);

    const reasoningLevels: ReasoningLevel[] = [];
    const levelsBlock = window.match(/"supported_reasoning_levels":\s*\[([\s\S]*?)\]/);
    if (levelsBlock) {
      const levelRe = /\{\s*"effort":\s*"([^"]+)"(?:,\s*"description":\s*"([^"]+)")?\s*\}/g;
      let lm: RegExpExecArray | null;
      while ((lm = levelRe.exec(levelsBlock[1])) !== null) {
        reasoningLevels.push({ effort: lm[1], description: lm[2] });
      }
    }

    models.push({
      id: slug,
      displayName: displayMatch?.[1],
      description: descMatch?.[1],
      defaultReasoningLevel: defaultLevelMatch?.[1],
      reasoningLevels: reasoningLevels.length > 0 ? reasoningLevels : undefined,
    });
  }

  return { models, aliases: {} };
}

/**
 * Extract Gemini's model catalog from `@google/gemini-cli-core/.../config/models.js`.
 *
 * The module exports a set of named constants (e.g. `DEFAULT_GEMINI_MODEL`,
 * `PREVIEW_GEMINI_FLASH_MODEL`) plus a `VALID_GEMINI_MODELS` Set and a handful
 * of `GEMINI_MODEL_ALIAS_*` strings. We parse it with regex (a JS-module import
 * would pollute the runtime and ES-module interop is awkward from a CJS build).
 */
function extractGeminiCatalog(text: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  // Old (<=0.41) layout used `export const FOO = 'bar';` in models.js.
  // New (0.42+) bundle inlines the same constants as `var FOO = "bar";`.
  const constRe = /(?:export\s+const|var)\s+([A-Z0-9_]+)\s*=\s*['"]([^'"]+)['"]/g;
  const constants = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = constRe.exec(text)) !== null) {
    constants.set(m[1], m[2]);
  }

  // The set of ids the CLI accepts as "valid model names". Names (not values)
  // are listed inside `new Set([...])`, so we expand them via the constants map.
  const validIds = new Set<string>();
  const setBlock = text.match(/VALID_GEMINI_MODELS\s*=\s*(?:\/\*[^*]*\*\/\s*)?new\s+Set\(\[([\s\S]*?)\]\)/);
  if (setBlock) {
    const nameRe = /([A-Z0-9_]+)/g;
    let nm: RegExpExecArray | null;
    while ((nm = nameRe.exec(setBlock[1])) !== null) {
      const id = constants.get(nm[1]);
      if (id) validIds.add(id);
    }
  }
  // Fall back to any gemini-shaped id we saw in the constants map -- useful
  // when the Set shape changes across gemini versions.
  if (validIds.size === 0) {
    for (const [name, value] of constants) {
      if (/^(DEFAULT_|PREVIEW_)/.test(name) && /^gemini-/.test(value)) {
        validIds.add(value);
      }
    }
  }

  // Aliases are exported as `GEMINI_MODEL_ALIAS_FLASH = 'flash'` etc. The alias
  // is the *value*; the target model is resolved at runtime by `resolveModel()`.
  // We replicate that logic here so callers get a concrete id per alias.
  const defaultId = constants.get('DEFAULT_GEMINI_MODEL');
  const previewPro = constants.get('PREVIEW_GEMINI_MODEL');
  const previewFlash = constants.get('PREVIEW_GEMINI_FLASH_MODEL');
  const flashLite = constants.get('DEFAULT_GEMINI_FLASH_LITE_MODEL');

  const aliases: Record<string, string> = {};
  if (previewPro) {
    aliases.auto = previewPro;
    aliases.pro = previewPro;
  }
  if (previewFlash) aliases.flash = previewFlash;
  if (flashLite) aliases['flash-lite'] = flashLite;

  const aliasReverse: Record<string, string[]> = {};
  for (const [alias, id] of Object.entries(aliases)) {
    (aliasReverse[id] ||= []).push(alias);
  }

  const defaults = new Set<string>();
  if (defaultId) defaults.add(defaultId);
  if (previewPro) defaults.add(previewPro); // auto/pro alias resolves here

  const displayNameFor = (id: string): string | undefined => {
    // Gemini has a `getDisplayString` for some aliases but the canonical id
    // is human-readable enough ("gemini-3-pro-preview") -- no separate map.
    return undefined;
  };

  const models: ModelInfo[] = Array.from(validIds)
    .sort()
    .map((id) => ({
      id,
      displayName: displayNameFor(id),
      alias: aliasReverse[id]?.[0],
      isDefault: defaults.has(id),
    }));

  return { models, aliases };
}

/**
 * Extract OpenCode's catalog by invoking `opencode models --verbose`. The
 * output is a sequence of `<provider>/<id>\n{json}` blocks -- we parse every
 * JSON block that follows a provider/id line.
 *
 * OpenCode caches the models.dev snapshot internally, so this is a local,
 * non-network call after first launch.
 */
function extractOpenCodeCatalog(binaryPath: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  let stdout: string;
  try {
    stdout = execFileSync(binaryPath, ['models', '--verbose'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return { models: [], aliases: {} };
  }

  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  // Blocks look like:
  //   provider/model-id
  //   {
  //     "id": "...", "providerID": "...", "name": "...", ...
  //   }
  // Walk forward finding `{` at column 0 that terminates with a `}` at column 0.
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^[a-z0-9][a-z0-9.-]*\/[^\s]+$/i.test(line)) continue;
    const fullKey = line;
    // Find the opening `{` right after this line, collect until matching `}`.
    let start = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] === '{') { start = j; break; }
      if (lines[j].trim() !== '') break;
    }
    if (start === -1) continue;
    let depth = 0;
    let end = -1;
    for (let j = start; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth === 0) { end = j; break; }
    }
    if (end === -1) continue;
    const json = lines.slice(start, end + 1).join('\n');
    try {
      const obj = JSON.parse(json);
      if (seen.has(fullKey)) continue;
      seen.add(fullKey);
      // obj.status can be "active" | "deprecated" | "preview" -- surface only
      // when it isn't the default so the consumer can flag stale models.
      const nonDefaultStatus = obj.status && obj.status !== 'active' ? obj.status : undefined;
      models.push({
        id: fullKey,
        displayName: obj.name,
        description: nonDefaultStatus,
      });
    } catch {
      /* skip malformed block */
    }
    i = end;
  }

  // Second pass: if --verbose produced nothing, fall back to the plain list.
  if (models.length === 0) {
    try {
      const plain = execFileSync(binaryPath, ['models'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      for (const raw of plain.split('\n')) {
        const id = raw.trim();
        if (!id || !/^[a-z0-9][a-z0-9.-]*\/[^\s]+$/i.test(id)) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        models.push({ id });
      }
    } catch {
      /* leave empty */
    }
  }

  return { models, aliases: {} };
}

/**
 * Extract Cursor's catalog via `cursor-agent --list-models`. Output lines look like:
 *   `auto - Auto`
 *   `composer-2-fast - Composer 2 Fast  (current, default)`
 *   `gpt-5.3-codex - Codex 5.3`
 */
function extractCursorCatalog(binaryPath: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  let stdout: string;
  try {
    stdout = execFileSync(binaryPath, ['--list-models'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return { models: [], aliases: {} };
  }

  // Strip ANSI escape sequences; cursor renders a loading spinner.
  // eslint-disable-next-line no-control-regex
  const plain = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const raw of plain.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Expect `id - display[  (flag1, flag2, ...)]`
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9.\-_]*)\s+-\s+(.+)$/);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const rest = m[2];
    const flagMatch = rest.match(/\s+\(([^)]+)\)\s*$/);
    const flags = flagMatch ? flagMatch[1].split(',').map((s) => s.trim().toLowerCase()) : [];
    const displayName = (flagMatch ? rest.slice(0, flagMatch.index) : rest).trim();
    models.push({
      id,
      displayName,
      isDefault: flags.includes('default'),
    });
  }

  return { models, aliases: {} };
}

/**
 * Extract OpenClaw's catalog via `openclaw models list --all --json`. OpenClaw
 * bundles its own models.dev-like snapshot and exposes a stable JSON shape.
 */
function extractOpenClawCatalog(binaryPath: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  let stdout: string;
  try {
    stdout = execFileSync(binaryPath, ['models', 'list', '--all', '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return { models: [], aliases: {} };
  }

  // OpenClaw prefaces output with a banner line on stderr; stdout should be
  // pure JSON, but be defensive and skip preface text if any slipped through.
  const firstBrace = stdout.indexOf('{');
  if (firstBrace === -1) return { models: [], aliases: {} };
  let parsed: any;
  try {
    parsed = JSON.parse(stdout.slice(firstBrace));
  } catch {
    return { models: [], aliases: {} };
  }

  const rawModels = Array.isArray(parsed?.models) ? parsed.models : [];
  const models: ModelInfo[] = rawModels
    .filter((m: any) => typeof m?.key === 'string')
    .map((m: any) => ({
      id: m.key,
      displayName: typeof m.name === 'string' ? m.name : undefined,
      isDefault: m.available === true && m.tags?.includes?.('default'),
    }));

  return { models, aliases: {} };
}

/**
 * Extract Antigravity's catalog via `agy models`. Antigravity is unusual: it
 * prints DISPLAY NAMES ONLY, one per line, with no machine ids and no --json:
 *   Gemini 3.5 Flash (Medium)
 *   Claude Sonnet 4.6 (Thinking)
 * Verified (agy 1.0.11) that those display strings ARE the accepted `--model`
 * values -- `agy --model "Claude Opus 4.6 (Thinking)"` routes to that model,
 * and an unknown value silently falls back to the first row. So we use each
 * display string as both id and displayName, and mark the first row default.
 */
function extractAntigravityCatalog(binaryPath: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  let stdout: string;
  try {
    stdout = execFileSync(binaryPath, ['models'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return { models: [], aliases: {} };
  }

  // Strip ANSI in case a spinner or color codes slip through.
  // eslint-disable-next-line no-control-regex
  const plain = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const raw of plain.split('\n')) {
    const name = raw.trim();
    if (!name) continue;
    // Guard against any stray banner/usage lines: real rows look like
    // "<Vendor> <Model> (<Level>)". Require an alphanumeric start and a
    // parenthesized suffix, which every observed model row has.
    if (!/^[A-Za-z0-9].*\([^)]+\)\s*$/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    models.push({
      id: name,
      displayName: name,
      // Antigravity's first listed model is its default (unknown --model values
      // fall back to it), so flag the first row we accept.
      isDefault: models.length === 0,
    });
  }

  return { models, aliases: {} };
}

/**
 * Extract Kimi's catalog via `kimi provider list --json`, which emits the raw
 * providers/models config. Model ids are the `models` object keys (e.g.
 * `kimi-code/kimi-for-coding`). The default is reported on a separate plain
 * `Default model: <id>` line by `kimi provider list` (no flags), so we run that
 * too to flag the default row.
 */
function extractKimiCatalog(binaryPath: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  let jsonOut: string;
  try {
    jsonOut = execFileSync(binaryPath, ['provider', 'list', '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return { models: [], aliases: {} };
  }

  const firstBrace = jsonOut.indexOf('{');
  if (firstBrace === -1) return { models: [], aliases: {} };
  let parsed: any;
  try {
    parsed = JSON.parse(jsonOut.slice(firstBrace));
  } catch {
    return { models: [], aliases: {} };
  }

  // Resolve the default model id from the plain listing's "Default model:" line.
  let defaultId: string | null = null;
  try {
    const plain = execFileSync(binaryPath, ['provider', 'list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const m = plain.match(/Default model:\s*(\S+)/);
    if (m) defaultId = m[1];
  } catch {
    /* default flag is best-effort */
  }

  const modelsObj = parsed?.models && typeof parsed.models === 'object' ? parsed.models : {};
  const models: ModelInfo[] = [];
  for (const id of Object.keys(modelsObj)) {
    const info = modelsObj[id] ?? {};
    models.push({
      id,
      displayName: typeof info.displayName === 'string' ? info.displayName : undefined,
      isDefault: defaultId != null && id === defaultId,
    });
  }

  return { models, aliases: {} };
}

/**
 * Build (or load from cache) the model catalog for a specific (agent, version).
 * Cache is keyed on source-file mtime (binary or js module), so re-extracts
 * automatically when the user upgrades or reinstalls a version.
 */
export function getModelCatalog(agent: AgentId, version: string): ModelCatalog | null {
  const src = locateModelSource(agent, version);
  if (!src) return null;

  let mtime = 0;
  try {
    mtime = fs.statSync(src.path).mtimeMs;
  } catch {
    return null;
  }

  const cache = loadCache();
  const key = cacheKey(agent, version);
  const cached = cache.entries[key];
  if (cached && cached.sourcePath === src.path && cached.mtime === mtime) {
    return cached.catalog;
  }

  let models: ModelInfo[] = [];
  let aliases: Record<string, string> = {};

  if (src.kind === 'bundle' || src.kind === 'binary') {
    const text = extractStrings(src.path);
    ({ models, aliases } =
      agent === 'claude' ? extractClaudeCatalog(text)
      : agent === 'codex' ? extractCodexCatalog(text)
      : { models: [], aliases: {} });
  } else if (src.kind === 'js') {
    try {
      const text = fs.readFileSync(src.path, 'utf-8');
      if (agent === 'gemini') ({ models, aliases } = extractGeminiCatalog(text));
    } catch {
      /* unreadable */
    }
  } else if (src.kind === 'cli') {
    if (agent === 'opencode') ({ models, aliases } = extractOpenCodeCatalog(src.path));
    else if (agent === 'cursor') ({ models, aliases } = extractCursorCatalog(src.path));
    else if (agent === 'openclaw') ({ models, aliases } = extractOpenClawCatalog(src.path));
    else if (agent === 'antigravity') ({ models, aliases } = extractAntigravityCatalog(src.path));
    else if (agent === 'kimi') ({ models, aliases } = extractKimiCatalog(src.path));
  }

  const catalog: ModelCatalog = {
    agent,
    version,
    source: src.kind,
    sourcePath: src.path,
    models,
    aliases,
  };

  // Never cache an empty extraction, regardless of source kind. A 0-model
  // result is always suspect: the CLI may have been mid-install, network-
  // dependent, or transiently failing, and a js/bundle/binary extractor that
  // regex-misses would otherwise pin an empty catalog forever (mtime won't
  // change until the source file does). Only persist a non-empty catalog.
  if (models.length > 0) {
    cache.entries[key] = { sourcePath: src.path, mtime, catalog };
    saveCache();
  }
  return catalog;
}

/** The result of resolving a user-supplied model string against the catalog. */
export interface ResolvedModel {
  /** The model string to forward to the CLI (canonical id when we can resolve, else passed through unchanged). */
  forwarded: string;
  /** The canonical id, when we could resolve the input through the alias map. */
  canonical?: string;
  /** Warning to surface to the user (e.g. "model X not in known catalog for v Y"). */
  warning?: string;
}

/**
 * Resolve a user-supplied model string for a specific (agent, version).
 *
 * Pass-through semantics: we never block. If the input doesn't match anything
 * we know about, we forward it as-is and return a warning the caller can log.
 *
 * - If `requested` matches an alias in the catalog (e.g. "opus"), we still
 *   forward the alias (the CLI accepts both), but we report the canonical id
 *   so logs/metadata can record the concrete model.
 * - If `requested` matches a known canonical id, no warning.
 * - If `requested` is unknown to our extractor, we forward it and warn.
 */
export function resolveModel(agent: AgentId, version: string, requested: string): ResolvedModel {
  const catalog = getModelCatalog(agent, version);
  if (!catalog) {
    return { forwarded: requested };
  }

  const aliasTarget = catalog.aliases[requested];
  if (aliasTarget) {
    return { forwarded: requested, canonical: aliasTarget };
  }

  const knownIds = new Set(catalog.models.map((m) => m.id));
  if (knownIds.has(requested)) {
    return { forwarded: requested, canonical: requested };
  }

  // Strip [1m] context-window suffix before checking (Claude appends at runtime)
  const stripped = requested.replace(/\[[^\]]+\]$/, '');
  if (knownIds.has(stripped)) {
    return { forwarded: requested, canonical: requested };
  }

  const suggestions = pickSuggestions(requested, catalog);
  const hint = suggestions.length > 0 ? ` (closest: ${suggestions.join(', ')})` : '';
  return {
    forwarded: requested,
    warning: `model "${requested}" not in known catalog for ${agent}@${version}; forwarding as-is${hint}`,
  };
}

/**
 * Resolve the model id an `agents run` will ACTUALLY use, for cost estimation
 * (issue #346). The run path resolves the model in this precedence:
 *   1. explicit `--model` (or profile/workflow/runDefaults value) — `requested`
 *   2. otherwise the agent CLI's own built-in default, which we read from the
 *      extracted catalog's `isDefault` model.
 * Returns null only when we have neither — the caller must then treat the
 * estimate as unpriced rather than silently using an unpriced placeholder id
 * like `${agent}-default`.
 */
export function resolveEffectiveModel(
  agent: AgentId,
  version: string,
  requested?: string,
): string | null {
  if (requested && requested.trim() !== '') {
    const resolved = resolveModel(agent, version, requested);
    return resolved.canonical ?? resolved.forwarded;
  }
  const catalog = getModelCatalog(agent, version);
  if (!catalog) return null;
  const def = catalog.models.find((m) => m.isDefault);
  return def?.id ?? null;
}

/** Find the closest matching model ids/aliases using edit distance. */
function pickSuggestions(requested: string, catalog: ModelCatalog): string[] {
  const all = [...catalog.models.map((m) => m.id), ...Object.keys(catalog.aliases)];
  return all
    .map((id) => ({ id, score: similarity(requested, id) }))
    .filter((s) => s.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.id);
}

/** Normalized Levenshtein similarity (0..1, where 1 is identical). */
function similarity(a: string, b: string): number {
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (longer.length === 0) return 1;
  const distance = levenshtein(longer, shorter);
  return (longer.length - distance) / longer.length;
}

/** Standard Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Build the per-agent CLI flags for a unified reasoning effort knob.
 *
 * Both Claude (`--effort`) and Codex (`-c model_reasoning_effort=...`) expose a
 * reasoning intensity dial. Inputs accepted: low | medium | high | xhigh | max | auto.
 * - Codex only supports low/medium/high; xhigh and max are clamped to high.
 * - 'auto' skips reasoning flags for codex (lets it use model default).
 * - 'auto' passes --effort auto to claude if supported.
 */
export function buildReasoningFlags(agent: AgentId, level: string): string[] {
  const normalized = level.toLowerCase();
  if (normalized === 'auto') {
    // For claude, forward --effort auto if the agent supports it
    // For codex and others, omit (let agent use its default)
    return agent === 'claude' ? ['--effort', 'auto'] : [];
  }
  if (agent === 'claude') {
    return ['--effort', normalized];
  }
  if (agent === 'codex') {
    const codexLevel = (normalized === 'xhigh' || normalized === 'max') ? 'high' : normalized;
    return ['-c', `model_reasoning_effort=${codexLevel}`];
  }
  if (agent === 'droid') {
    // Droid: `-r off|none|low|medium|high`. xhigh/max clamp to high.
    const droidLevel = (normalized === 'xhigh' || normalized === 'max') ? 'high' : normalized;
    return ['-r', droidLevel];
  }
  return [];
}
