export interface DeviceStats {
  host: string
  reachable: boolean
  loadAvg1?: number
  memPercent?: number
  runningAgents?: number
  fetchedAt: number
}

export function parseUptime(out: string): { loadAvg1?: number } {
  const m = out.match(/load averages?:\s*([0-9.]+)/i)
  if (!m) return {}
  const v = parseFloat(m[1])
  if (!Number.isFinite(v)) return {}
  return { loadAvg1: v }
}

export function parseVmStat(out: string): { memPercent?: number } {
  const activeMatch = out.match(/Pages active:\s+([0-9]+)/)
  const wiredMatch = out.match(/Pages wired down:\s+([0-9]+)/)
  const compressedMatch = out.match(/Pages occupied by compressor:\s+([0-9]+)/)
  const freeMatch = out.match(/Pages free:\s+([0-9]+)/)
  if (!activeMatch || !wiredMatch || !compressedMatch || !freeMatch) return {}
  const active = parseInt(activeMatch[1], 10)
  const wired = parseInt(wiredMatch[1], 10)
  const compressed = parseInt(compressedMatch[1], 10)
  const free = parseInt(freeMatch[1], 10)
  const used = active + wired + compressed
  const total = used + free
  if (total <= 0) return {}
  const memPercent = (used / total) * 100
  return { memPercent }
}

export function parseLinuxMemInfo(out: string): { memPercent?: number } {
  const totalMatch = out.match(/^MemTotal:\s+([0-9]+)/im)
  const availableMatch = out.match(/^MemAvailable:\s+([0-9]+)/im)
  if (!totalMatch || !availableMatch) return {}
  const total = parseInt(totalMatch[1], 10)
  const available = parseInt(availableMatch[1], 10)
  if (total <= 0) return {}
  const raw = ((total - available) / total) * 100
  const memPercent = Math.max(0, Math.min(100, raw))
  return { memPercent }
}
