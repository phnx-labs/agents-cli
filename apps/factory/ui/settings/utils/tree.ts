import type { ContextFile } from '../types'

/**
 * Tree node structure for context file tree
 */
export interface TreeNode {
  name: string
  fullPath: string
  files: ContextFile[]
  children: Map<string, TreeNode>
}

/**
 * Build a symlink map from context files
 * Returns a map of target paths to their symlink files
 */
export function buildSymlinkMap(files: ContextFile[]): {
  symlinksByTarget: Record<string, ContextFile[]>
  sourceFiles: ContextFile[]
} {
  const symlinksByTarget: Record<string, ContextFile[]> = {}
  const sourceFiles: ContextFile[] = []

  files.forEach(file => {
    if (file.isSymlink && file.symlinkTarget && file.symlinkTarget !== '(broken)') {
      if (!symlinksByTarget[file.symlinkTarget]) {
        symlinksByTarget[file.symlinkTarget] = []
      }
      symlinksByTarget[file.symlinkTarget].push(file)
    } else {
      sourceFiles.push(file)
    }
  })

  return { symlinksByTarget, sourceFiles }
}

/**
 * Build a tree structure from source files
 */
export function buildFileTree(sourceFiles: ContextFile[]): TreeNode {
  const root: TreeNode = { name: '', fullPath: '', files: [], children: new Map() }

  sourceFiles.forEach(file => {
    const parts = file.path.split('/')
    parts.pop() // Remove filename
    let current = root
    let pathSoFar = ''

    for (const part of parts) {
      pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          fullPath: pathSoFar,
          files: [],
          children: new Map()
        })
      }
      current = current.children.get(part)!
    }
    current.files.push(file)
  })

  return root
}

/**
 * Collapse single-child chains in a tree
 * Dirs with only one subdir and no files get merged
 */
export function collapseTree(node: TreeNode): TreeNode {
  // First collapse all children
  const collapsedChildren = new Map<string, TreeNode>()
  node.children.forEach((child, key) => {
    collapsedChildren.set(key, collapseTree(child))
  })
  node.children = collapsedChildren

  // If this node has exactly one child and no files, merge with child
  if (node.children.size === 1 && node.files.length === 0) {
    const [, child] = [...node.children.entries()][0]
    return {
      name: node.name ? `${node.name}/${child.name}` : child.name,
      fullPath: child.fullPath,
      files: child.files,
      children: child.children
    }
  }

  return node
}

/**
 * Build and collapse a file tree from context files
 * Convenience function combining buildFileTree and collapseTree
 */
export function buildCollapsedFileTree(contextFiles: ContextFile[]): {
  tree: TreeNode
  symlinksByTarget: Record<string, ContextFile[]>
} {
  const { symlinksByTarget, sourceFiles } = buildSymlinkMap(contextFiles)
  const tree = collapseTree(buildFileTree(sourceFiles))
  return { tree, symlinksByTarget }
}
