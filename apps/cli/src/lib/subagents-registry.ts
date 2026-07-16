/**
 * Declarative subagent-target registry.
 *
 * Each subagents-capable agent gets ONE table entry (`SUBAGENT_TARGETS`)
 * describing how a central subagent (`~/.agents/subagents/<name>/`) is
 * materialized into that agent's home, how it is enumerated, and where it lives
 * on disk. Generic install / list / detect / orphan / remove logic iterates the
 * table instead of the near-identical `else if (agent === '...')` chains that
 * used to be copy-pasted across `subagents.ts`, the staleness writer, and the
 * staleness detector -- roughly O(agents x operations) arms.
 *
 * Adding a *standard* integration is now one line here (plus the `subagents`
 * capability flag in `agents.ts`, the version gate). Three layout builders cover
 * every current agent, so most entries are a single call:
 *
 *   - `flatFile`  one `<name><ext>` file, body from a `transform` fn.
 *                 (claude, gemini, grok, droid, codex, opencode, copilot,
 *                  cursor, forge, kiro, goose)
 *   - `dirFile`   a `<name>/` directory holding one generated `<file>`.
 *                 (antigravity: `<name>/agent.md`)
 *   - `dirCopy`   copy the whole source directory to `<name>/`, applying
 *                 renames, detected by a `marker` file. (openclaw)
 *
 * Genuinely-bespoke agents keep an explicit handler in the same table -- Kimi
 * writes two files per subagent plus a managed parent index, so it is a hand
 * -written `SubagentTarget` rather than a builder call.
 *
 * The per-agent `transform`/metadata parsers are the escape hatch: they live in
 * `subagents.ts` and are referenced by the table, so the generic engine has zero
 * per-agent branches. See the integration tiers in `docs/subagents.md`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId, InstalledSubagent, SubagentFrontmatter } from './types.js';
import { safeJoin } from './paths.js';
import {
  parseSubagentFrontmatter,
  transformSubagentForClaude,
  transformSubagentForCodex,
  transformSubagentForCopilot,
  transformSubagentForCursor,
  transformSubagentForDroid,
  transformSubagentForForge,
  transformSubagentForGoose,
  transformSubagentForKiro,
  transformSubagentForOpenCode,
  transformSubagentForAntigravity,
  writeKimiSubagentFiles,
  buildKimiSubagentsParentYaml,
  KIMI_SUBAGENTS_PARENT_FILE,
} from './subagents.js';

/** A path an installed subagent occupies, tagged for removal/trash handling. */
export interface OccupiedEntry {
  path: string;
  kind: 'file' | 'dir';
}

/** Parsed metadata for one installed subagent (drives the rich listing). */
export interface SubagentMeta {
  frontmatter: SubagentFrontmatter;
  files: string[];
  /** Primary on-disk path for the listing's `path` field (a file or a dir, per layout). */
  path: string;
}

/**
 * The complete on-disk contract for one agent's subagents. Every operation is
 * expressed here so the engine below never branches on the agent id.
 */
export interface SubagentTarget {
  /** Absolute container dir under a home root (a version home or an agent home). */
  dir(home: string): string;
  /** Materialize central subagent `sub` into container `dir`. Throws on fs error. */
  write(dir: string, sub: { name: string; path: string }): void;
  /** Installed subagent names in `dir` (detector + orphan diff). */
  names(dir: string): string[];
  /** On-disk paths subagent `name` occupies (for removal / soft-delete). */
  occupied(dir: string, name: string): OccupiedEntry[];
  /** Rich metadata for `name`; `null` skips it from the listing. */
  read(dir: string, name: string): SubagentMeta | null;
  /** Optional post-sync pass over the just-synced subagents (Kimi's parent index). */
  finalize?(dir: string, synced: Array<{ name: string; path: string }>): void;
}

// ── metadata readers (the per-format escape hatch) ───────────────────────────

/** Frontmatter, skipping files that lack a valid block (claude/gemini/grok/droid/codex). */
function metaFrontmatterSkip(filePath: string): SubagentFrontmatter | null {
  return parseSubagentFrontmatter(filePath);
}

/** Frontmatter, falling back to an empty description (opencode/copilot/cursor/forge). */
function metaFrontmatterFallback(filePath: string, name: string): SubagentFrontmatter {
  return parseSubagentFrontmatter(filePath) ?? { name, description: '' };
}

/** Kiro custom-agent JSON: read name/description/model; skip on parse error. */
function metaJson(filePath: string, name: string): SubagentFrontmatter | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      name?: string;
      description?: string;
      model?: string;
    };
    return { name: cfg.name || name, description: cfg.description || '', model: cfg.model };
  } catch {
    return null;
  }
}

/** Goose recipe YAML: title -> name, description; skip on parse error. */
function metaGooseYaml(filePath: string, name: string): SubagentFrontmatter | null {
  try {
    const recipe = yaml.parse(fs.readFileSync(filePath, 'utf-8')) as {
      title?: string;
      description?: string;
    } | null;
    return { name: recipe?.title || name, description: recipe?.description || '' };
  } catch {
    return null;
  }
}

// ── shared fs primitive ──────────────────────────────────────────────────────

/**
 * Copy every file in `src` into `dest` (created if missing), applying
 * `rename` (source filename -> target filename) on the way. Directories in
 * `src` are skipped -- subagents are flat file sets. Throws on fs error.
 */
export function copyDirWithRename(
  src: string,
  dest: string,
  rename?: Record<string, string>,
): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  for (const file of fs.readdirSync(src)) {
    const sourcePath = path.join(src, file);
    if (!fs.statSync(sourcePath).isFile()) continue;
    const targetName = rename?.[file] ?? file;
    fs.copyFileSync(sourcePath, path.join(dest, targetName));
  }
}

// ── layout builders ──────────────────────────────────────────────────────────

/** One flattened `<name><ext>` file per subagent under `subdir`. */
function flatFile(opts: {
  subdir: string[];
  ext: string;
  transform: (subagentDir: string) => string;
  /** Metadata reader; defaults to frontmatter-with-skip. */
  readMeta?: (filePath: string, name: string) => SubagentFrontmatter | null;
}): SubagentTarget {
  const readMeta = opts.readMeta ?? metaFrontmatterSkip;
  return {
    dir: (home) => path.join(home, ...opts.subdir),
    write(dir, sub) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(safeJoin(dir, `${sub.name}${opts.ext}`), opts.transform(sub.path));
    },
    names(dir) {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(opts.ext))
        .map((f) => f.slice(0, -opts.ext.length));
    },
    occupied(dir, name) {
      return [{ path: safeJoin(dir, `${name}${opts.ext}`), kind: 'file' }];
    },
    read(dir, name) {
      const filePath = path.join(dir, `${name}${opts.ext}`);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
      const frontmatter = readMeta(filePath, name);
      if (!frontmatter) return null;
      return { frontmatter, files: [`${name}${opts.ext}`], path: filePath };
    },
  };
}

/** A `<name>/` directory holding one generated `<file>` per subagent. */
function dirFile(opts: {
  subdir: string[];
  file: string;
  transform: (subagentDir: string) => string;
  readMeta?: (filePath: string, name: string) => SubagentFrontmatter | null;
}): SubagentTarget {
  const readMeta = opts.readMeta ?? ((p: string, name: string) => metaFrontmatterFallback(p, name));
  return {
    dir: (home) => path.join(home, ...opts.subdir),
    write(dir, sub) {
      const target = safeJoin(dir, sub.name);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(safeJoin(target, opts.file), opts.transform(sub.path));
    },
    names(dir) {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, opts.file)))
        .map((e) => e.name);
    },
    occupied(dir, name) {
      return [{ path: safeJoin(dir, name), kind: 'dir' }];
    },
    read(dir, name) {
      const filePath = path.join(dir, name, opts.file);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
      const frontmatter = readMeta(filePath, name);
      if (!frontmatter) return null;
      return { frontmatter, files: [opts.file], path: filePath };
    },
  };
}

/** Copy the whole source directory to `<name>/`, detected by `marker`. */
function dirCopy(opts: {
  subdir: string[];
  marker: string;
  rename?: Record<string, string>;
}): SubagentTarget {
  return {
    dir: (home) => path.join(home, ...opts.subdir),
    write(dir, sub) {
      copyDirWithRename(sub.path, safeJoin(dir, sub.name), opts.rename);
    },
    names(dir) {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, opts.marker)))
        .map((d) => d.name);
    },
    occupied(dir, name) {
      return [{ path: safeJoin(dir, name), kind: 'dir' }];
    },
    read(dir, name) {
      const markerPath = path.join(dir, name, opts.marker);
      if (!fs.existsSync(markerPath)) return null;
      // The marker may lack frontmatter; fall back to the first content line.
      let frontmatter: SubagentFrontmatter = { name, description: '' };
      const parsed = parseSubagentFrontmatter(markerPath);
      if (parsed) {
        frontmatter = parsed;
      } else {
        const content = fs.readFileSync(markerPath, 'utf-8');
        const firstLine = content.split('\n').find((l) => l.trim() && !l.startsWith('#'));
        frontmatter.description = firstLine?.slice(0, 80) || `${name}`;
      }
      const subagentDir = path.join(dir, name);
      const files = fs
        .readdirSync(subagentDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      return { frontmatter, files, path: subagentDir };
    },
  };
}

/**
 * Kimi (genuinely bespoke): each subagent is a `<name>.yaml` + sibling
 * `<name>.system.md`, and a managed `_agents-cli.yaml` parent lists them all for
 * `kimi --agent-file`. The parent index is a cross-item concern, so it is built
 * in `finalize`, not per-item.
 */
const kimiTarget: SubagentTarget = {
  dir: (home) => path.join(home, '.kimi-code', 'agents'),
  write(dir, sub) {
    writeKimiSubagentFiles(dir, sub.path, sub.name);
  },
  names(dir) {
    if (!fs.existsSync(dir)) return [];
    // The parent is `_agents-cli.yaml` (underscore-prefixed, reserved).
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))
      .map((f) => f.slice(0, -'.yaml'.length));
  },
  occupied(dir, name) {
    return [
      { path: safeJoin(dir, `${name}.yaml`), kind: 'file' },
      { path: safeJoin(dir, `${name}.system.md`), kind: 'file' },
    ];
  },
  read(dir, name) {
    const yamlPath = path.join(dir, `${name}.yaml`);
    if (!fs.existsSync(yamlPath) || !fs.statSync(yamlPath).isFile()) return null;
    let description = '';
    try {
      const parsed = yaml.parse(fs.readFileSync(yamlPath, 'utf-8')) as {
        agent?: { description?: string; name?: string };
      } | null;
      description = parsed?.agent?.description ?? '';
    } catch {
      /* leave description empty */
    }
    const files = [`${name}.yaml`];
    const promptFile = `${name}.system.md`;
    if (fs.existsSync(path.join(dir, promptFile))) files.push(promptFile);
    return { frontmatter: { name, description }, files, path: yamlPath };
  },
  finalize(dir, synced) {
    const entries = synced.map((sub) => {
      const fm = parseSubagentFrontmatter(path.join(sub.path, 'AGENT.md'));
      return { name: sub.name, description: fm?.description ?? sub.name, relativePath: `./${sub.name}.yaml` };
    });
    fs.writeFileSync(safeJoin(dir, KIMI_SUBAGENTS_PARENT_FILE), buildKimiSubagentsParentYaml(entries));
  },
};

// ── the registry ─────────────────────────────────────────────────────────────

/**
 * Single source of truth for how each subagents-capable agent stores subagents.
 * The keys MUST match `capableAgents('subagents')` (the `subagents` flag in
 * `agents.ts`): the capability flag is the version gate, this table is the shape.
 */
export const SUBAGENT_TARGETS: Partial<Record<AgentId, SubagentTarget>> = {
  // Tier 1 -- flat markdown, Claude-compatible flatten.
  claude: flatFile({ subdir: ['.claude', 'agents'], ext: '.md', transform: transformSubagentForClaude }),
  gemini: flatFile({ subdir: ['.gemini', 'agents'], ext: '.md', transform: transformSubagentForClaude }),
  grok: flatFile({ subdir: ['.grok', 'agents'], ext: '.md', transform: transformSubagentForClaude }),
  droid: flatFile({ subdir: ['.factory', 'droids'], ext: '.md', transform: transformSubagentForDroid }),
  // Bespoke frontmatter/format, still one flat file.
  codex: flatFile({ subdir: ['.codex', 'agents'], ext: '.toml', transform: transformSubagentForCodex }),
  opencode: flatFile({
    subdir: ['.config', 'opencode', 'agents'],
    ext: '.md',
    transform: transformSubagentForOpenCode,
    readMeta: metaFrontmatterFallback,
  }),
  copilot: flatFile({
    subdir: ['.copilot', 'agents'],
    ext: '.agent.md',
    transform: transformSubagentForCopilot,
    readMeta: metaFrontmatterFallback,
  }),
  cursor: flatFile({
    subdir: ['.cursor', 'agents'],
    ext: '.md',
    transform: transformSubagentForCursor,
    readMeta: metaFrontmatterFallback,
  }),
  forge: flatFile({
    subdir: ['.forge', 'agents'],
    ext: '.md',
    transform: transformSubagentForForge,
    readMeta: metaFrontmatterFallback,
  }),
  kiro: flatFile({
    subdir: ['.kiro', 'agents'],
    ext: '.json',
    transform: transformSubagentForKiro,
    readMeta: metaJson,
  }),
  goose: flatFile({
    subdir: ['.config', 'goose', 'agents'],
    ext: '.yaml',
    transform: transformSubagentForGoose,
    readMeta: metaGooseYaml,
  }),
  // Directory layouts.
  antigravity: dirFile({
    subdir: ['.gemini', 'config', 'agents'],
    file: 'agent.md',
    transform: transformSubagentForAntigravity,
  }),
  openclaw: dirCopy({ subdir: ['.openclaw'], marker: 'AGENTS.md', rename: { 'AGENT.md': 'AGENTS.md' } }),
  // Bespoke multi-file + parent index.
  kimi: kimiTarget,
};

/** The registry entry for `agent`, or undefined if it stores no subagents. */
export function subagentTarget(agent: AgentId): SubagentTarget | undefined {
  return SUBAGENT_TARGETS[agent];
}

// ── generic engine (zero per-agent branches) ─────────────────────────────────

/**
 * Materialize central subagent `sub` into `home` for `agent`. Returns whether a
 * write happened (false when the agent has no registry entry). Throws only on
 * unexpected fs errors -- bulk callers wrap per-item.
 */
export function writeSubagentToHome(
  agent: AgentId,
  home: string,
  sub: { name: string; path: string },
): boolean {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return false;
  target.write(target.dir(home), sub);
  return true;
}

/** Installed subagent names for `agent` under `home` (detector + orphan diff). */
export function listInstalledSubagentNames(agent: AgentId, home: string): string[] {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return [];
  return target.names(target.dir(home));
}

/**
 * Rich listing of subagents installed for `agent` under `home`, with parsed
 * metadata. Enumerates names, then reads each -- entries whose metadata is
 * unreadable (per the target's reader) are dropped.
 */
export function listInstalledSubagentsRich(agent: AgentId, home: string): InstalledSubagent[] {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return [];
  const dir = target.dir(home);
  const out: InstalledSubagent[] = [];
  for (const name of target.names(dir)) {
    const meta = target.read(dir, name);
    if (!meta) continue;
    out.push({ name, path: meta.path, files: meta.files, frontmatter: meta.frontmatter });
  }
  return out;
}

/**
 * Remove subagent `name` for `agent` from `home` (hard delete). No-op success
 * when the agent has no registry entry or nothing is installed.
 */
export function removeSubagentFromHome(
  agent: AgentId,
  home: string,
  name: string,
): { success: boolean; error?: string } {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return { success: true };
  try {
    for (const entry of target.occupied(target.dir(home), name)) {
      if (!fs.existsSync(entry.path)) continue;
      if (entry.kind === 'dir') fs.rmSync(entry.path, { recursive: true, force: true });
      else fs.unlinkSync(entry.path);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Soft-delete subagent `name` for `agent` from `home` into `trashDir`, stamping
 * each moved entry. Files land as `<basename>.<stamp>`, directories as
 * `<stamp>/`. No-op success when nothing is installed.
 */
export function trashSubagentFromHome(
  agent: AgentId,
  home: string,
  name: string,
  trashDir: string,
  stamp: string,
): { success: boolean; error?: string } {
  const target = SUBAGENT_TARGETS[agent];
  if (!target) return { success: true };
  try {
    const present = target.occupied(target.dir(home), name).filter((e) => fs.existsSync(e.path));
    if (present.length > 0) {
      fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
      for (const entry of present) {
        const dest =
          entry.kind === 'dir'
            ? path.join(trashDir, stamp)
            : path.join(trashDir, `${path.basename(entry.path)}.${stamp}`);
        fs.renameSync(entry.path, dest);
      }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
