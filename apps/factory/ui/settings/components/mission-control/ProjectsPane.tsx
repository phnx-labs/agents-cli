import React, { useEffect, useState } from 'react'
import { Icon } from './icons'
import type { ManagedProject, LinearProjectLite } from './floorModel'

// Projects management pane. Opens in the detail column when center === 'projects'
// (via the sidebar cog / "+N more" row) — NOT a modal. Mirrors HostDetail's layout:
// a `dhead` header with title + back action, then a `dbody` of labelled sections.
// The webview only renders + edits; the host persists the managed list and answers
// fetchManagedProjects / saveManagedProject / deleteManagedProject / pickProjectFolder
// / fetchLinearProjects over postMessage.

interface ProjectsPaneProps {
  projects: ManagedProject[]
  linearProjects: LinearProjectLite[]
  pickedFolder: { path: string; repoSlug?: string; name: string; suggestedLinear?: LinearProjectLite } | null
  onSave: (p: ManagedProject) => void
  onDelete: (id: string) => void
  onPickFolder: () => void
  onClose: () => void
}

const VIOLET = '#8b8ce8'

/** Truncate a long path in the middle so both the root and the leaf stay visible. */
function truncateMiddle(s: string, max = 42): string {
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}

export function ProjectsPane({ projects, linearProjects, pickedFolder, onSave, onDelete, onPickFolder, onClose }: ProjectsPaneProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [repoSlug, setRepoSlug] = useState('')
  const [linearProjectId, setLinearProjectId] = useState('')

  const resetForm = () => {
    setEditingId(null)
    setPath('')
    setName('')
    setRepoSlug('')
    setLinearProjectId('')
  }

  // A host-picked folder prefills the ADD form: path, name (folder basename), repo
  // slug, and a pre-selected suggested Linear project when the host proposes one.
  useEffect(() => {
    if (!pickedFolder) return
    setEditingId(null)
    setPath(pickedFolder.path)
    setName(pickedFolder.name)
    setRepoSlug(pickedFolder.repoSlug ?? '')
    setLinearProjectId(pickedFolder.suggestedLinear?.id ?? '')
  }, [pickedFolder])

  const startEdit = (p: ManagedProject) => {
    setEditingId(p.id)
    setPath(p.path)
    setName(p.name)
    setRepoSlug(p.repoSlug ?? '')
    setLinearProjectId(p.linearProjectId ?? '')
  }

  const canSave = name.trim().length > 0 && path.trim().length > 0

  const save = () => {
    if (!canSave) return
    const base = editingId ? projects.find((p) => p.id === editingId) ?? null : null
    let id = editingId ?? (repoSlug.trim() || name.trim()).toLowerCase().replace(/\s+/g, '-')
    // New project: never overwrite an existing entry that shares a name/slug (e.g. two
    // manual projects both named "Agents CLI" with no repo slug). Disambiguate with a
    // numeric suffix so upsertManagedProject can't silently drop the first one.
    if (!editingId && projects.some((p) => p.id === id)) {
      const stem = id
      let n = 2
      while (projects.some((p) => p.id === `${stem}-${n}`)) n++
      id = `${stem}-${n}`
    }
    const linear = linearProjects.find((l) => l.id === linearProjectId) ?? null
    onSave({
      id,
      name: name.trim(),
      path: path.trim(),
      repoSlug: repoSlug.trim() || undefined,
      linearProjectId: linear?.id,
      linearProjectName: linear?.name,
      confidence: base?.confidence ?? 'high',
      source: base?.source ?? 'manual',
    })
    resetForm()
  }

  return (
    <>
      <div className="dhead" style={{ justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="title">Projects</span>
          <span className="sub">{projects.length} managed</span>
        </div>
        <button className="host-btn" onClick={onClose}>
          <Icon name="chevL" size={12} /> back to agents
        </button>
      </div>

      <div className="dbody">
        {/* Managed list */}
        <div>
          <div className="lbl">Managed projects</div>
          {projects.length === 0 ? (
            <div className="host-dim">No managed projects yet. Add one below.</div>
          ) : (
            projects.map((p) => (
              <div
                key={p.id}
                className="dispatch-panel"
                style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{p.name}</span>
                    {p.linearProjectId ? (
                      <span className="host-cap" style={{ color: VIOLET, borderColor: VIOLET }}>
                        {p.linearProjectName ?? 'Linear'}
                      </span>
                    ) : (
                      <span className="host-dim">no link</span>
                    )}
                  </div>
                  <div className="mono" style={{ color: 'var(--ds-text-dim)', fontSize: 11, marginTop: 2 }} title={p.path}>
                    {truncateMiddle(p.path)}
                  </div>
                </div>
                <button className="host-btn" onClick={() => startEdit(p)}>Edit</button>
                <button className="host-btn danger" onClick={() => onDelete(p.id)}>Remove</button>
              </div>
            ))
          )}
        </div>

        {/* Add / edit form */}
        <div>
          <div className="lbl">{editingId ? 'Edit project' : 'Add project'}</div>
          <div className="dispatch-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <div className="host-meta-k" style={{ marginBottom: 4 }}>Folder</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="host-caps-input"
                  style={{ flex: 1 }}
                  placeholder="/absolute/path/to/repo"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                />
                <button className="host-btn" onClick={onPickFolder}>
                  <Icon name="folder" size={12} /> Browse…
                </button>
              </div>
            </div>

            <div>
              <div className="host-meta-k" style={{ marginBottom: 4 }}>Name</div>
              <input
                className="host-caps-input"
                style={{ width: '100%' }}
                placeholder="project name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div>
              <div className="host-meta-k" style={{ marginBottom: 4 }}>Linear project</div>
              <select
                className="host-caps-input"
                style={{ width: '100%' }}
                value={linearProjectId}
                onChange={(e) => setLinearProjectId(e.target.value)}
              >
                <option value="">No link</option>
                {linearProjects.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>

            <div className="host-config-actions">
              <button className="host-btn primary" onClick={save} disabled={!canSave}>
                {editingId ? 'Save changes' : 'Add project'}
              </button>
              {editingId && (
                <button className="host-btn" onClick={resetForm}>Cancel</button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
