import { useState, useEffect } from 'react'

/**
 * Hook to detect system theme (light/dark)
 * @returns true if light theme, false if dark theme
 */
export function useSystemTheme(): boolean {
  const [isLight, setIsLight] = useState(() => {
    return !window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setIsLight(!e.matches)
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [])

  return isLight
}
