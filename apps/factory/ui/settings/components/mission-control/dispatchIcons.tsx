// Inline SVGs for the marks the shared `Icon` set doesn't carry (bell / image /
// file). The prototype renders these as literal emoji (bell / image / file); the
// hard rule is no literal emoji in TSX, so they render as stroked SVG (lucide look).
import React from 'react'
import { useEffect } from 'react'

function Svg({ size = 14, className, children }: {
  size?: number
  className?: string
  children: React.ReactNode
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  )
}

export function Bell({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <Svg size={size} className={className}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </Svg>
  )
}

export function ImageIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <Svg size={size} className={className}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-4.35-4.35a2 2 0 0 0-2.83 0L4 20" />
    </Svg>
  )
}

export function FileIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <Svg size={size} className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </Svg>
  )
}

/** Close the popover/dropdown when a pointer lands outside `ref`. */
export function useClickAway<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  onAway: () => void,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ref, onAway, active])
}
