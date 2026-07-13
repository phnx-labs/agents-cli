export type PlanFileKind = 'html' | 'markdown'
export type PlanFileSource = 'output' | 'worktree' | 'attachment'

export interface PlanFile {
  path: string
  label: string
  kind: PlanFileKind
  source: PlanFileSource
}

export interface PlanFileCandidate {
  value: string
  source: PlanFileSource
}

const PLAN_TOKEN_RE = /(?:file:\/\/)?(?:~|\.{1,2}\/|\/)?[^\s"'`<>()\[\]{}]*?(?:\.html|ref-[^/\s"'`<>()\[\]{}]*?\.md)(?=$|[\s"'`<>()\[\]{},.;!?])/gi

function trimToken(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`(<\[]+/, '')
    .replace(/[.,;:!?'"`)>\\\]]+$/, '')
}

function basename(path: string): string {
  const clean = path.replace(/^file:\/\//, '')
  return clean.split('/').filter(Boolean).pop() || clean
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(path)
}

function joinPath(base: string, child: string): string {
  const b = base.replace(/\/+$/, '')
  const c = child.replace(/^\.?\//, '')
  return b ? `${b}/${c}` : c
}

function normalizePlanPath(raw: string, basePath?: string | null): string {
  const token = trimToken(raw)
  if (!token) return ''
  if (/^https?:\/\//i.test(token)) return token
  const noScheme = token.startsWith('file://') ? token.slice('file://'.length) : token
  if (isAbsolutePath(noScheme)) return noScheme
  return basePath ? joinPath(basePath, noScheme) : noScheme
}

function kindOf(path: string): PlanFileKind | null {
  const name = basename(path).toLowerCase()
  if (name.endsWith('.html')) return 'html'
  if (/^ref-[^/]+\.md$/.test(name)) return 'markdown'
  return null
}

function toPlanFile(candidate: PlanFileCandidate, basePath?: string | null): PlanFile | null {
  const path = normalizePlanPath(candidate.value, basePath)
  const kind = kindOf(path)
  if (!path || !kind) return null
  return { path, label: basename(path), kind, source: candidate.source }
}

export function extractPlanCandidates(text: string | null | undefined, source: PlanFileSource = 'output'): PlanFileCandidate[] {
  if (!text) return []
  const out: PlanFileCandidate[] = []
  for (const match of text.matchAll(PLAN_TOKEN_RE)) {
    const value = trimToken(match[0] || '')
    if (value) out.push({ value, source })
  }
  return out
}

export function detectPlanFiles(candidates: PlanFileCandidate[], basePath?: string | null): PlanFile[] {
  const out: PlanFile[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const plan = toPlanFile(candidate, basePath)
    if (!plan) continue
    const key = plan.path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(plan)
  }
  return out
}
