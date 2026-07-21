import React from 'react'
import type { ResourceViewerSelection } from './ResourceViewer'

interface ResourcesListProps {
  resources: ResourceViewerSelection[]
  servers: Array<{ name: string; scope: string; connected: boolean; error?: string }>
  selected: ResourceViewerSelection | null
  loading: boolean
  onSelect: (resource: ResourceViewerSelection) => void
  onRefresh: () => void
}

export function ResourcesList({ resources, servers, selected, loading, onSelect, onRefresh }: ResourcesListProps) {
  const hasDisconnected = servers.some((server) => !server.connected)

  return (
    <section className="sw-resources-list">
      <div className="sw-resources-list-head">
        <span>MCP Resources</span>
        <button type="button" className="sw-resource-refresh" disabled={loading} onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {loading ? (
        <div className="sw-resource-empty">Loading MCP resources...</div>
      ) : resources.length === 0 ? (
        <div className="sw-resource-empty">Connect an MCP server to browse resources.</div>
      ) : (
        <div className="sw-resource-items">
          {resources.map((resource) => (
            <button
              key={`${resource.serverName}:${resource.uri}`}
              type="button"
              className={`sw-resource-row ${selected?.serverName === resource.serverName && selected?.uri === resource.uri ? 'active' : ''}`}
              onClick={() => onSelect(resource)}
            >
              <span className="sw-resource-row-name">{resource.name || resource.uri}</span>
              <span className="sw-resource-row-meta">{resource.serverName}{resource.mimeType ? ` - ${resource.mimeType}` : ''}</span>
            </button>
          ))}
        </div>
      )}
      {hasDisconnected && (
        <div className="sw-resource-reconnect">
          Reconnect the failed MCP server, then refresh this tab.
        </div>
      )}
    </section>
  )
}
