import React from 'react'

export interface ResourceViewerSelection {
  serverName: string
  uri: string
  name?: string
  mimeType?: string
}

export type ResourceContent =
  | { uri: string; text: string; mimeType?: string }
  | { uri: string; blob: string; mimeType?: string }

interface ResourceViewerProps {
  selected: ResourceViewerSelection | null
  contents: ResourceContent[] | null
  loading: boolean
  error: string | null
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function blobBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding)
}

export function ResourceContentBlock({ content }: { content: ResourceContent }) {
  const mimeType = content.mimeType || 'application/octet-stream'
  if ('text' in content) {
    const display = mimeType.includes('json') ? prettyJson(content.text) : content.text
    return <pre className="sw-resource-pre">{display}</pre>
  }
  if (mimeType.startsWith('image/')) {
    return <img className="sw-resource-image" src={`data:${mimeType};base64,${content.blob}`} alt={content.uri} />
  }
  return <div className="sw-resource-binary">Binary {blobBytes(content.blob)} bytes</div>
}

export function ResourceViewer({ selected, contents, loading, error }: ResourceViewerProps) {
  if (!selected) {
    return (
      <section className="sw-resource-viewer">
        <div className="sw-resource-empty">Select a resource to inspect its content.</div>
      </section>
    )
  }

  return (
    <section className="sw-resource-viewer">
      <div className="sw-resource-viewer-head">
        <div className="sw-resource-title">{selected.name || selected.uri}</div>
        {selected.mimeType && <span className="sw-resource-mime">{selected.mimeType}</span>}
      </div>
      {loading ? (
        <div className="sw-resource-empty">Reading resource...</div>
      ) : error ? (
        <div className="sw-resource-error">{error}</div>
      ) : contents && contents.length > 0 ? (
        <div className="sw-resource-content">
          {contents.map((content, index) => (
            <ResourceContentBlock key={`${content.uri}-${index}`} content={content} />
          ))}
        </div>
      ) : (
        <div className="sw-resource-empty">No content returned.</div>
      )}
    </section>
  )
}
