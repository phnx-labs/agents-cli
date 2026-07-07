import React from 'react'
import { postMessage } from '../../hooks'

type ExtLinkProps = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'target' | 'rel'> & {
  href: string
}

/**
 * Anchor that opens URLs via the extension host's `openExternal` handler
 * instead of relying on `target="_blank"`. VS Code webviews drop anchor
 * clicks inconsistently — especially when the anchor is nested inside a
 * button — so every external link in the webview must route through
 * `vscode.env.openExternal` via postMessage.
 *
 * Drop-in replacement for `<a ... target="_blank">`. Extra props (className,
 * style, onMouseDown, etc.) pass through. The `onClick` prop, if supplied,
 * runs BEFORE the postMessage and can call `e.preventDefault()` to cancel.
 */
export function ExtLink({ href, onClick, children, ...rest }: ExtLinkProps) {
  return (
    <a
      {...rest}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        onClick?.(e)
        if (e.defaultPrevented) return
        e.preventDefault()
        e.stopPropagation()
        if (href) postMessage({ type: 'openExternal', url: href })
      }}
    >
      {children}
    </a>
  )
}
