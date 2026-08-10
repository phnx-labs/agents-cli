import React, { useEffect, useState, useCallback } from 'react'
import { ArrowUp, ArrowDown, RefreshCw } from 'lucide-react'
import { SectionHeader } from './common'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { postMessage } from '../hooks'

export type DispatchProvider = 'rush' | 'codex' | 'factory' | 'local'

export interface FactoryConfig {
  cloud_priority: DispatchProvider[]
  auto_detect_repo: boolean
  default_planner_agent: 'claude' | 'codex' | 'gemini' | 'antigravity' | 'grok' | 'kimi' | 'droid' | 'cursor' | 'opencode'
  supervisor_interval_seconds: number
}

const ALL_PROVIDERS: DispatchProvider[] = ['rush', 'codex', 'factory', 'local']
const ALL_AGENTS: FactoryConfig['default_planner_agent'][] = ['claude', 'codex', 'gemini', 'antigravity', 'grok', 'kimi', 'droid', 'cursor', 'opencode']

const PROVIDER_LABEL: Record<DispatchProvider, string> = {
  rush: 'Rush Cloud',
  codex: 'Codex Cloud',
  factory: 'Factory.ai',
  local: 'Local machine',
}

const PROVIDER_BLURB: Record<DispatchProvider, string> = {
  rush: 'Your agents run in Rush pods. Best for real work — sandboxed, durable, opens PRs.',
  codex: 'OpenAI Codex Cloud. Cheaper per-run; good for batch code changes.',
  factory: 'Factory.ai (Droid). Alternate cloud provider.',
  local: 'Spawn teammate CLIs on this machine. Fast iteration, no network hop, constrained by your laptop.',
}

/**
 * Factory settings section: lets the user set cloud provider priority,
 * default planner agent, repo auto-detection, and supervisor cadence.
 *
 * Reads + writes ~/.agents/factory/config.json via `factoryConfigRead` /
 * `factoryConfigWrite` postMessage events; the extension host handles
 * persistence so the same config is available to the `agents factory` CLI.
 */
export function FactorySection() {
  const [config, setConfig] = useState<FactoryConfig | null>(null)
  const [loading, setLoading] = useState(true)

  // Request current config on mount and whenever the host pushes an update.
  const refresh = useCallback(() => {
    setLoading(true)
    postMessage({ type: 'factoryConfigRead' })
  }, [])

  useEffect(() => {
    refresh()
    const onMessage = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'factoryConfigData' && msg.config) {
        setConfig(msg.config as FactoryConfig)
        setLoading(false)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [refresh])

  const save = useCallback((next: Partial<FactoryConfig>) => {
    if (!config) return
    const merged = { ...config, ...next }
    setConfig(merged) // optimistic
    postMessage({ type: 'factoryConfigWrite', config: next })
  }, [config])

  const movePriority = (index: number, delta: number) => {
    if (!config) return
    const list = [...config.cloud_priority]
    const j = index + delta
    if (j < 0 || j >= list.length) return
    const a = list[index]
    const b = list[j]
    if (a === undefined || b === undefined) return
    list[index] = b
    list[j] = a
    save({ cloud_priority: list })
  }

  const togglePriorityEntry = (provider: DispatchProvider) => {
    if (!config) return
    const list = config.cloud_priority.includes(provider)
      ? config.cloud_priority.filter((p) => p !== provider)
      : [...config.cloud_priority, provider]
    if (list.length === 0) return // must have at least one
    save({ cloud_priority: list })
  }

  if (loading || !config) {
    return (
      <section className="mt-10">
        <SectionHeader>Factory</SectionHeader>
        <div className="text-[12px] text-[var(--muted-foreground)]">Loading factory config…</div>
      </section>
    )
  }

  return (
    <section className="mt-10">
      <SectionHeader>Factory</SectionHeader>
      <p className="text-[12px] text-[var(--muted-foreground)] mb-4">
        Controls how <code>agents factory start</code> dispatches teammates. The first viable provider in
        the priority list wins; Rush needs a GitHub repo (auto-detected from git remote).
      </p>

      {/* Cloud provider priority */}
      <div className="mb-6">
        <div className="text-[12px] font-medium mb-2">Dispatch priority</div>
        <ol className="space-y-1">
          {config.cloud_priority.map((provider, idx) => (
            <li
              key={provider}
              className="flex items-center gap-2 px-3 py-2 rounded border border-[var(--border)] bg-[var(--card)]"
            >
              <span className="text-[11px] text-[var(--muted-foreground)] w-5">{idx + 1}.</span>
              <div className="flex-1">
                <div className="text-[13px] font-medium">{PROVIDER_LABEL[provider]}</div>
                <div className="text-[11px] text-[var(--muted-foreground)]">{PROVIDER_BLURB[provider]}</div>
              </div>
              <button
                type="button"
                className="p-1 hover:bg-[var(--accent)] rounded disabled:opacity-40"
                disabled={idx === 0}
                onClick={() => movePriority(idx, -1)}
                aria-label="Move up"
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                className="p-1 hover:bg-[var(--accent)] rounded disabled:opacity-40"
                disabled={idx === config.cloud_priority.length - 1}
                onClick={() => movePriority(idx, 1)}
                aria-label="Move down"
              >
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                className="text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] px-2"
                onClick={() => togglePriorityEntry(provider)}
                disabled={config.cloud_priority.length === 1}
              >
                remove
              </button>
            </li>
          ))}
        </ol>

        {/* Add back removed providers */}
        <div className="mt-2 flex gap-2 flex-wrap">
          {ALL_PROVIDERS.filter((p) => !config.cloud_priority.includes(p)).map((provider) => (
            <button
              key={provider}
              type="button"
              className="text-[11px] px-2 py-1 rounded border border-dashed border-[var(--border)] hover:bg-[var(--accent)]"
              onClick={() => togglePriorityEntry(provider)}
            >
              + add {PROVIDER_LABEL[provider]}
            </button>
          ))}
        </div>
      </div>

      {/* Default planner agent */}
      <div className="mb-6">
        <div className="text-[12px] font-medium mb-2">Default planner agent</div>
        <div className="flex gap-2">
          {ALL_AGENTS.map((agent) => (
            <button
              key={agent}
              type="button"
              className={`text-[12px] px-3 py-1.5 rounded border ${
                config.default_planner_agent === agent
                  ? 'border-[var(--primary)] bg-[var(--primary)]/10'
                  : 'border-[var(--border)] hover:bg-[var(--accent)]'
              }`}
              onClick={() => save({ default_planner_agent: agent })}
            >
              {agent}
            </button>
          ))}
        </div>
      </div>

      {/* Auto-detect repo */}
      <div className="mb-6 flex items-start gap-3">
        <Checkbox
          id="factory-auto-detect-repo"
          checked={config.auto_detect_repo}
          onCheckedChange={(v: boolean | 'indeterminate') => save({ auto_detect_repo: v === true })}
        />
        <label htmlFor="factory-auto-detect-repo" className="text-[12px]">
          <div className="font-medium">Auto-detect repo from git remote</div>
          <div className="text-[11px] text-[var(--muted-foreground)]">
            When dispatching to Rush, extract <code>owner/repo</code> from <code>git remote get-url origin</code>.
            Turn off if you prefer passing <code>--repo</code> explicitly.
          </div>
        </label>
      </div>

      {/* Supervisor interval */}
      <div className="mb-6">
        <label className="text-[12px] font-medium block mb-1" htmlFor="factory-supervisor-interval">
          Supervisor wave interval (seconds)
        </label>
        <Input
          id="factory-supervisor-interval"
          type="number"
          min={1}
          max={300}
          className="w-24"
          value={config.supervisor_interval_seconds}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10)
            if (Number.isFinite(n) && n >= 1) save({ supervisor_interval_seconds: n })
          }}
        />
        <div className="text-[11px] text-[var(--muted-foreground)] mt-1">
          How often the DAG supervisor checks for ready/new teammates. Lower = snappier, higher = cheaper.
        </div>
      </div>

      <button
        type="button"
        className="text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] inline-flex items-center gap-1"
        onClick={refresh}
      >
        <RefreshCw size={11} />
        refresh from disk
      </button>
    </section>
  )
}
