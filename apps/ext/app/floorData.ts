// Portable floor-data provider for the standalone Electron host. Reads the same
// agent state the extension does — ~/.agents/{teams,swarm}/agents/*/meta.json and
// the Prix cloud-runs API — and shapes it into the TaskSummary[] the floor UI
// consumes. No VS Code dependency: pure fs + fetch, so it runs in the Electron
// main process. (Kept lean and app-local for now; unifying it with the
// extension's fetchTasks behind one shared provider is a follow-up.)

import * as os from 'os'
import * as path from 'path'
import { promises as fsp } from 'fs'
import { mapCloudStatus } from '../src/core/cloudStatus'

const TEAMS_DIR = path.join(os.homedir(), '.agents', 'teams', 'agents')
const SWARM_DIR = path.join(os.homedir(), '.agents', 'swarm', 'agents')
const RUSH_USER_YAML = path.join(os.homedir(), '.rush', 'user.yaml')
const PRIX_API_URL = 'https://api.prix.dev'

interface AgentMetaLike {
  agent_id?: string
  agent_type?: string
  status?: string
  started_at?: string
  completed_at?: string | null
  prompt?: string
  cwd?: string | null
  mode?: string
  task_name?: string
  cloud_session_id?: string | null
  cloud_provider?: string | null
  pr_url?: string | null
  name?: string | null
  task_type?: string | null
  after?: string[]
}

function emptyDetail(meta: AgentMetaLike, fallbackId: string) {
  return {
    agent_id: meta.agent_id ?? fallbackId,
    agent_type: meta.agent_type ?? 'claude',
    status: meta.status ?? 'idle',
    duration: null as string | null,
    started_at: meta.started_at ?? new Date().toISOString(),
    completed_at: meta.completed_at ?? null,
    prompt: (meta.prompt ?? '').slice(0, 150),
    cwd: meta.cwd ?? null,
    mode: meta.mode,
    files_created: [] as string[],
    files_modified: [] as string[],
    files_deleted: [] as string[],
    bash_commands: [] as string[],
    last_messages: [] as string[],
    cloud_session_id: meta.cloud_session_id ?? null,
    cloud_provider: meta.cloud_provider ?? null,
    pr_url: meta.pr_url ?? null,
    ci_status: null,
    name: meta.name ?? null,
    task_type: (meta.task_type ?? null) as string | null,
    after: Array.isArray(meta.after) ? meta.after : [],
  }
}

// Pick the most recent ISO timestamp by real chronological order. A lexical
// `.sort()` mis-ranks mixed offsets / missing-`Z` strings, so compare on
// Date.getTime() — matching the VS Code host (swarm.vscode.ts).
export function latestActivity(times: string[]): string {
  let best: string | null = null
  let bestMs = -Infinity
  for (const t of times) {
    if (!t) continue
    const ms = new Date(t).getTime()
    if (!Number.isNaN(ms) && ms >= bestMs) {
      bestMs = ms
      best = t
    }
  }
  return best ?? new Date().toISOString()
}

export async function fetchLocalTasks() {
  const byTask = new Map<string, ReturnType<typeof emptyDetail>[]>()
  for (const base of [SWARM_DIR, TEAMS_DIR]) {
    let ids: string[]
    try {
      ids = await fsp.readdir(base)
    } catch {
      continue
    }
    for (const id of ids) {
      try {
        const raw = await fsp.readFile(path.join(base, id, 'meta.json'), 'utf-8')
        const meta = JSON.parse(raw) as AgentMetaLike
        const detail = emptyDetail(meta, id)
        const taskName = meta.task_name ?? detail.agent_id
        const arr = byTask.get(taskName) ?? []
        arr.push(detail)
        byTask.set(taskName, arr)
      } catch {
        // skip unreadable / partial agent dirs
      }
    }
  }
  const tasks = []
  for (const [task_name, agents] of byTask) {
    const status_counts = { running: 0, completed: 0, failed: 0, stopped: 0 }
    for (const a of agents) {
      if ((status_counts as Record<string, number>)[a.status] != null) (status_counts as Record<string, number>)[a.status]++
    }
    const latest = latestActivity(agents.map((a) => a.completed_at || a.started_at))
    tasks.push({ task_name, agent_count: agents.length, status_counts, latest_activity: latest, agents })
  }
  return tasks
}

async function readRushToken(): Promise<string | null> {
  try {
    const raw = await fsp.readFile(RUSH_USER_YAML, 'utf-8')
    const m = raw.match(/access_token:\s*(.+)/)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

export async function fetchCloudTasks() {
  const token = await readRushToken()
  if (!token) return []
  let data: { executions?: Array<Record<string, unknown>> }
  try {
    const resp = await fetch(`${PRIX_API_URL}/api/v1/cloud-runs`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return []
    data = (await resp.json()) as { executions?: Array<Record<string, unknown>> }
  } catch {
    return []
  }
  const execs = data.executions ?? []
  return execs.map((ex) => {
    const status = mapCloudStatus(String(ex.status ?? ''))
    const startedAt = String(ex.created_at ?? new Date().toISOString())
    const summary = (ex.summary as string | undefined) || null
    const detail = {
      agent_id: String(ex.execution_id ?? ''),
      agent_type: String(ex.agent ?? 'claude'),
      status,
      duration: null,
      started_at: startedAt,
      completed_at: status !== 'running' ? String(ex.updated_at ?? '') || null : null,
      prompt: String(ex.prompt ?? ''),
      cwd: null,
      mode: 'cloud',
      files_created: [],
      files_modified: [],
      files_deleted: [],
      bash_commands: [],
      last_messages: summary ? [summary] : [],
      cloud_session_id: String(ex.execution_id ?? ''),
      cloud_provider: 'rush',
      pr_url: (ex.pr_url as string | undefined) ?? null,
      ci_status: null,
      cloud_summary: summary,
      name: null,
      task_type: null,
      after: [],
    }
    return {
      task_name: `cloud:${ex.execution_id}`,
      agent_count: 1,
      status_counts: {
        running: status === 'running' ? 1 : 0,
        completed: status === 'completed' ? 1 : 0,
        failed: status === 'failed' ? 1 : 0,
        stopped: status === 'stopped' ? 1 : 0,
      },
      latest_activity: String(ex.updated_at ?? ex.created_at ?? startedAt),
      agents: [detail],
    }
  })
}

export async function fetchAllFloorTasks() {
  const [local, cloud] = await Promise.all([
    fetchLocalTasks().catch(() => []),
    fetchCloudTasks().catch(() => []),
  ])
  return [...local, ...cloud]
}
