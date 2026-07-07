import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'

export type AgentType = 'claude' | 'gemini' | 'codex' | 'agents' | 'cursor' | 'opencode' | 'unknown'

export interface ContextFile {
  path: string // relative path from workspace root
  agent: AgentType
  preview: string // first ~50 chars of content
  lines: number // total line count
  isSymlink: boolean
  symlinkTarget?: string // if symlink, relative path it points to
}

const MEMORY_FILES = ['CLAUDE.MD', 'GEMINI.MD', 'AGENTS.MD', 'CODEX.MD', 'CURSOR.MD', 'OPENCODE.MD']

function getAgentType(filename: string): AgentType {
  const name = filename.toUpperCase()
  if (name === 'CLAUDE.MD') return 'claude'
  if (name === 'GEMINI.MD') return 'gemini'
  if (name === 'CODEX.MD') return 'codex'
  if (name === 'AGENTS.MD') return 'agents'
  if (name === 'CURSOR.MD') return 'cursor'
  if (name === 'OPENCODE.MD') return 'opencode'
  return 'unknown'
}

function getPreview(content: string): string {
  // Get first non-empty, non-heading line
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) {
      // Truncate to ~50 chars
      return trimmed.length > 50 ? trimmed.slice(0, 47) + '...' : trimmed
    }
  }
  // Fallback to first heading if no content
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) {
      const heading = trimmed.replace(/^#+\s*/, '')
      return heading.length > 50 ? heading.slice(0, 47) + '...' : heading
    }
  }
  return ''
}

async function findMemoryFiles(dir: string, root: string, results: string[]): Promise<void> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      // Skip common directories
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === 'dist' ||
          entry.name === 'out' ||
          entry.name === 'build' ||
          entry.name === '.next' ||
          entry.name === 'coverage' ||
          entry.name === '.turbo' ||
          entry.name === 'vendor'
        ) {
          continue
        }
        await findMemoryFiles(fullPath, root, results)
      } else if (MEMORY_FILES.includes(entry.name.toUpperCase())) {
        results.push(fullPath)
      }
    }
  } catch {
    // Ignore permission errors
  }
}

export async function scanMemoryFiles(workspaceRoot: string): Promise<ContextFile[]> {
  const filePaths: string[] = []
  await findMemoryFiles(workspaceRoot, workspaceRoot, filePaths)

  const files: ContextFile[] = []

  for (const filePath of filePaths) {
    try {
      const relativePath = path.relative(workspaceRoot, filePath)
      const filename = path.basename(filePath)
      const stats = await fs.promises.lstat(filePath)
      const isSymlink = stats.isSymbolicLink()

      let symlinkTarget: string | undefined
      let content = ''
      let lines = 0

      if (isSymlink) {
        try {
          const target = await fs.promises.readlink(filePath)
          // Make target relative to workspace if possible
          const absoluteTarget = path.isAbsolute(target)
            ? target
            : path.resolve(path.dirname(filePath), target)
          symlinkTarget = path.relative(workspaceRoot, absoluteTarget)

          // Try to read the target content
          const targetContent = await fs.promises.readFile(absoluteTarget, 'utf-8')
          content = targetContent
          lines = targetContent.split('\n').length
        } catch {
          // Broken symlink
          symlinkTarget = '(broken)'
        }
      } else {
        content = await fs.promises.readFile(filePath, 'utf-8')
        lines = content.split('\n').length
      }

      files.push({
        path: relativePath,
        agent: getAgentType(filename),
        preview: getPreview(content),
        lines,
        isSymlink,
        symlinkTarget,
      })
    } catch {
      // Skip files we can't read
    }
  }

  // Sort by path (root files first, then alphabetically)
  files.sort((a, b) => {
    const aDepth = a.path.split(path.sep).length
    const bDepth = b.path.split(path.sep).length
    if (aDepth !== bDepth) return aDepth - bDepth
    return a.path.localeCompare(b.path)
  })

  return files
}
