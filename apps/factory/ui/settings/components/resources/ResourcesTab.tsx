import React, { useState } from 'react'
import { ResourcesList } from './ResourcesList'
import { ResourceViewer, type ResourceViewerSelection } from './ResourceViewer'

export function ResourcesTab() {
  const [selected, setSelected] = useState<ResourceViewerSelection | null>(null)

  return (
    <main className="sw-resources-tab">
      <ResourcesList onSelect={setSelected} />
      <ResourceViewer selected={selected} />
    </main>
  )
}
