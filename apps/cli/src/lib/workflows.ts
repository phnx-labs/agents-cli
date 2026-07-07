/**
 * Workflow management library.
 *
 * Workflows are directory bundles with a WORKFLOW.md containing YAML frontmatter.
 * They optionally contain subagents/, skills/, and plugins/ subdirectories that
 * are composed at runtime by `agents run <workflow>`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId } from './types.js';
import { capableAgents } from './capabilities.js';
import {
  getProjectAgentsDir,
  getSystemWorkflowsDir,
  getUserWorkflowsDir,
  getTrashWorkflowsDir,
  getEnabledExtraRepos,
} from './state.js';
import { listInstalledVersions, getVersionHomePath } from './versions.js';

// WORKFLOW_CAPABLE_AGENTS removed — use `capableAgents('workflows')` from
// lib/capabilities.ts. The capability matrix on AgentConfig is the single
// source of truth.

/**
 * The `loop:` block as it appears in WORKFLOW.md frontmatter (YAML, snake_case).
 * Parsed defensively and translated to the camelCase LoopConfig the driver
 * consumes (src/lib/loop.ts). See docs/07-entrypoints-and-loops.md.
 */
export interface LoopConfigRaw {
  /** Stop condition. Only `signal` is supported today. */
  until?: 'signal';
  /** Hard cap on iterations. */
  max_iterations?: number;
  /** Token hard-cap, enforced outside the agent. */
  budget?: number;
  /** Delay between iterations ("0" back-to-back, "30m" paces). */
  interval?: string;
}

/**
 * The `verify:` sub-block of a `for_each:` construct (issue #343).
 *
 * Each produced item's stage teammate can be gated by a panel of independent
 * skeptics: `votes` of them run (as teammates that depend on the stage), and
 * `keep_if` records how their verdicts converge (`majority` / `all` / `any`).
 * The vote-counting itself is a downstream concern — the declarative layer's
 * job is to expand the panel; see `expandForEach`.
 */
export interface ForEachVerifySpec {
  /** Subagent / agent id that plays skeptic for each item. */
  agent: string;
  /** Prompt template for each skeptic (`{{item}}`, `{{index}}` substituted). */
  prompt?: string;
  /** How many independent skeptics run per item (>= 1). */
  votes: number;
  /** Convergence rule for keeping a finding. */
  keep_if: 'majority' | 'all' | 'any';
}

/**
 * The `for_each:` block as it appears in WORKFLOW.md frontmatter (issue #343).
 *
 * Declarative dynamic fan-out: a producer emits a list at runtime, one stage
 * teammate runs per produced item (runtime-computed N), optionally followed by
 * a `verify` panel. This is a thin declarative layer over the existing teams
 * substrate — each expanded teammate is staged into the supervisor's
 * mid-flight-add path (`AgentManager.spawn`), NOT a new engine. See
 * `expandForEach` and `src/lib/teams/forEach.ts`.
 *
 * Parsed defensively (mirrors `parseLoopBlock`): a malformed block drops to
 * undefined rather than passing a bad shape downstream.
 */
export interface ForEachSpec {
  /**
   * The producer: a shell command or subagent whose stdout is a JSON array (or
   * newline-delimited list) of items. Alternatively `itemsRef` names a prior
   * step's output. At least one of the two is expected for a runnable spec.
   */
  produce?: string;
  /** `${step}`-style reference to a prior step's produced list. */
  itemsRef?: string;
  /** Subagent / agent id for the per-item stage. */
  agent: string;
  /** Base name for the expanded teammates (default `item`). */
  name?: string;
  /** Per-item prompt template (`{{item}}`, `{{index}}` substituted). */
  prompt: string;
  /** In-flight cap — maps to the supervisor's wave size (>= 1). */
  concurrency?: number;
  /**
   * Hard runaway guard: the producer can emit at most this many items before
   * the fan-out is truncated. Defaults to `DEFAULT_FOR_EACH_CAP`.
   */
  max_items?: number;
  /** Optional convergence gate run after each item's stage. */
  verify?: ForEachVerifySpec;
}

/**
 * Hard upper bound on items a single `for_each` expands, absent an explicit
 * `max_items`. A guard against a runaway producer spawning unbounded teammates
 * (acceptance criterion in issue #343). Anthropic's Dynamic Workflows cap at
 * 1000; we default lower and let authors raise it deliberately.
 */
export const DEFAULT_FOR_EACH_CAP = 256;

/** Parsed WORKFLOW.md frontmatter. */
export interface WorkflowFrontmatter {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  skills?: string[];
  mcpServers?: string[];
  allowedAgents?: string[];
  /**
   * Secrets bundle names this workflow needs (e.g. `linear.app`, `github.com`).
   * When `agents run <workflow>` resolves a workflow, these are unioned into the
   * effective `--secrets` list and resolved from the macOS Keychain before spawn.
   * Pass `--no-auto-secrets` to skip this injection.
   */
  secrets?: string[];
  /**
   * Optional loop block: wraps the workflow in a bounded until-condition loop
   * (issue #332). When present, `agents run <workflow>` honors it without a
   * `--loop` flag. Validated/coerced in parseWorkflowFrontmatter.
   */
  loop?: LoopConfigRaw;
  /**
   * Optional declarative dynamic fan-out (issue #343): a producer emits a list
   * and one stage teammate runs per item, with an optional verify panel.
   * Validated/coerced in parseWorkflowFrontmatter via `parseForEachBlock`.
   */
  forEach?: ForEachSpec;
}

/** A workflow found during repo discovery. */
export interface DiscoveredWorkflow {
  name: string;
  path: string;
  frontmatter: WorkflowFrontmatter;
  subagentCount: number;
}

/** A workflow in central storage (~/.agents/workflows/ or ~/.agents/.system/workflows/). */
export interface InstalledWorkflow {
  name: string;
  path: string;
  frontmatter: WorkflowFrontmatter;
  subagentCount: number;
}

/** Parse WORKFLOW.md frontmatter from a workflow directory. Returns null if invalid. */
export function parseWorkflowFrontmatter(workflowDir: string): WorkflowFrontmatter | null {
  const workflowMdPath = path.join(workflowDir, 'WORKFLOW.md');
  if (!fs.existsSync(workflowMdPath)) return null;

  try {
    const content = fs.readFileSync(workflowMdPath, 'utf-8');
    const lines = content.split('\n');
    if (lines[0] !== '---') return null;
    const endIndex = lines.slice(1).findIndex(l => l === '---');
    if (endIndex < 0) return null;

    const frontmatter = lines.slice(1, endIndex + 1).join('\n');
    const parsed = yaml.parse(frontmatter);
    if (!parsed || typeof parsed !== 'object') return null;

    // Capability-scoping fields are wired into the run (see src/commands/exec.ts);
    // coerce to string arrays defensively so a malformed `tools: foo` (scalar) or
    // `tools: [Read, 3]` (mixed) never reaches buildExecCommand as a bad shape.
    const asStringArray = (v: unknown): string[] | undefined =>
      Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined;

    return {
      name: parsed.name || '',
      description: parsed.description || '',
      model: parsed.model,
      tools: asStringArray(parsed.tools),
      skills: asStringArray(parsed.skills),
      mcpServers: asStringArray(parsed.mcpServers),
      allowedAgents: asStringArray(parsed.allowedAgents),
      secrets: asStringArray(parsed.secrets),
      loop: parseLoopBlock(parsed.loop),
      forEach: parseForEachBlock(parsed.for_each),
    };
  } catch {
    return null;
  }
}

/**
 * Defensively coerce a frontmatter `loop:` value into a LoopConfigRaw.
 *
 * Mirrors the asStringArray discipline above: a malformed field is dropped to
 * undefined rather than passed through, so the loop driver never sees a bad
 * shape. Returns undefined when `loop:` is absent or not an object, or when no
 * recognized field survives coercion (an all-garbage block is treated as
 * "no loop", not "empty loop").
 *
 * Field rules:
 *   - until:          only the literal `signal` is accepted; anything else dropped.
 *   - max_iterations: a finite positive integer; non-numbers/<=0 dropped.
 *   - budget:         a finite positive number (tokens); non-numbers/<=0 dropped.
 *   - interval:       a string (e.g. "0", "30m"); non-strings dropped.
 */
export function parseLoopBlock(v: unknown): LoopConfigRaw | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  const out: LoopConfigRaw = {};

  if (raw.until === 'signal') out.until = 'signal';

  if (typeof raw.max_iterations === 'number'
    && Number.isFinite(raw.max_iterations)
    && Number.isInteger(raw.max_iterations)
    && raw.max_iterations > 0) {
    out.max_iterations = raw.max_iterations;
  }

  if (typeof raw.budget === 'number' && Number.isFinite(raw.budget) && raw.budget > 0) {
    out.budget = raw.budget;
  }

  if (typeof raw.interval === 'string') out.interval = raw.interval;

  return Object.keys(out).length > 0 ? out : undefined;
}

/** A finite positive integer, or undefined. Shared guard for count-like fields. */
function asPosInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0
    ? v
    : undefined;
}

/** A non-empty trimmed string, or undefined. */
function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/**
 * Defensively coerce a frontmatter `verify:` sub-block into a ForEachVerifySpec.
 *
 * Requires an `agent`; drops the whole block otherwise (a verify panel with no
 * skeptic is meaningless). `votes` defaults to 1 (a single confirmation) and
 * `keep_if` to `majority`; both are validated against their allowed shapes.
 */
export function parseVerifyBlock(v: unknown): ForEachVerifySpec | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;

  const agent = asNonEmptyString(raw.agent);
  if (!agent) return undefined;

  const keepIf = raw.keep_if;
  const out: ForEachVerifySpec = {
    agent,
    votes: asPosInt(raw.votes) ?? 1,
    keep_if:
      keepIf === 'all' || keepIf === 'any' || keepIf === 'majority'
        ? keepIf
        : 'majority',
  };
  const prompt = asNonEmptyString(raw.prompt);
  if (prompt) out.prompt = prompt;
  return out;
}

/**
 * Defensively coerce a frontmatter `for_each:` block into a ForEachSpec (issue
 * #343). Mirrors `parseLoopBlock`'s discipline: a block missing the two
 * load-bearing fields (`agent` + `prompt`) drops to undefined rather than
 * passing a half-formed spec to the expander. Optional numeric/verify fields
 * are individually validated and dropped when malformed.
 */
export function parseForEachBlock(v: unknown): ForEachSpec | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;

  const agent = asNonEmptyString(raw.agent);
  const prompt = asNonEmptyString(raw.prompt);
  if (!agent || !prompt) return undefined;

  const out: ForEachSpec = { agent, prompt };

  const produce = asNonEmptyString(raw.produce);
  if (produce) out.produce = produce;
  // `for_each: ${step}` references a prior step's list. Accept either the
  // snake-case `for_each` key or an explicit `items_ref`.
  const itemsRef = asNonEmptyString(raw.for_each) ?? asNonEmptyString(raw.items_ref);
  if (itemsRef) out.itemsRef = itemsRef;

  const name = asNonEmptyString(raw.name);
  if (name) out.name = name;

  const concurrency = asPosInt(raw.concurrency);
  if (concurrency) out.concurrency = concurrency;

  const maxItems = asPosInt(raw.max_items);
  if (maxItems) out.max_items = maxItems;

  const verify = parseVerifyBlock(raw.verify);
  if (verify) out.verify = verify;

  return out;
}

/** One teammate produced by expanding a `for_each` spec against a produced list. */
export interface ForEachTeammate {
  /** `stage` runs the per-item work; `verify` is a skeptic in the panel. */
  role: 'stage' | 'verify';
  /** Unique teammate name within the team (used for `--after` linkage). */
  name: string;
  /** Subagent / agent id this teammate runs as. */
  agentType: string;
  /** Fully-resolved prompt (template variables already substituted). */
  prompt: string;
  /** Names of sibling teammates this one waits on (`--after` semantics). */
  after: string[];
  /** The produced item this teammate handles. */
  item: string;
  /** Zero-based index of the item in the (capped) produced list. */
  itemIndex: number;
  /** For `verify` teammates: 1-based vote index and the panel's gate config. */
  vote?: number;
  votes?: number;
  keep_if?: 'majority' | 'all' | 'any';
}

/** Result of expanding a `for_each` spec: the teammates plus cap accounting. */
export interface ForEachExpansion {
  teammates: ForEachTeammate[];
  /** How many items the producer emitted (pre-cap). */
  producedCount: number;
  /** How many items were actually expanded (post-cap). */
  usedCount: number;
  /** producedCount - usedCount; > 0 means the runaway guard truncated. */
  truncated: number;
  /** The effective per-`for_each` item cap that was applied. */
  cap: number;
}

/**
 * Substitute `{{item}}` / `{{index}}` (and 1-based `{{n}}`) in a prompt
 * template. Unknown `{{...}}` tokens are left intact so a template can carry
 * placeholders the caller resolves elsewhere.
 */
export function renderForEachTemplate(template: string, item: string, index: number): string {
  return template
    .replace(/\{\{\s*item\s*\}\}/g, item)
    .replace(/\{\{\s*index\s*\}\}/g, String(index))
    .replace(/\{\{\s*n\s*\}\}/g, String(index + 1));
}

/**
 * Expand a `for_each` spec against a producer's output into concrete teammate
 * descriptors (issue #343) — the heart of the declarative fan-out.
 *
 * Pure and deterministic: no I/O, no spawning. `src/lib/teams/forEach.ts`
 * feeds the result to `AgentManager.spawn`, staging each descriptor into the
 * supervisor's existing mid-flight-add path — so this reuses the dynamic-DAG
 * substrate rather than introducing a new engine.
 *
 * For N produced items (capped at `spec.max_items` / `DEFAULT_FOR_EACH_CAP`):
 *   - one `stage` teammate per item, depending on `producerName` if given;
 *   - when `verify` is set, `votes` `verify` teammates per item, each
 *     depending on that item's stage teammate.
 *
 * Names are unique (`<base>-<n>` and `<base>-<n>-verify-<v>`) so `--after`
 * linkage and the teams cycle check carry over unchanged.
 */
export function expandForEach(
  spec: ForEachSpec,
  items: string[],
  opts: { producerName?: string } = {},
): ForEachExpansion {
  const cap = spec.max_items ?? DEFAULT_FOR_EACH_CAP;
  const producedCount = items.length;
  const used = items.slice(0, cap);
  const base = spec.name ?? 'item';
  const teammates: ForEachTeammate[] = [];

  used.forEach((item, itemIndex) => {
    const stageName = `${base}-${itemIndex + 1}`;
    teammates.push({
      role: 'stage',
      name: stageName,
      agentType: spec.agent,
      prompt: renderForEachTemplate(spec.prompt, item, itemIndex),
      after: opts.producerName ? [opts.producerName] : [],
      item,
      itemIndex,
    });

    if (spec.verify) {
      const verifyPrompt = spec.verify.prompt ?? spec.prompt;
      for (let vote = 1; vote <= spec.verify.votes; vote++) {
        teammates.push({
          role: 'verify',
          name: `${stageName}-verify-${vote}`,
          agentType: spec.verify.agent,
          prompt: renderForEachTemplate(verifyPrompt, item, itemIndex),
          after: [stageName],
          item,
          itemIndex,
          vote,
          votes: spec.verify.votes,
          keep_if: spec.verify.keep_if,
        });
      }
    }
  });

  return {
    teammates,
    producedCount,
    usedCount: used.length,
    truncated: producedCount - used.length,
    cap,
  };
}

/**
 * Decide which subagent .md stems a workflow may use, given the discovered
 * subagent files and the parsed `allowedAgents` frontmatter. This is the
 * fail-closed security boundary for issue #324:
 *
 *   - `allowedAgents === undefined` (field absent)  -> NO restriction; allow all.
 *   - `allowedAgents === []`        (present, empty) -> allow ZERO; copy none.
 *   - `allowedAgents = [a, b]`                       -> allow only those stems.
 *
 * An explicit empty array must NEVER widen to "allow all" — that would copy
 * every subagent definition into the run, granting MORE access than declared.
 *
 * `available` are the .md filenames found in subagents/ (e.g. `security.md`).
 * Returns the stems to copy and any allowedAgents entries with no matching file.
 */
export function resolveAllowedSubagents(
  available: string[],
  allowedAgents: string[] | undefined,
): { allowedStems: string[]; missing: string[] } {
  const stems = available.filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
  if (allowedAgents === undefined) {
    return { allowedStems: stems, missing: [] };
  }
  const allow = new Set(allowedAgents);
  const present = new Set(stems);
  return {
    allowedStems: stems.filter(s => allow.has(s)),
    missing: allowedAgents.filter(a => !present.has(a)),
  };
}

/**
 * Prune stale workflow-managed subagent files from the shared per-agent agents
 * dir before a scoped run writes the permitted set (issue #401, follow-up to
 * #324). A prior *unrestricted* run of a workflow copies every subagent
 * definition into the shared `~/.claude/agents/` dir; a later run that declares
 * `allowedAgents:` copies only the permitted ones but never removes the
 * leftovers — so an unlisted subagent stays on disk and remains dispatchable,
 * silently defeating the fail-closed scope.
 *
 * Fail-closed fix (mirrors how `cleanupWorkflowMcpConfig` only tears down what
 * the workflow itself created): remove any file that (a) belongs to THIS
 * workflow's subagents/ — matched by filename, i.e. the workflow-managed
 * universe — and (b) is NOT in the permitted set. A user's own hand-placed
 * subagent shares no name with a workflow subagent file, so it is never
 * touched. Permitted files are left in place; the caller (re)copies them.
 *
 * `workflowSubagentFiles` are the .md filenames in the workflow's subagents/
 * dir (e.g. `security.md`); `allowedStems` are the permitted stems from
 * `resolveAllowedSubagents`. Returns the filenames actually removed.
 */
export function pruneStaleWorkflowSubagents(
  sharedAgentsDir: string,
  workflowSubagentFiles: string[],
  allowedStems: string[],
): string[] {
  if (!fs.existsSync(sharedAgentsDir)) return [];
  const allow = new Set(allowedStems);
  const pruned: string[] = [];
  for (const file of workflowSubagentFiles) {
    if (!file.endsWith('.md')) continue;
    const stem = file.replace(/\.md$/, '');
    if (allow.has(stem)) continue; // permitted → the copy step will (re)write it
    const target = path.join(sharedAgentsDir, file);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      pruned.push(file);
    }
  }
  return pruned;
}

/** Count subagent .md files in a workflow's subagents/ directory. */
export function countWorkflowSubagents(workflowDir: string): number {
  const subagentsDir = path.join(workflowDir, 'subagents');
  if (!fs.existsSync(subagentsDir)) return 0;
  try {
    return fs.readdirSync(subagentsDir).filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

function expandWorkflowPath(ref: string): string {
  if (ref === '~') return process.env.HOME ?? ref;
  if (ref.startsWith('~/')) {
    const home = process.env.HOME;
    return home ? path.join(home, ref.slice(2)) : ref;
  }
  return ref;
}

function isWorkflowDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'WORKFLOW.md'));
}

function resolveWorkflowPath(ref: string, cwd: string): string | null {
  const expanded = expandWorkflowPath(ref);
  const candidate = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  return isWorkflowDir(candidate) ? candidate : null;
}

/**
 * Resolve an `agents run <workflow>` reference.
 *
 * Directories are accepted anywhere on disk when they contain WORKFLOW.md.
 * Name lookup keeps the normal resource precedence: project > user > system > extras.
 */
export function resolveWorkflowRef(ref: string, cwd: string = process.cwd()): string | null {
  const direct = resolveWorkflowPath(ref, cwd);
  if (direct) return direct;

  const projectAgentsDir = getProjectAgentsDir(cwd);
  const searchDirs = [
    ...(projectAgentsDir ? [path.join(projectAgentsDir, 'workflows')] : []),
    getUserWorkflowsDir(),
    getSystemWorkflowsDir(),
    ...getEnabledExtraRepos().map(r => path.join(r.dir, 'workflows')),
  ];

  for (const dir of searchDirs) {
    const workflowPath = path.join(dir, ref);
    if (isWorkflowDir(workflowPath)) return workflowPath;
  }
  return null;
}

/**
 * Discover all workflow directories (those containing WORKFLOW.md) in a local path.
 * Checks if the path itself is a workflow, then scans a top-level workflows/ subdirectory,
 * then falls back to scanning all immediate subdirectories.
 */
export function discoverWorkflowsFromRepo(repoPath: string): DiscoveredWorkflow[] {
  const results: DiscoveredWorkflow[] = [];

  // The path itself may be a single workflow directory.
  if (fs.existsSync(path.join(repoPath, 'WORKFLOW.md'))) {
    const frontmatter = parseWorkflowFrontmatter(repoPath);
    if (frontmatter) {
      return [{
        name: path.basename(repoPath),
        path: repoPath,
        frontmatter,
        subagentCount: countWorkflowSubagents(repoPath),
      }];
    }
  }

  // Try a workflows/ subdirectory first, then fall back to scanning root subdirectories.
  const workflowsSubdir = path.join(repoPath, 'workflows');
  const scanDir = fs.existsSync(workflowsSubdir) ? workflowsSubdir : repoPath;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scanDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const workflowPath = path.join(scanDir, entry.name);
    const frontmatter = parseWorkflowFrontmatter(workflowPath);
    if (frontmatter) {
      results.push({
        name: entry.name,
        path: workflowPath,
        frontmatter,
        subagentCount: countWorkflowSubagents(workflowPath),
      });
    }
  }

  return results;
}

/**
 * List all workflows in central storage.
 * User layer (~/.agents/workflows/) wins over system (~/.agents/.system/workflows/).
 */
export function listInstalledWorkflows(): Map<string, InstalledWorkflow> {
  const result = new Map<string, InstalledWorkflow>();
  const extraRepos = getEnabledExtraRepos();

  const searchDirs = [
    getUserWorkflowsDir(),
    getSystemWorkflowsDir(),
    ...extraRepos.map(r => path.join(r.dir, 'workflows')),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (result.has(entry.name)) continue; // Higher-priority layer already present

      const workflowPath = path.join(dir, entry.name);
      const frontmatter = parseWorkflowFrontmatter(workflowPath);
      if (!frontmatter) continue;

      result.set(entry.name, {
        name: entry.name,
        path: workflowPath,
        frontmatter,
        subagentCount: countWorkflowSubagents(workflowPath),
      });
    }
  }

  return result;
}

/** Copy a workflow directory into user central storage (~/.agents/workflows/<name>/). */
export function installWorkflowCentrally(sourcePath: string, name: string): { success: boolean; error?: string } {
  const targetPath = path.join(getUserWorkflowsDir(), name);
  try {
    fs.mkdirSync(getUserWorkflowsDir(), { recursive: true });
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    fs.cpSync(sourcePath, targetPath, { recursive: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Move a workflow from user central storage to trash. */
export function removeWorkflow(name: string): { success: boolean; error?: string } {
  const sourcePath = path.join(getUserWorkflowsDir(), name);
  if (!fs.existsSync(sourcePath)) {
    return { success: false, error: `Workflow '${name}' not found in ~/.agents/workflows/` };
  }
  try {
    const trashDir = getTrashWorkflowsDir();
    fs.mkdirSync(trashDir, { recursive: true });
    fs.renameSync(sourcePath, path.join(trashDir, `${name}-${Date.now()}`));
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** List workflow names synced into a specific agent version home (at {versionHome}/workflows/). */
export function listWorkflowsForAgent(_agent: AgentId, versionHome: string): string[] {
  const workflowsDir = path.join(versionHome, 'workflows');
  if (!fs.existsSync(workflowsDir)) return [];
  try {
    return fs.readdirSync(workflowsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(workflowsDir, d.name, 'WORKFLOW.md')))
      .map(d => d.name);
  } catch {
    return [];
  }
}

/** Copy a workflow directory into a version home at {versionHome}/workflows/<name>/. */
export function syncWorkflowToVersion(
  workflowPath: string,
  name: string,
  _agent: AgentId,
  versionHome: string,
): { success: boolean; error?: string } {
  const targetDir = path.join(versionHome, 'workflows', name);
  try {
    fs.mkdirSync(path.join(versionHome, 'workflows'), { recursive: true });
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.cpSync(workflowPath, targetDir, { recursive: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Remove a workflow from a specific agent version home. */
export function removeWorkflowFromVersion(
  agent: AgentId,
  version: string,
  name: string,
): { success: boolean; error?: string } {
  const versionHome = getVersionHomePath(agent, version);
  const targetDir = path.join(versionHome, 'workflows', name);
  if (!fs.existsSync(targetDir)) {
    return { success: false, error: `Workflow '${name}' not synced to ${agent}@${version}` };
  }
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Iterate all installed (agent, version) pairs that support workflows. */
export function iterWorkflowsCapableVersions(filter?: { agent?: AgentId; version?: string }): Array<{ agent: AgentId; version: string }> {
  const result: Array<{ agent: AgentId; version: string }> = [];
  for (const agentId of capableAgents('workflows')) {
    if (filter?.agent && filter.agent !== agentId) continue;
    const versions = listInstalledVersions(agentId);
    for (const version of versions) {
      if (filter?.version && filter.version !== version) continue;
      result.push({ agent: agentId, version });
    }
  }
  return result;
}
