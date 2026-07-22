import React, { useEffect, useRef, useState } from 'react'
import { postMessage } from '../../hooks'
import { ResourcesList } from './ResourcesList'
import { ResourceViewer, type ResourceContent, type ResourceViewerSelection } from './ResourceViewer'

type ServerStatus = { name: string; scope: string; connected: boolean; error?: string }

export function ResourcesTab() {
  const [resources, setResources] = useState<ResourceViewerSelection[]>([])
  const [servers, setServers] = useState<ServerStatus[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<ResourceViewerSelection | null>(null)
  const [contents, setContents] = useState<ResourceContent[] | null>(null)
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const selectedRef = useRef<ResourceViewerSelection | null>(null)

  const refresh = () => {
    setLoading(true)
    postMessage({ type: 'fetchMcpResources' })
  }

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data
      if (message?.type === 'mcpResourcesData') {
        setServers(Array.isArray(message.servers) ? message.servers : [])
        const nextResources = Array.isArray(message.resources) ? message.resources : []
        setResources(nextResources)
        const current = selectedRef.current
        if (current && !nextResources.some((item) => item.serverName === current.serverName && item.uri === current.uri)) {
          selectedRef.current = null
          setSelected(null)
          setContents(null)
          setReadError(null)
          setReading(false)
        }
        setLoading(false)
      }
      if (message?.type === 'mcpResourceReadData') {
        const current = selectedRef.current
        if (current && message.serverName === current.serverName && message.uri === current.uri) {
          setContents(Array.isArray(message.contents) ? message.contents : [])
          setReadError(null)
          setReading(false)
        }
      }
      if (message?.type === 'mcpResourceReadError') {
        const current = selectedRef.current
        if (current && message.serverName === current.serverName && message.uri === current.uri) {
          setContents(null)
          setReadError(typeof message.error === 'string' ? message.error : 'Failed to read resource.')
          setReading(false)
        }
      }
    }
    window.addEventListener('message', onMessage)
    refresh()
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const selectResource = (resource: ResourceViewerSelection) => {
    selectedRef.current = resource
    setSelected(resource)
    setContents(null)
    setReadError(null)
    setReading(true)
    postMessage({ type: 'readMcpResource', serverName: resource.serverName, uri: resource.uri })
  }

  return (
    <main className="sw-resources-tab">
      <ResourcesList
        resources={resources}
        servers={servers}
        selected={selected}
        loading={loading}
        onSelect={selectResource}
        onRefresh={refresh}
      />
      <ResourceViewer selected={selected} contents={contents} loading={reading} error={readError} />
    </main>
  )
}
