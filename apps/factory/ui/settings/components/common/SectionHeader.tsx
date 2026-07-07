import React from 'react'

interface SectionHeaderProps {
  children: React.ReactNode
  className?: string
}

/**
 * Consistent section header styling used throughout the settings UI
 */
export function SectionHeader({ children, className = '' }: SectionHeaderProps) {
  return (
    <h2 className={`text-[11px] font-medium uppercase tracking-wider text-[var(--muted-foreground)] mb-4 ${className}`}>
      {children}
    </h2>
  )
}
