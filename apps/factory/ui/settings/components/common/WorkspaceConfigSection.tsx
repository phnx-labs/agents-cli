import React from 'react'
import { WorkspaceConfig } from '../../types'
import { Button } from '../ui/button'

interface WorkspaceConfigSectionProps {
  workspaceConfig: WorkspaceConfig | null
  workspaceConfigLoaded: boolean
  workspaceConfigExists: boolean
  emptyMessage: string
  emptySecondaryMessage?: string
  onInitWorkspaceConfig: () => void
  onSaveWorkspaceConfig: (config: WorkspaceConfig) => void
}

export function WorkspaceConfigSection({
  workspaceConfig,
  workspaceConfigLoaded,
  workspaceConfigExists,
  emptyMessage,
  emptySecondaryMessage,
  onInitWorkspaceConfig,
  onSaveWorkspaceConfig,
}: WorkspaceConfigSectionProps) {
  return (
    <div className="rounded-xl bg-[var(--muted)]">
      {workspaceConfigLoaded && !workspaceConfigExists ? (
        <div className="p-4">
          <p className="text-sm text-[var(--muted-foreground)] mb-3">
            {emptyMessage}
          </p>
          {emptySecondaryMessage && (
            <p className="text-xs text-[var(--muted-foreground)] mb-3">
              {emptySecondaryMessage}
            </p>
          )}
          <Button size="sm" onClick={onInitWorkspaceConfig}>
            Initialize Config
          </Button>
        </div>
      ) : workspaceConfig ? (
        <div className="p-4 space-y-4">
          <div className="space-y-3">
            <div className="text-xs text-[var(--muted-foreground)] uppercase tracking-wider">
              Context Mappings
            </div>
            {workspaceConfig.context.map((mapping, idx) => (
              <div key={idx} className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs bg-[var(--background)] px-2 py-1 rounded">
                  {mapping.source}
                </span>
                <span className="text-[var(--muted-foreground)]">-&gt;</span>
                <span className="text-xs text-[var(--muted-foreground)]">
                  {mapping.aliases.join(', ') || 'no aliases'}
                </span>
                <button
                  className="ml-auto text-[var(--muted-foreground)] hover:text-[var(--foreground)] text-xs"
                  onClick={() => {
                    const newContext = workspaceConfig.context.filter((_, i) => i !== idx)
                    onSaveWorkspaceConfig({ ...workspaceConfig, context: newContext })
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              className="text-xs text-[var(--primary)] hover:underline"
              onClick={() => {
                const source = prompt('Source file:', 'AGENTS.md')
                if (!source) return
                const aliasesStr = prompt('Aliases (comma-separated):', 'CLAUDE.md, GEMINI.md')
                if (aliasesStr === null) return
                const aliases = aliasesStr.split(',').map(s => s.trim()).filter(Boolean)
                const newContext = [...workspaceConfig.context, { source, aliases }]
                onSaveWorkspaceConfig({ ...workspaceConfig, context: newContext })
              }}
            >
              + Add mapping
            </button>
          </div>
        </div>
      ) : (
        <div className="p-4 text-sm text-[var(--muted-foreground)]">
          Loading workspace config...
        </div>
      )}
    </div>
  )
}
