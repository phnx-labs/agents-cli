// Single source of truth for mapping a cloud-run's raw status string onto the
// four floor statuses the UI understands. Both hosts — the Electron standalone
// app (app/floorData.ts) and the VS Code extension (src/vscode/swarm.vscode.ts)
// — import this so a given cloud run renders identically regardless of host.
//
// The switch is the UNION of the two tables that previously diverged, matched
// case-insensitively:
//   running   <- running, in_progress, queued, pending, allocating
//   failed    <- failed, error
//   stopped   <- cancelled, canceled, stopped
//   completed <- completed, needs_review (and any unknown status)

export type CloudStatus = 'running' | 'completed' | 'failed' | 'stopped'

export function mapCloudStatus(s: string): CloudStatus {
  switch ((s || '').toLowerCase()) {
    case 'running':
    case 'in_progress':
    case 'queued':
    case 'pending':
    case 'allocating':
      return 'running'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'canceled':
    case 'stopped':
      return 'stopped'
    case 'completed':
    case 'needs_review':
      return 'completed'
    default:
      return 'completed'
  }
}
