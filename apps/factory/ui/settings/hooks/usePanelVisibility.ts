import { useState, useEffect } from 'react'

// Tracks whether the dashboard webview panel is currently visible. The
// extension host posts { type: 'panelVisibility', visible } whenever the
// panel's view state changes (tab hidden behind another in the same column,
// editor group collapsed, etc.). Defaults to true because the webview only
// runs JS while it is at least mounted.
export function usePanelVisibility(): boolean {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'panelVisibility' && typeof msg.visible === 'boolean') {
        setVisible(msg.visible)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])
  return visible
}
