import React from 'react'
import { SectionHeader } from '../common'
import { SHORTCUTS } from './helpers'

export function ShortcutsSection() {
  return (
    <section>
      <SectionHeader>Shortcuts</SectionHeader>
      <div className="grid gap-3 sm:grid-cols-2 text-sm">
        {SHORTCUTS.map(([keys, label]) => (
          <div key={keys} className="flex items-center gap-4">
            <kbd className="px-2 py-1 rounded bg-[var(--muted)] border border-[var(--border)] text-[var(--foreground)] font-mono text-xs min-w-[120px] text-center">
              {keys}
            </kbd>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
