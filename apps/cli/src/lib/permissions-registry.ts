/**
 * Declarative permission-target registry.
 *
 * Every allowlist-capable agent gets ONE entry (`PERMISSION_TARGETS`) describing
 * where its permissions live and how to read that file back into the canonical
 * `PermissionSet`. `agents permissions list <agent>` and the config-file import
 * behind `agents permissions add <path>` used to dispatch through hand-written
 * 3-arm switches while
 * `applyPermissionsToVersion` wrote 13 harnesses, so permissions were written
 * for cursor, antigravity, grok, kimi, droid, copilot, kiro, openclaw and
 * hermes and then reported as absent for all ten (RUSH-2676).
 *
 * The key set is pinned to `capableAgents('allowlist')` by
 * `permissions-registry.test.ts`, mirroring `SUBAGENT_TARGETS` — the pattern the
 * repo's own AGENTS.md names for cross-harness capabilities. A newly added
 * allowlist harness cannot be written-but-unreadable: it must land an entry here
 * in the same change.
 *
 * This module also OWNS the canonical<->native tool vocabularies. `permissions.ts`
 * imports them for the forward (canonical -> native) serializers, and the reverse
 * projections below are derived from the same tables, so the two directions
 * cannot drift into disagreeing about what `developer__shell` or `fs_read` means.
 *
 * ## Every reverse projection is lossy, and says how
 *
 * The forward direction discards information — several canonical tools collapse
 * onto one native id (`Read`/`Grep`/`Glob` all become Kiro's `fs_read`), and
 * pattern grammars differ (`git:*` becomes `git *`). Reading back therefore
 * recovers a permission set that GRANTS THE SAME ACCESS, not the byte-identical
 * strings that were written. Each target documents its own collapse. Callers that
 * need a faithful record of what agents-cli installed should read the central
 * `~/.agents/permissions/` set, not a harness's config.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import * as TOML from 'smol-toml';
import type { AgentId, PermissionSet } from './types.js';

// ── canonical <-> native tool vocabularies (single source of truth) ──────────

/** Canonical tool (lowercased) -> Grok's lowercase tool vocabulary. */
export const GROK_TOOL_BY_CANONICAL: Record<string, string | undefined> = {
  bash: 'bash',
  read: 'read',
  write: 'edit',
  grep: 'grep',
  webfetch: 'webfetch',
};

/** Canonical tool -> Kiro CLI v3 capability id. */
export const KIRO_CAPABILITY_BY_TOOL: Record<string, string | undefined> = {
  bash: 'shell',
  read: 'fs_read',
  grep: 'fs_read',
  glob: 'fs_read',
  write: 'fs_write',
  edit: 'fs_write',
  notebookedit: 'fs_write',
  webfetch: 'web_fetch',
  websearch: 'web_search',
  mcp: 'mcp',
  subagent: 'subagent',
  skill: 'skill',
};

/** Canonical tool -> OpenClaw tool id (tool-level granularity only). */
export const CANONICAL_TO_OPENCLAW_TOOL: Record<string, string> = {
  bash: 'exec',
  read: 'read',
  write: 'write',
  edit: 'write',
  webfetch: 'web_fetch',
  websearch: 'web_search',
};

/** Canonical tool -> Antigravity's action namespace. */
export const ANTIGRAVITY_ACTION_BY_TOOL: Record<string, string | undefined> = {
  bash: 'command',
  read: 'read_file',
  write: 'write_file',
  webfetch: 'read_url',
};

/**
 * Invert a forward map, keeping the FIRST canonical tool that maps to each
 * native id. Several canonical tools collapse onto one native id, so the
 * inverse must pick a representative; declaration order in the forward table is
 * that choice, which is why `read` (declared before `grep`/`glob`) represents
 * Kiro's `fs_read`.
 */
function invertFirstWins(forward: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [canonical, native] of Object.entries(forward)) {
    if (!native) continue;
    if (!(native in out)) out[native] = canonical;
  }
  return out;
}

const CANONICAL_BY_GROK_TOOL = invertFirstWins(GROK_TOOL_BY_CANONICAL);
const CANONICAL_BY_KIRO_CAPABILITY = invertFirstWins(KIRO_CAPABILITY_BY_TOOL);
const CANONICAL_BY_OPENCLAW_TOOL = invertFirstWins(CANONICAL_TO_OPENCLAW_TOOL);
const CANONICAL_BY_ANTIGRAVITY_ACTION = invertFirstWins(ANTIGRAVITY_ACTION_BY_TOOL);

/** Canonical TitleCase spelling for a lowercased canonical tool name. */
const CANONICAL_TOOL_CASE: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  notebookedit: 'NotebookEdit',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  mcp: 'Mcp',
  subagent: 'Subagent',
  skill: 'Skill',
};

function titleCaseTool(lower: string): string {
  return CANONICAL_TOOL_CASE[lower] ?? lower;
}

/**
 * Inverse of the serializers' `normalizeBashPattern`: native grammars spell a
 * command's arg-glob `git *`, canonical spells it `git:*`. `*` stays `*`.
 */
function denormalizeBashPattern(pattern: string): string {
  if (pattern === '*' || pattern === '**') return '*';
  if (pattern.endsWith(' *')) return `${pattern.slice(0, -2)}:*`;
  return pattern;
}

/** Build a canonical rule string, collapsing a blanket pattern to the tool's wildcard. */
function canonicalRule(lowerTool: string, pattern: string | null): string {
  const tool = titleCaseTool(lowerTool);
  if (pattern === null) return lowerTool === 'bash' ? 'Bash(*)' : `${tool}(**)`;
  return `${tool}(${pattern})`;
}

/** Assemble a PermissionSet, dropping empty arrays so callers can test truthiness. */
function permissionSet(allow: string[], deny: string[]): PermissionSet | null {
  const uniqueAllow = [...new Set(allow)];
  const uniqueDeny = [...new Set(deny)];
  if (uniqueAllow.length === 0 && uniqueDeny.length === 0) return null;
  return {
    name: 'exported',
    allow: uniqueAllow,
    ...(uniqueDeny.length ? { deny: uniqueDeny } : {}),
  };
}

// ── file readers ─────────────────────────────────────────────────────────────

/**
 * Strip JSON comments for JSONC parsing, only OUTSIDE string literals.
 *
 * A naive `//`-to-end-of-line regex destroys
 * `"$schema": "https://opencode.ai/config.json"` — which every
 * opencode-generated config carries — so the file then fails to parse and its
 * permissions read back as absent, the very defect this registry exists to fix.
 * Exported so `permissions.ts` shares this one implementation instead of
 * keeping its own copy.
 */
export function stripJsonComments(content: string): string {
  let result = '';
  let inString = false;
  let escape = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const next = content[i + 1];

    if (escape) {
      result += char;
      escape = false;
      i++;
      continue;
    }

    if (char === '\\' && inString) {
      result += char;
      escape = true;
      i++;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
      i++;
      continue;
    }

    if (!inString) {
      if (char === '/' && next === '/') {
        while (i < content.length && content[i] !== '\n') {
          i++;
        }
        continue;
      }
      if (char === '/' && next === '*') {
        i += 2;
        while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) {
          i++;
        }
        i += 2;
        continue;
      }
    }

    result += char;
    i++;
  }

  return result;
}

function readJson(configPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(configPath.endsWith('.jsonc') ? stripJsonComments(raw) : raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readYaml(configPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    const parsed = yaml.parse(fs.readFileSync(configPath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readToml(configPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    return TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `preferred` unless it is absent and `alternate` exists. */
function existingOr(preferred: string, alternate: string): string {
  return !fs.existsSync(preferred) && fs.existsSync(alternate) ? alternate : preferred;
}

/** Every string in `value` when it is a string array, else []. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// ── the registry ─────────────────────────────────────────────────────────────

/** The complete permissions contract for one agent. */
export interface PermissionTarget {
  /** Permissions file under a HOME root (a version home, or the real HOME). */
  home(home: string): string;
  /** Permissions file for a project checkout, when the harness reads one. */
  project?: (cwd: string) => string;
  /**
   * Read `configPath` and project it to canonical form. Returns null when the
   * file is absent, unreadable, or records no permissions — never throws.
   */
  toCanonical(configPath: string): PermissionSet | null;
  /** One line naming what this harness's shape loses on the way back. */
  lossyBecause: string;
}

/**
 * Single source of truth for where each allowlist-capable agent stores
 * permissions and how to read them back. Keys MUST equal
 * `capableAgents('allowlist')` — pinned by `permissions-registry.test.ts`.
 */
export const PERMISSION_TARGETS: Partial<Record<AgentId, PermissionTarget>> = {
  claude: {
    home: (h) => path.join(h, '.claude', 'settings.json'),
    project: (cwd) => path.join(cwd, '.claude', 'settings.json'),
    lossyBecause: 'canonical Write(...) is written as Edit(...), so it reads back as Edit',
    toCanonical(configPath) {
      const config = readJson(configPath);
      const perms = config?.permissions;
      if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return null;
      const p = perms as Record<string, unknown>;
      const set = permissionSet(stringList(p.allow), stringList(p.deny));
      const dirs = stringList(p.additionalDirectories);
      if (set && dirs.length) set.additionalDirectories = dirs;
      return set;
    },
  },

  opencode: {
    // OpenCode accepts either extension and `openCodeConfigPath` probes both, so
    // an existing `opencode.json` must be found rather than shadowed by the
    // `.jsonc` default.
    home: (h) => existingOr(
      path.join(h, '.config', 'opencode', 'opencode.jsonc'),
      path.join(h, '.config', 'opencode', 'opencode.json'),
    ),
    project: (cwd) => existingOr(path.join(cwd, 'opencode.jsonc'), path.join(cwd, 'opencode.json')),
    lossyBecause: 'OpenCode gates Bash only, so non-Bash rules were never written',
    toCanonical(configPath) {
      const config = readJson(configPath);
      const permission = config?.permission;
      if (!permission || typeof permission !== 'object' || Array.isArray(permission)) return null;
      const bash = (permission as Record<string, unknown>).bash;
      if (!bash || typeof bash !== 'object' || Array.isArray(bash)) return null;
      const allow: string[] = [];
      const deny: string[] = [];
      for (const [pattern, action] of Object.entries(bash as Record<string, unknown>)) {
        if (action === 'allow') allow.push(`Bash(${pattern})`);
        else if (action === 'deny') deny.push(`Bash(${pattern})`);
      }
      return permissionSet(allow, deny);
    },
  },

  codex: {
    home: (h) => path.join(h, '.codex', 'config.toml'),
    project: (cwd) => path.join(cwd, '.codex', 'config.toml'),
    lossyBecause: 'Codex has no rule list — its sandbox mode is widened into representative blanket grants',
    toCanonical(configPath) {
      const config = readToml(configPath);
      if (!config) return null;
      const allow: string[] = [];
      const sandboxMode = config.sandbox_mode;
      if (config.approval_policy === 'never' || sandboxMode === 'danger-full-access') {
        allow.push('Bash(*)', 'Read(**)', 'Write(**)', 'Edit(**)');
      } else if (sandboxMode === 'workspace-write') {
        allow.push('Bash(*)', 'Read(**)');
      }
      const sw = config.sandbox_workspace_write;
      if (sw && typeof sw === 'object' && !Array.isArray(sw) && (sw as Record<string, unknown>).network_access) {
        allow.push('WebSearch(*)', 'WebFetch(*)');
      }
      return permissionSet(allow, []);
    },
  },

  cursor: {
    home: (h) => path.join(h, '.cursor', 'cli-config.json'),
    lossyBecause: 'canonical Bash reads back from Shell(...) and Edit was written as Write(...)',
    toCanonical(configPath) {
      const config = readJson(configPath);
      const perms = config?.permissions;
      if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return null;
      const p = perms as Record<string, unknown>;
      // Cursor spells Bash as Shell(...) and canonical WebSearch as WebFetch(...).
      const back = (rule: string): string =>
        rule.startsWith('Shell') ? rule.replace(/^Shell/, 'Bash') : rule;
      return permissionSet(stringList(p.allow).map(back), stringList(p.deny).map(back));
    },
  },

  antigravity: {
    home: (h) => path.join(h, '.gemini', 'antigravity-cli', 'settings.json'),
    lossyBecause: 'only command/read_file/write_file/read_url map, so other canonical tools were never written',
    toCanonical(configPath) {
      const config = readJson(configPath);
      const perms = config?.permissions;
      if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return null;
      const p = perms as Record<string, unknown>;
      const back = (entries: string[]): string[] => {
        const out: string[] = [];
        for (const entry of entries) {
          const m = entry.match(/^(\w+)\((.*)\)$/);
          if (!m) continue;
          const lowerTool = CANONICAL_BY_ANTIGRAVITY_ACTION[m[1]];
          if (!lowerTool) continue;
          const pattern = lowerTool === 'bash' ? denormalizeBashPattern(m[2]) : m[2];
          out.push(canonicalRule(lowerTool, pattern));
        }
        return out;
      };
      return permissionSet(back(stringList(p.allow)), back(stringList(p.deny)));
    },
  },

  grok: {
    home: (h) => path.join(h, '.grok', 'config.toml'),
    lossyBecause: 'canonical Write is written as Grok `edit`, so it reads back as Edit',
    toCanonical(configPath) {
      const config = readToml(configPath);
      const permission = config?.permission;
      if (!permission || typeof permission !== 'object' || Array.isArray(permission)) return null;
      const rules = (permission as Record<string, unknown>).rules;
      if (!Array.isArray(rules)) return null;
      const allow: string[] = [];
      const deny: string[] = [];
      for (const rule of rules) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
        const r = rule as { action?: unknown; tool?: unknown; pattern?: unknown };
        if (typeof r.tool !== 'string') continue;
        const lowerTool = CANONICAL_BY_GROK_TOOL[r.tool];
        if (!lowerTool) continue;
        const raw = typeof r.pattern === 'string' ? r.pattern : null;
        const pattern = raw === null ? null : lowerTool === 'bash' ? denormalizeBashPattern(raw) : raw;
        const canonical = canonicalRule(lowerTool, pattern);
        if (r.action === 'deny') deny.push(canonical);
        else if (r.action === 'allow') allow.push(canonical);
      }
      return permissionSet(allow, deny);
    },
  },

  kimi: {
    home: (h) => path.join(h, '.kimi-code', 'config.toml'),
    lossyBecause: 'each Bash arg-glob was written as two picomatch patterns, which collapse back to one rule',
    toCanonical(configPath) {
      const config = readToml(configPath);
      const permission = config?.permission;
      if (!permission || typeof permission !== 'object' || Array.isArray(permission)) return null;
      const rules = (permission as Record<string, unknown>).rules;
      if (!Array.isArray(rules)) return null;
      const allow: string[] = [];
      const deny: string[] = [];
      for (const rule of rules) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
        const r = rule as { decision?: unknown; pattern?: unknown };
        if (typeof r.pattern !== 'string') continue;
        const canonical = kimiPatternToCanonical(r.pattern);
        if (!canonical) continue;
        if (r.decision === 'deny') deny.push(canonical);
        else if (r.decision === 'allow') allow.push(canonical);
      }
      return permissionSet(allow, deny);
    },
  },

  droid: {
    home: (h) => path.join(h, '.factory', 'settings.json'),
    lossyBecause: 'Droid gates shell commands only, so non-Bash rules were never written',
    toCanonical(configPath) {
      const config = readJson(configPath);
      if (!config) return null;
      const back = (commands: string[]): string[] =>
        commands.map((c) => (c === '*' ? 'Bash(*)' : `Bash(${denormalizeBashPattern(c)})`));
      return permissionSet(
        back(stringList(config.commandAllowlist)),
        back(stringList(config.commandDenylist)),
      );
    },
  },

  copilot: {
    home: (h) => path.join(h, '.copilot', 'permissions-config.json'),
    lossyBecause: 'approvals are per working directory and read/write are whole-tool kinds with no path',
    toCanonical(configPath) {
      const config = readJson(configPath);
      const locations = config?.locations;
      if (!locations || typeof locations !== 'object' || Array.isArray(locations)) return null;
      const allow: string[] = [];
      // Copilot records approvals per location; the canonical set has no location
      // axis, so every location's approvals union into one allow list.
      for (const location of Object.values(locations as Record<string, unknown>)) {
        if (!location || typeof location !== 'object' || Array.isArray(location)) continue;
        const approvals = (location as Record<string, unknown>).tool_approvals;
        if (!Array.isArray(approvals)) continue;
        for (const approval of approvals) {
          if (!approval || typeof approval !== 'object' || Array.isArray(approval)) continue;
          const a = approval as { kind?: unknown; commandIdentifiers?: unknown; serverName?: unknown; toolName?: unknown };
          if (a.kind === 'commands') {
            for (const id of stringList(a.commandIdentifiers)) allow.push(`Bash(${id})`);
          } else if (a.kind === 'read') {
            allow.push('Read(**)');
          } else if (a.kind === 'write') {
            allow.push('Write(**)');
          } else if (a.kind === 'mcp' && typeof a.serverName === 'string') {
            allow.push(`Mcp(${typeof a.toolName === 'string' ? `${a.serverName}.${a.toolName}` : a.serverName})`);
          }
        }
      }
      // Copilot's config records approvals (grants) only — it has no deny list.
      return permissionSet(allow, []);
    },
  },

  kiro: {
    home: (h) => path.join(h, '.kiro', 'settings', 'permissions.yaml'),
    lossyBecause: 'Read/Grep/Glob share fs_read and Write/Edit/NotebookEdit share fs_write',
    toCanonical(configPath) {
      const config = readYaml(configPath);
      const rules = config?.rules;
      if (!Array.isArray(rules)) return null;
      const allow: string[] = [];
      const deny: string[] = [];
      for (const rule of rules) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
        const r = rule as { capability?: unknown; effect?: unknown; match?: unknown };
        if (typeof r.capability !== 'string') continue;
        const lowerTool = CANONICAL_BY_KIRO_CAPABILITY[r.capability];
        if (!lowerTool) continue;
        const matches = stringList(r.match);
        const canonicals = matches.length
          ? matches.map((m) => canonicalRule(lowerTool, lowerTool === 'bash' ? denormalizeBashPattern(m) : m))
          : [canonicalRule(lowerTool, null)];
        if (r.effect === 'deny') deny.push(...canonicals);
        else if (r.effect === 'allow') allow.push(...canonicals);
      }
      return permissionSet(allow, deny);
    },
  },

  openclaw: {
    home: (h) => path.join(h, '.openclaw', 'openclaw.json'),
    lossyBecause: 'OpenClaw gates whole tools, so only blanket rules were written and all read back as blanket',
    toCanonical(configPath) {
      const config = readJson(configPath);
      const tools = config?.tools;
      if (!tools || typeof tools !== 'object' || Array.isArray(tools)) return null;
      const t = tools as Record<string, unknown>;
      const back = (ids: string[]): string[] =>
        ids.flatMap((id) => {
          const lowerTool = CANONICAL_BY_OPENCLAW_TOOL[id];
          return lowerTool ? [canonicalRule(lowerTool, null)] : [];
        });
      // `tools.allow` is OpenClaw's absolute allowlist and is never written by
      // agents-cli (see convertToOpenClawFormat), so it is not read back either.
      return permissionSet(back(stringList(t.alsoAllow)), back(stringList(t.deny)));
    },
  },

  hermes: {
    home: (h) => path.join(h, '.hermes', 'config.yaml'),
    lossyBecause: 'Hermes gates shell commands only, so non-Bash rules were never written',
    toCanonical(configPath) {
      const config = readYaml(configPath);
      if (!config) return null;
      const approvals = config.approvals;
      const denyList = approvals && typeof approvals === 'object' && !Array.isArray(approvals)
        ? stringList((approvals as Record<string, unknown>).deny)
        : [];
      const back = (commands: string[]): string[] =>
        commands.map((c) => (c === '*' ? 'Bash(*)' : `Bash(${denormalizeBashPattern(c)})`));
      return permissionSet(back(stringList(config.command_allowlist)), back(denyList));
    },
  },
};

/**
 * Invert `kimiBashPatterns` + `canonicalToKimiRules`.
 *
 * Kimi writes a bare tool name for a blanket grant (`Bash`, `Read`), and expands
 * one canonical `cmd:*` into TWO picomatch patterns (`Bash(cmd*)` and
 * `Bash(cmd*​/**)`) so slash-bearing arguments match. Both collapse back to the
 * single canonical rule, and the caller dedupes.
 */
function kimiPatternToCanonical(pattern: string): string | null {
  const m = pattern.match(/^([\w-]+)\((.*)\)$/);
  if (!m) {
    // Bare tool name — a blanket grant, or an MCP tool id Kimi matches by name.
    const lower = pattern.toLowerCase();
    return lower in CANONICAL_TOOL_CASE ? canonicalRule(lower, null) : pattern;
  }
  const lowerTool = m[1].toLowerCase();
  let arg = m[2];
  if (lowerTool === 'bash') {
    if (arg.endsWith('*/**')) arg = arg.slice(0, -'*/**'.length) + ':*';
    else if (arg.endsWith('*')) arg = arg.slice(0, -1) + ':*';
    if (arg === ':*') return 'Bash(*)';
  }
  return canonicalRule(lowerTool, arg);
}

/** The registry entry for `agent`, or undefined when it stores no permissions. */
export function permissionTarget(agent: AgentId): PermissionTarget | undefined {
  return PERMISSION_TARGETS[agent];
}

/**
 * Read `agent`'s permissions from `home` (a version home or the real HOME) and
 * project them to canonical form. `scope: 'project'` reads the repo-local file
 * for the harnesses that have one, and returns null for those that do not.
 */
export function readCanonicalPermissions(
  agent: AgentId,
  scope: 'user' | 'project' = 'user',
  cwd?: string,
  home?: string,
): PermissionSet | null {
  const target = PERMISSION_TARGETS[agent];
  if (!target) return null;
  if (scope === 'project') {
    if (!target.project) return null;
    return target.toCanonical(target.project(cwd ?? process.cwd()));
  }
  // os.homedir() -- not `process.env.HOME ?? ''`, which resolved a RELATIVE
  // path (`.grok/config.toml`) when HOME is unset, as it is on Windows.
  return target.toCanonical(target.home(home ?? os.homedir()));
}
