// Named filter-slices over the stream; pure upsert/remove/match + localStorage.
import type { AgentAbbr, FloorSort } from './floorModel'
import type { StatusChip } from './FloorControls'

export interface SavedView {
  name: string
  sort: FloorSort
  status: StatusChip[]
  abbrs: AgentAbbr[]
  search: string
}

const STORAGE_KEY = 'swarm.floor.savedViews'

// Upsert by name (case-sensitive, trimmed): replacing a same-named view rather
// than duplicating it. Order is stable — an update keeps the view's slot, a new
// view appends.
export function upsertView(views: SavedView[], view: SavedView): SavedView[] {
  const name = view.name.trim()
  if (!name) return views
  const next = { ...view, name }
  const idx = views.findIndex((v) => v.name === name)
  if (idx === -1) return [...views, next]
  const copy = views.slice()
  copy[idx] = next
  return copy
}

export function removeView(views: SavedView[], name: string): SavedView[] {
  return views.filter((v) => v.name !== name)
}

// Does a saved view match the current filter state? Drives the active-chip
// highlight. Order-insensitive for the chip arrays.
export function viewMatches(view: SavedView, cur: Omit<SavedView, 'name'>): boolean {
  const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')
  return view.sort === cur.sort && view.search === cur.search && sameSet(view.status, cur.status) && sameSet(view.abbrs, cur.abbrs)
}

export function loadSavedViews(): SavedView[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const data = JSON.parse(raw)
    return Array.isArray(data) ? (data as SavedView[]) : []
  } catch {
    return []
  }
}

export function persistSavedViews(views: SavedView[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(views))
  } catch {
    // storage full / unavailable — saved views are a convenience, not critical
  }
}
