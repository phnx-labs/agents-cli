import React from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { TODO_MARKDOWN_ALLOWED_TAGS, TODO_MARKDOWN_ALLOWED_ATTRS } from '../constants'
import { postMessage } from '../hooks'

/**
 * Escape HTML special characters
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Create custom renderer for todo markdown
// Note: marked v5+ passes token objects to renderer methods, not separate params
const todoMarkdownRenderer = new marked.Renderer()

todoMarkdownRenderer.link = ({ href, title, text }) => {
  const safeHref = href || '#'
  const safeTitle = title ? ` title="${title}"` : ''
  return `<a href="${safeHref}"${safeTitle} target="_blank" rel="noreferrer">${text}</a>`
}

todoMarkdownRenderer.code = ({ text, lang }) => {
  const language = (lang || '').trim()
  const className = language ? ` class="todo-md-code language-${language}"` : ' class="todo-md-code"'
  return `<pre class="todo-md-pre"><code${className}>${escapeHtml(text)}</code></pre>`
}

// Configure marked options
marked.setOptions({
  gfm: true,
  breaks: true,
  headerIds: false,
  mangle: false,
  renderer: todoMarkdownRenderer
})

/**
 * Render markdown description with sanitization
 * @param desc - The markdown description
 * @param clamp - Whether to clamp the content (default: true)
 * @returns React element with rendered markdown
 */
export function renderTodoDescription(desc: string, clamp: boolean = true): React.ReactElement {
  const raw = marked.parse(desc)
  const safe = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: TODO_MARKDOWN_ALLOWED_TAGS,
    ALLOWED_ATTR: TODO_MARKDOWN_ALLOWED_ATTRS
  })
  const className = clamp ? 'todo-md todo-md-clamp' : 'todo-md'
  // Delegate anchor clicks to the extension host's openExternal handler.
  // Anchors inside dangerouslySetInnerHTML don't get React synthetic click
  // handling, but clicks still bubble to the wrapping div — so we intercept
  // here. VS Code webviews don't reliably honor target="_blank" on raw DOM
  // anchors, so every external link must route through vscode.env.openExternal.
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!anchor) return
    const url = anchor.getAttribute('href')
    if (!url || url.startsWith('#')) return
    e.preventDefault()
    e.stopPropagation()
    postMessage({ type: 'openExternal', url })
  }
  return React.createElement('div', {
    className,
    onClick,
    dangerouslySetInnerHTML: { __html: safe }
  })
}
