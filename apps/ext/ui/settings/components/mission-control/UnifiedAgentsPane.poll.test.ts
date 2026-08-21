import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof globalThis.document === 'undefined') GlobalRegistrator.register()

import { expect, test, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TerminalDetail } from '../../types'
import { REMOTE_STALE_MS, THROUGHPUT_TICK_MS } from './floorRefresh'

const { UnifiedAgentsPane } = await import('./UnifiedAgentsPane')

// Source-level regression guards: the Floor must not reintroduce 3s local /
// 45s remote setInterval polls or the 140ms throughput React timer.
// (issue #2030 / factory-floor performance UI track)

const panePath = join(import.meta.dir, 'UnifiedAgentsPane.tsx')
const cssPath = join(import.meta.dir, 'design-system.css')
const source = readFileSync(panePath, 'utf8')
const css = readFileSync(cssPath, 'utf8')

describe('Floor poll / timer budget (no recurring probes)', () => {
  test('exports 1s throughput tick and a non-poll stale threshold', () => {
    expect(THROUGHPUT_TICK_MS).toBe(1_000)
    expect(REMOTE_STALE_MS).toBe(90_000)
  })

  test('does not define the old 3s local / 45s remote poll constants', () => {
    expect(source).not.toMatch(/LOCAL_POLL_MS\s*=\s*3_?000/)
    expect(source).not.toMatch(/REMOTE_POLL_MS\s*=\s*45_?000/)
    expect(source).not.toContain('setInterval(poll, LOCAL_POLL_MS)')
    expect(source).not.toContain('setInterval(sweep, REMOTE_POLL_MS)')
  })

  test('does not run a 140ms React throughput timer', () => {
    expect(source).not.toMatch(/setInterval\(\s*tick\s*,\s*140\s*\)/)
    expect(source).toContain('setInterval(tick, THROUGHPUT_TICK_MS)')
    expect(source).toContain('data-tick-ms={THROUGHPUT_TICK_MS}')
  })

  test('seeds hosts once on visibility; remote refresh is manual', () => {
    expect(source).toContain("postMessage({ type: 'fetchLocalSessions' })")
    expect(source).toContain('data-testid="host-freshness-chip"')
    // One-shot seed on panelVisible — no setInterval around fetchHostSessions.
    expect(source).toMatch(/if \(!panelVisible\) return[\s\S]*?fetchLocalSessions[\s\S]*?fetchHostSessions/)
  })

  test('mount seed is cache-only; freshness chip passes force:true', () => {
    // panelVisible one-shot seed must omit force so the host serves last-good
    // without a fleet CLI fan-out (PR #2031 / #2033 seam).
    const mountSeed = source.match(
      /if \(!panelVisible\) return[\s\S]*?postMessage\(\{\s*type:\s*'fetchLocalSessions'\s*\}\)[\s\S]*?postMessage\(\{\s*type:\s*'fetchHostSessions'\s*\}\)/,
    )
    expect(mountSeed).not.toBeNull()
    expect(mountSeed![0]).not.toMatch(/force\s*:/)

    // Manual freshness chip is the only path that may force a fleet refresh.
    // onClick sits above data-testid on the same span (JSX attribute order).
    expect(source).toMatch(
      /onClick=\{\(\) => \{ if \(!syncingHosts\) \{[\s\S]*?postMessage\(\{\s*type:\s*'fetchHostSessions',\s*force:\s*true\s*\}\)[\s\S]*?\}\s*\}\}[\s\S]*?data-testid="host-freshness-chip"/,
    )
    // Exactly one forced fetchHostSessions in the pane source.
    const forced = source.match(/postMessage\(\{\s*type:\s*'fetchHostSessions',\s*force:\s*true\s*\}\)/g)
    expect(forced?.length).toBe(1)
  })

  test('retains last-good remote rows on hostSessions failure', () => {
    expect(source).toContain("msg.ok === false || typeof msg.error === 'string'")
    expect(source).toContain('Retain last-good sessions/roster')
    expect(source).toContain('setRemoteSyncError')
  })

  test('CSS interpolates sparkline bars and honors prefers-reduced-motion', () => {
    expect(css).toMatch(/\.sw-spark-bar[\s\S]*?transition:\s*height\s+0\.9s/)
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*?\.sw-spark-bar[\s\S]*?transition:\s*none/)
  })

  test('empty / CLI-unavailable copy and per-host freshness are present', () => {
    expect(source).toContain('data-testid="zero-sessions"')
    expect(source).toContain('data-testid="zero-hosts"')
    expect(source).toContain('data-testid="cli-unavailable"')
    expect(source).toContain('data-testid="per-host-freshness"')
  })

  test('managedProjectsData.error retains last-good projects', () => {
    // Failure path surfaces error and returns before setManagedProjects.
    expect(source).toMatch(
      /msg\?\.type === 'managedProjectsData'[\s\S]*?typeof msg\.error === 'string'[\s\S]*?setProjectCommandError\(msg\.error\)[\s\S]*?return/,
    )
    expect(source).toContain('Retain last-good projects')
    // Success path still replaces projects and clears the error.
    expect(source).toMatch(
      /Array\.isArray\(msg\.projects\)[\s\S]*?setManagedProjects\(msg\.projects as ManagedProject\[\]\)[\s\S]*?setProjectCommandError\(null\)/,
    )
  })
})

test('renders a single waiting question through the pane question-cluster path', () => {
  const now = Date.now()
  const terminal: TerminalDetail = {
    id: 'terminal-1',
    agentType: 'claude',
    label: 'migration-agent',
    autoLabel: null,
    createdAt: now - 60_000,
    index: 0,
    sessionId: 'session-1',
    firstUserMessage: 'Choose the migration strategy',
    status: 'running',
    lastActivityTimestamp: new Date(now).toISOString(),
    currentActivity: 'Waiting for a migration decision',
    waitingForInput: true,
    recentToolCalls: [{
      name: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Drop the old table?',
          header: 'Migration',
          options: [
            { label: 'Drop it', description: 'Remove the legacy table' },
            { label: 'Keep it', description: 'Preserve the legacy table' },
          ],
        }],
      },
    }],
  }

  const html = renderToStaticMarkup(React.createElement(UnifiedAgentsPane, {
    terminals: [terminal],
    tasks: [],
    tasksLoading: false,
    unifiedTasks: [],
    unifiedTasksLoading: false,
    onDispatch: () => {},
    search: '',
    onSearch: () => {},
  }))

  expect(html).toContain('Drop the old table?')
  expect(html).toContain('Drop it')
  expect(html).toContain('Keep it')
})
