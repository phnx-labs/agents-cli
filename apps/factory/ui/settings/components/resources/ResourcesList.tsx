import React, { useState } from 'react'
import type { ResourceViewerSelection } from './ResourceViewer'

interface ResourcesListProps {
  onSelect: (resource: ResourceViewerSelection) => void
}

const SKELETON_RESOURCES: ResourceViewerSelection[] = []

export function ResourcesList({ onSelect }: ResourcesListProps) {
  const [resources] = useState(SKELETON_RESOURCES)

  return (
    <section className="sw-resources-list">
      <div className="sw-resources-list-head">
        <span>MCP Resources</span>
        <button type="button" className="sw-resource-refresh" disabled>
          Refresh
        </button>
      </div>
      {resources.length === 0 ? (
        <div className="sw-resource-empty">Connect an MCP server to browse resources.</div>
      ) : (
        <div className="sw-resource-items">
          {resources.map((resource) => (
            <button key={resource.uri} type="button" className="sw-resource-row" onClick={() => onSelect(resource)}>
              <span>{resource.name || resource.uri}</span>
              {resource.mimeType && <span>{resource.mimeType}</span>}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
