import { expect, test, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REMOTE_STALE_MS, THROUGHPUT_TICK_MS } from './floorRefresh'

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
    expect(source).toContain("postMessage({ type: 'fetchHostSessions' })")
    expect(source).toContain("postMessage({ type: 'fetchLocalSessions' })")
    expect(source).toContain('data-testid="host-freshness-chip"')
    // One-shot seed on panelVisible — no setInterval around fetchHostSessions.
    expect(source).toMatch(/if \(!panelVisible\) return[\s\S]*?fetchLocalSessions[\s\S]*?fetchHostSessions/)
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
})
