// Pure aggregation of a PR's CI check runs into a single status, used to drive
// self-promotion (a running agent whose PR goes green climbs into Needs You) and
// the CI badge. The impure `gh pr checks` call lives in the vscode layer; this
// parser is pure so it can be unit-tested and reused by any host.

export type CiStatus = 'passed' | 'failed' | 'running' | null

interface GhCheckRow {
  bucket?: string // gh: pass | fail | pending | skipping | cancel
  state?: string // GitHub: SUCCESS | FAILURE | ERROR | PENDING | IN_PROGRESS | QUEUED | ...
}

function classify(row: GhCheckRow): 'pass' | 'fail' | 'pending' | 'skip' {
  const b = (row.bucket || '').toLowerCase()
  if (b === 'fail' || b === 'cancel') return 'fail'
  if (b === 'pending') return 'pending'
  if (b === 'pass') return 'pass'
  if (b === 'skipping') return 'skip'
  const s = (row.state || '').toUpperCase()
  if (s === 'FAILURE' || s === 'ERROR' || s === 'CANCELLED' || s === 'TIMED_OUT') return 'fail'
  if (s === 'PENDING' || s === 'IN_PROGRESS' || s === 'QUEUED' || s === 'WAITING' || s === 'EXPECTED') return 'pending'
  if (s === 'SUCCESS') return 'pass'
  return 'skip'
}

// Aggregate: any failure -> failed; else any pending -> running; else, if at
// least one real (non-skipped) check passed -> passed; otherwise null (no CI to
// speak of, e.g. a PR with no checks or `gh` unavailable).
export function aggregateChecks(rows: GhCheckRow[]): CiStatus {
  let sawPass = false
  let sawPending = false
  for (const row of rows) {
    const c = classify(row)
    if (c === 'fail') return 'failed'
    if (c === 'pending') sawPending = true
    if (c === 'pass') sawPass = true
  }
  if (sawPending) return 'running'
  if (sawPass) return 'passed'
  return null
}

// Parse the stdout of `gh pr checks <pr> --json bucket,state`. Returns null on
// any parse failure or empty output so a bad/absent gh result never fabricates a
// status.
export function parseGhChecks(stdout: string): CiStatus {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    const data = JSON.parse(trimmed)
    if (!Array.isArray(data)) return null
    return aggregateChecks(data as GhCheckRow[])
  } catch {
    return null
  }
}
