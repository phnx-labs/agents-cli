import React from 'react'

export interface ResourceViewerSelection {
  uri: string
  name?: string
  mimeType?: string
}

interface ResourceViewerProps {
  selected: ResourceViewerSelection | null
}

export function ResourceViewer({ selected }: ResourceViewerProps) {
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
      <div className="sw-resource-empty">Resource reader wiring pending.</div>
    </section>
  )
}
