/**
 * Cloud dispatch type definitions.
 *
 * Defines the provider-agnostic interface that all cloud backends (Rush, Codex,
 * Factory) implement, plus the shared task and event types that flow through
 * the dispatch pipeline.
 */

/**
 * Identifier for a supported cloud dispatch backend.
 *
 * Each id is one agent's *own* cloud:
 *   - `rush`        — Rush Cloud (runs Claude against a GitHub repo → PR)
 *   - `codex`       — OpenAI Codex Cloud (`codex cloud exec`)
 *   - `factory`     — Factory Droid Computers (`droid computer ssh` + remote `droid exec`)
 *   - `antigravity` — Google Gemini Managed Agents (Interactions API)
 *
 * Agents route to their native cloud automatically (see `cloudProvider` in the
 * agent registry); `--provider` overrides.
 */
export type CloudProviderId = 'rush' | 'codex' | 'factory' | 'antigravity';

/**
 * Lifecycle state of a cloud-dispatched task.
 *
 * `idle` represents a long-lived session that has stopped between turns and
 * can be resumed via `message()`. Distinct from the terminal `completed |
 * failed | cancelled` states, which cannot transition back to `running`.
 */
export type CloudTaskStatus =
  | 'queued'
  | 'allocating'
  | 'running'
  | 'idle'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Snapshot of a dispatched task, stored locally and refreshed from the provider. */
export interface CloudTask {
  id: string;
  provider: CloudProviderId;
  status: CloudTaskStatus;
  agent?: string;
  prompt: string;
  /**
   * First (or only) repo the task targets. Kept for back-compat with callers
   * that treat one task as one repo. For multi-repo dispatches, see `repos`.
   */
  repo?: string;
  /**
   * All repos the task targets, in dispatch order. Populated for multi-repo
   * dispatches (Rush Cloud, and any provider that supports it). `repo`
   * mirrors `repos[0]` when both are set.
   */
  repos?: string[];
  branch?: string;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
  summary?: string;
}

/**
 * Single event emitted by a running cloud task.
 *
 * Discriminated union mirroring the local `SessionEvent` taxonomy so cloud
 * streams can be rendered with the same UI primitives as local sessions. The
 * `unknown` variant catches event names the provider emits that the client
 * doesn't recognize — surfacing them rather than silently dropping is the
 * point.
 */
export type CloudEvent =
  | { type: 'text'; content: string; timestamp?: string }
  | { type: 'thinking'; content: string; timestamp?: string }
  | { type: 'tool_use'; tool: string; input: unknown; timestamp?: string }
  | { type: 'tool_result'; tool: string; output: unknown; timestamp?: string }
  | { type: 'status'; status: CloudTaskStatus; timestamp?: string }
  | { type: 'usage'; model?: string; inputTokens?: number; outputTokens?: number; timestamp?: string }
  | { type: 'done'; status?: CloudTaskStatus; prUrl?: string; summary?: string; timestamp?: string }
  | { type: 'error'; message: string; timestamp?: string }
  | { type: 'unknown'; name: string; data: string; timestamp?: string };

/** Reference to a skill that should ride along with a cloud dispatch. */
export interface SkillRef {
  id: string;
  version?: string;
}

/** A vision attachment carried along with a prompt (base64-encoded image bytes). */
export interface ImageAttachment {
  data: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

/** Maximum images allowed per dispatch (matches Cursor Background Agents). */
export const MAX_IMAGES_PER_DISPATCH = 5;

/** Parameters for dispatching a new cloud task. */
export interface DispatchOptions {
  prompt: string;
  agent?: string;
  /**
   * Legacy single-repo target. Still honored: if `repos` is empty, this
   * becomes the only repo. Providers that support multi-repo treat
   * `repos = [repo]` and `repo` as equivalent.
   */
  repo?: string;
  /**
   * One or more repos the dispatch targets. Repeatable on the CLI via
   * `--repo`. Providers handle multi-repo differently:
   *   - Rush Cloud clones each into /workspace/<owner>/<name>/
   *   - Codex Cloud rejects (multi-repo requires an env that bundles them)
   *   - Factory (local) clones each into the workspace before dispatch
   */
  repos?: string[];
  branch?: string;
  timeout?: string;
  model?: string;
  /**
   * Skills to ship with the dispatch. Providers that support skills mount
   * them in the pod's skills directory before the agent runs. Providers
   * without skill support reject via `capabilities().skills === false`.
   */
  skills?: SkillRef[];
  /**
   * Image attachments for vision-enabled dispatch (e.g., "fix this UI bug,
   * here's the screenshot"). Capped at MAX_IMAGES_PER_DISPATCH.
   */
  images?: ImageAttachment[];
  /** Provider-specific options (e.g., codex env ID, factory computer name). */
  providerOptions?: Record<string, unknown>;
}

/**
 * Collapse `repo` + `repos` into a single deduped list. Exported so callers,
 * tests, and every provider share the same resolution — one source of truth
 * for "which repos does this dispatch target?".
 */
export function resolveDispatchRepos(options: DispatchOptions): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  if (options.repos) candidates.push(...options.repos);
  if (options.repo) candidates.push(options.repo);
  for (const raw of candidates) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * What a provider can actually do. Replaces the single-bool `supports()` so
 * callers can ask "does this provider support cancel?" without trying and
 * catching. The CLI gates feature-specific calls on these flags and surfaces
 * a typed error instead of letting throws bubble.
 */
export interface ProviderCapabilities {
  /** Configured + reachable (auth present, binary installed, etc.). */
  available: boolean;
  dispatch: boolean;
  status: boolean;
  list: boolean;
  stream: boolean;
  cancel: boolean;
  message: boolean;
  multiRepo: boolean;
  skills: boolean;
  images: boolean;
}

/**
 * Contract that every cloud backend must implement.
 *
 * Each provider translates between the unified dispatch interface and its
 * backend-specific API (Rush Factory Floor, Codex Cloud CLI, Droid daemon).
 *
 * `message()` may transition a task from `idle` back to `running`.
 */
export interface CloudProvider {
  id: CloudProviderId;
  name: string;

  /** Static capability map for this provider. Read before calling feature methods. */
  capabilities(): ProviderCapabilities;

  dispatch(options: DispatchOptions): Promise<CloudTask>;
  status(taskId: string): Promise<CloudTask>;
  list(filter?: { status?: CloudTaskStatus }): Promise<CloudTask[]>;

  /** Stream live output. Yields events until task completes or caller breaks. */
  stream(taskId: string): AsyncIterable<CloudEvent>;

  cancel(taskId: string): Promise<void>;

  /** Send a follow-up message to a finished/idle/needs_review task. */
  message(taskId: string, content: string): Promise<void>;
}

/** Autonomy level passed to `droid exec --auto` for Factory cloud dispatches. */
export type DroidAutonomy = 'low' | 'medium' | 'high';

/** Per-provider configuration stored in the `cloud.providers` section of agents.yaml. */
export interface CloudProviderConfig {
  rush?: Record<string, string>;
  codex?: { env?: string };
  /**
   * Factory (Droid) cloud. `computer` is the pre-provisioned Droid Computer
   * name (managed in Factory's UI, or BYOM via `droid computer register`) —
   * the Factory analogue of Codex's pre-built `env`. `autonomy` is the default
   * `droid exec --auto` level for cloud runs (defaults to `high`).
   */
  factory?: { computer?: string; autonomy?: DroidAutonomy };
  /**
   * Antigravity (Gemini Managed Agents) cloud. The Gemini API key is read from
   * an `agents secrets` bundle named here (never stored in agents.yaml); if
   * unset, the provider falls back to GEMINI_API_KEY / GOOGLE_API_KEY in the
   * environment. `model` overrides the default managed-agent id.
   */
  antigravity?: { secretsBundle?: string; model?: string };
}

/** Top-level `cloud` section of agents.yaml. */
export interface CloudConfig {
  default_provider?: CloudProviderId;
  providers?: CloudProviderConfig;
}
