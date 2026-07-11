import type { FloorAgent } from './floorModel'

// Pure model for the PR board. PrStatusLike mirrors src/core/prBoard.ts PrStatus
// across the postMessage boundary; the join back to the agent that owns each PR
// happens here so the board can show who produced the diff and jump to the card.

export interface PrStatusLike {
  url: string
  number: number
  title: string
  state: 'open' | 'merged' | 'closed'
  isDraft: boolean
  ci: 'passed' | 'failed' | 'running' | null
  review: 'approved' | 'changes_requested' | 'review_required' | null
  mergeable: 'mergeable' | 'conflicting' | 'unknown'
  readyToMerge: boolean
}

export interface PrBoardRow extends PrStatusLike {
  /** The live agent that carries this PR, when one still does. */
  owner: FloorAgent | null
}

/** Unique PR URLs across the live feed — the board's fetch set. */
export function collectPrUrls(agents: FloorAgent[]): string[] {
  const urls = new Set<string>()
  for (const a of agents) if (a.prUrl) urls.add(a.prUrl)
  return [...urls]
}

/**
 * Join fetched statuses back onto their owning agents and order the board for
 * action: ready-to-merge first, then failing CI, then changes-requested, then the
 * rest; merged/closed sink to the bottom (they clear on the next fetch).
 */
export function buildPrBoard(statuses: PrStatusLike[], agents: FloorAgent[]): PrBoardRow[] {
  const byUrl = new Map<string, FloorAgent>()
  for (const a of agents) if (a.prUrl) byUrl.set(a.prUrl, a)
  const rank = (s: PrStatusLike): number => {
    if (s.state !== 'open') return 5
    if (s.readyToMerge) return 0
    if (s.ci === 'failed' || s.mergeable === 'conflicting') return 1
    if (s.review === 'changes_requested') return 2
    if (s.ci === 'running') return 3
    return 4
  }
  return statuses
    .map((s) => ({ ...s, owner: byUrl.get(s.url) ?? null }))
    .sort((a, b) => rank(a) - rank(b) || b.number - a.number)
}
