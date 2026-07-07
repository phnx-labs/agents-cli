import type { TaskSummary, TerminalDetail as TerminalInfo } from '../../types'

export type PendingDispatch = {
  id: string
  agentType: string
  target: 'local' | 'cloud' | 'device'
  taskId: string
  taskIdentifier: string
  title: string
  createdAt: number
  targetRepo?: string
  // Device-target metadata (target === 'device'): the registered device the
  // agent is spawned on over SSH, the secret bundle its creds resolve from, the
  // resolved project path on that host, the repo slug, and the auto-sync policy.
  deviceName?: string
  secretRef?: string
  projectPath?: string
  repoSlug?: string
  syncPolicy?: 'off' | 'safe' | 'aggressive'
  /**
   * 'pending' = dispatched, waiting for a matching terminal/task to appear
   * 'timedOut' = TTL elapsed with no match — treated as a failure signal,
   * surfaced to the user as a dismissable warning so silent cloud-dispatch
   * failures (wrong repo, auth, pod-alloc timeout) are visible instead of
   * just disappearing. Defaults to 'pending' when undefined.
   */
  status?: 'pending' | 'timedOut'
}

// Pending lifetime: we wait up to TTL_MS for a matching agent to appear,
// then flip the entry to `timedOut` (still visible as a warning). The
// entry is fully removed once TTL + RETENTION_MS has elapsed, or when
// the user clicks dismiss. 30s was too tight — Rush Cloud cold starts
// regularly take 60–90s and were silently dropping out of the UI mid-
// startup. 180s covers common cold-start latency without making real
// failures feel permanent.
export const PENDING_DISPATCH_TTL_MS = 180_000
export const TIMED_OUT_RETENTION_MS = 300_000
export const JUST_SPAWNED_WINDOW_MS = 15000

export function isTerminalJustSpawned(createdAt: number | undefined, now: number): boolean {
  if (!createdAt) return false
  const ageMs = now - createdAt
  return ageMs >= 0 && ageMs < JUST_SPAWNED_WINDOW_MS
}

export function isTerminalActive(
  t: Pick<TerminalInfo, 'status' | 'currentActivity' | 'createdAt'>,
  now: number
): boolean {
  if (t.status === 'running') return true
  if (t.currentActivity) return true
  return isTerminalJustSpawned(t.createdAt, now)
}

export function reconcilePending(
  pending: PendingDispatch[],
  terminals: Pick<TerminalInfo, 'agentType' | 'createdAt'>[],
  tasks: TaskSummary[],
  matchSlackMs = 1000
): PendingDispatch[] {
  if (pending.length === 0) return pending
  const consumed = new Set<string>()
  for (const p of pending) {
    const termMatch = terminals.find((t) =>
      t.agentType === p.agentType && (t.createdAt || 0) >= p.createdAt - matchSlackMs
    )
    if (p.target === 'local' || p.target === 'device') {
      // Device dispatch spawns over SSH on a remote host, so there is no local
      // terminal to match in the common case — a same-agentType local terminal
      // (e.g. an ssh session tab) is still accepted as a best-effort signal;
      // otherwise the entry falls through to the TTL clock like local does.
      if (termMatch) consumed.add(p.id)
      continue
    }
    // Cloud target: the authoritative signal is a non-failed cloud-run
    // agent in `tasks` (cloud-runs API merges into the same shape via
    // fetchCloudRuns). A fresh local terminal of the same agentType is the
    // secondary signal — the extension dispatches via `rush cloud run` in
    // a local terminal, so a fresh terminal proves the dispatch fired even
    // when the cloud-runs poll is briefly stale or paused. `failed` cloud
    // agents are excluded here so a real Rush Cloud failure isn't silently
    // consumed; markCloudFailedPending surfaces those as a banner instead.
    const cloudMatch = tasks.find((task) =>
      task.agents.some((a) =>
        a.agent_type === p.agentType &&
        a.status !== 'failed' &&
        a.started_at &&
        new Date(a.started_at).getTime() >= p.createdAt - matchSlackMs
      )
    )
    if (cloudMatch || termMatch) consumed.add(p.id)
  }
  if (consumed.size === 0) return pending
  return pending.filter((p) => !consumed.has(p.id))
}

/**
 * Surface a Rush Cloud `failed` execution as a timeout banner immediately,
 * without waiting for the 180s TTL. The match is conservative: agent type,
 * target=cloud, and the failed run's `started_at` must fall within the
 * dispatch's slack window — otherwise an unrelated earlier `failed`
 * execution could prematurely poison a healthy dispatch. Returns the same
 * reference when nothing transitioned so React can bail out.
 */
export function markCloudFailedPending(
  pending: PendingDispatch[],
  tasks: TaskSummary[],
  matchSlackMs = 1000,
): PendingDispatch[] {
  if (pending.length === 0) return pending
  let changed = false
  const next = pending.map((p) => {
    if (p.target !== 'cloud') return p
    if ((p.status ?? 'pending') !== 'pending') return p
    const failedMatch = tasks.find((task) =>
      task.agents.some((a) =>
        a.agent_type === p.agentType &&
        a.status === 'failed' &&
        a.started_at &&
        new Date(a.started_at).getTime() >= p.createdAt - matchSlackMs
      )
    )
    if (!failedMatch) return p
    changed = true
    return { ...p, status: 'timedOut' as const }
  })
  return changed ? next : pending
}

/**
 * Flip entries past `ttlMs` from `pending` to `timedOut` instead of
 * dropping them. Keeps the warning visible so the user knows the
 * dispatch didn't materialize (e.g. Rush Cloud never allocated a pod).
 * Already-`timedOut` entries pass through unchanged. Returns the same
 * reference when no transitions occurred so React can bail out cheaply.
 */
export function markTimedOutPending(
  pending: PendingDispatch[],
  now: number,
  ttlMs = PENDING_DISPATCH_TTL_MS,
): PendingDispatch[] {
  if (pending.length === 0) return pending
  let changed = false
  const next = pending.map((p) => {
    const status = p.status ?? 'pending'
    if (status === 'pending' && now - p.createdAt >= ttlMs) {
      changed = true
      return { ...p, status: 'timedOut' as const }
    }
    return p
  })
  return changed ? next : pending
}

/**
 * Fully remove entries once their retention window has elapsed. A
 * `timedOut` entry stays visible for `ttlMs + retentionMs` total, so
 * the user has time to notice the warning and dispatch again (or
 * dismiss manually). Same-reference short-circuit for React.
 */
export function pruneExpiredPending(
  pending: PendingDispatch[],
  now: number,
  ttlMs = PENDING_DISPATCH_TTL_MS,
  retentionMs = TIMED_OUT_RETENTION_MS,
): PendingDispatch[] {
  if (pending.length === 0) return pending
  const cutoff = ttlMs + retentionMs
  const next = pending.filter((p) => now - p.createdAt < cutoff)
  return next.length === pending.length ? pending : next
}

export function filterDispatchedTaskIds<T extends { id: string }>(
  tasks: T[],
  pendingTaskIds: Set<string>
): T[] {
  if (pendingTaskIds.size === 0) return tasks
  return tasks.filter((t) => !pendingTaskIds.has(t.id))
}

export function optimisticActivityLabel(p: PendingDispatch): string {
  const label = p.taskIdentifier || p.title.slice(0, 40)
  const suffix = p.targetRepo ? ` -> ${p.targetRepo}` : ''
  if ((p.status ?? 'pending') === 'timedOut') {
    if (p.target === 'cloud') return `Dispatch timed out — check Rush Cloud terminal (${label}${suffix})`
    if (p.target === 'device') {
      return `Dispatch timed out — check ${p.deviceName ?? 'device'} over SSH (${label})`
    }
    return `Dispatch timed out — check terminal (${label})`
  }
  if (p.target === 'cloud') return `Queuing on Rush Cloud... (${label}${suffix})`
  if (p.target === 'device') return `Starting on ${p.deviceName ?? 'device'}... (${label})`
  return `Starting... (${label})`
}

export type CloudProvider = 'rush' | 'codex' | 'factory'

/**
 * Build the shell command we send to the Rush Cloud terminal for a cloud
 * dispatch. 'rush' routes through `rush cloud run` (legacy, Rush-specific).
 * Any other provider routes through the cloud-agnostic `agents cloud run
 * --provider X` so Codex/Factory get the same repo-picker UX.
 *
 * `safePrompt` must already be escaped for single-quote embedding by the
 * caller (`prompt.replace(/'/g, "'\\''")`). The repos list is joined with
 * repeatable `--repo` flags.
 */
export function buildCloudDispatchCommand(input: {
  provider: CloudProvider
  agentType: string
  repos: string[]
  safePrompt: string
}): string {
  const repoFlags = input.repos.map((r) => `--repo ${r}`).join(' ')
  if (input.provider === 'rush') {
    return `rush cloud run ${input.agentType} ${repoFlags} -p '${input.safePrompt}'`
  }
  return `agents cloud run --provider ${input.provider} --agent ${input.agentType} ${repoFlags} -p '${input.safePrompt}'`
}

/**
 * True when the task identifier looks like a Linear ticket (e.g. `RUSH-461`).
 * Used to decide whether a cloud dispatch may silently fall back to the
 * current workspace repo. Linear tasks get no fallback because the workspace
 * (e.g. `muqsitnawaz/swarmify`) is often a different codebase than the one
 * the ticket is actually about — we'd rather pop a picker than dispatch to
 * the wrong repo.
 */
export function isLinearSourcedTask(identifier: string | null | undefined): boolean {
  if (typeof identifier !== 'string') return false
  return /^[A-Z][A-Z0-9]*-\d+$/.test(identifier.trim())
}

/**
 * Parse `repo:<name>` labels into fully-qualified `owner/name` repo strings.
 * Returns all matches (a task can be tagged for multiple repos).
 * Returns [] if the owner is unknown or no repo labels exist.
 */
export function resolveReposFromLabels(
  labels: string[] | undefined,
  owner: string | null | undefined,
): string[] {
  if (!labels || labels.length === 0) return []
  if (!owner || !owner.trim()) return []
  const cleanOwner = owner.trim()
  const repos: string[] = []
  const seen = new Set<string>()
  for (const raw of labels) {
    if (typeof raw !== 'string') continue
    const match = raw.trim().match(/^repo:([A-Za-z0-9._-]+)$/)
    if (!match) continue
    const name = match[1]
    const full = `${cleanOwner}/${name}`
    if (seen.has(full)) continue
    seen.add(full)
    repos.push(full)
  }
  return repos
}
