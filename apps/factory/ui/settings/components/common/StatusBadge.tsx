import React from 'react'

type BadgeVariant = 'success' | 'warning' | 'error' | 'neutral' | 'primary'

interface StatusBadgeProps {
  children: React.ReactNode
  variant?: BadgeVariant
  className?: string
}

const variantStyles: Record<BadgeVariant, string> = {
  success: 'bg-green-500/10 text-green-600 dark:bg-green-500/20 dark:text-green-400',
  warning: 'bg-yellow-500/10 text-yellow-600 dark:bg-yellow-500/20 dark:text-yellow-400',
  error: 'bg-red-500/10 text-red-600 dark:bg-red-500/20 dark:text-red-400',
  neutral: 'bg-[var(--secondary)] text-[var(--muted-foreground)]',
  primary: 'bg-[var(--primary)] text-[var(--primary-foreground)]',
}

/**
 * Consistent status badge styling used throughout the settings UI
 */
export function StatusBadge({ children, variant = 'neutral', className = '' }: StatusBadgeProps) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs ${variantStyles[variant]} ${className}`}>
      {children}
    </span>
  )
}

/**
 * Helper to determine badge variant from boolean status
 */
export function getStatusVariant(isActive: boolean): BadgeVariant {
  return isActive ? 'success' : 'neutral'
}
