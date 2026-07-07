import React, { useState } from 'react'
import { Input } from '../ui/input'
import type { AgentSettings, ProjectRule } from '../../types'

interface ProjectRulesSectionProps {
  settings: AgentSettings
  onSaveSettings: (settings: AgentSettings) => void
}

const ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }
const ORD: React.CSSProperties = { minWidth: 16, textAlign: 'center', fontSize: 11, color: 'var(--ds-text-dim)' }
const SEP: React.CSSProperties = { fontSize: 11, color: 'var(--ds-text-dim)' }

/**
 * Project Rules: an ordered list of cwd->project mappings that control how the
 * Factory Floor groups agent cards. The first rule whose pattern matches a
 * session's cwd wins; a pattern is a glob (** spans directories, * does not) or a
 * plain path prefix. Persisted in AgentSettings.projectRules via onSaveSettings.
 */
export function ProjectRulesSection({ settings, onSaveSettings }: ProjectRulesSectionProps) {
  const rules = settings.projectRules ?? []
  const [newPattern, setNewPattern] = useState('')
  const [newProject, setNewProject] = useState('')

  const writeRules = (next: ProjectRule[]) => {
    onSaveSettings({ ...settings, projectRules: next })
  }

  const updateRule = (index: number, patch: Partial<ProjectRule>) => {
    writeRules(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  const moveRule = (index: number, delta: number) => {
    const j = index + delta
    if (j < 0 || j >= rules.length) return
    const next = [...rules]
    const tmp = next[index]
    next[index] = next[j]
    next[j] = tmp
    writeRules(next)
  }

  const removeRule = (index: number) => {
    writeRules(rules.filter((_, i) => i !== index))
  }

  const addRule = () => {
    const pattern = newPattern.trim()
    const project = newProject.trim()
    if (!pattern || !project) return
    writeRules([...rules, { pattern, project }])
    setNewPattern('')
    setNewProject('')
  }

  return (
    <section className="sw-panel-section">
      <div className="sw-panel-section-head">Project Rules</div>
      <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 8 }}>
        Map a session path to a Factory Floor project group. The first matching rule
        wins; a pattern is a glob (<code>**</code> spans directories) or a path prefix.
        Without a rule, a path folds to its git repo (worktrees included).
      </div>

      {rules.length === 0 && (
        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 8 }}>
          No rules yet. Add one below, e.g. <code>**/agents/prix/api</code> names the
          project <code>Prix API</code>.
        </div>
      )}

      {rules.map((rule, idx) => (
        <div key={idx} style={ROW}>
          <span style={ORD}>{idx + 1}</span>
          <Input
            value={rule.pattern}
            placeholder="**/agents/prix/api"
            onChange={(e) => updateRule(idx, { pattern: e.currentTarget.value })}
            style={{ flex: 2 }}
          />
          <span style={SEP}>to</span>
          <Input
            value={rule.project}
            placeholder="Prix API"
            onChange={(e) => updateRule(idx, { project: e.currentTarget.value })}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="sw-btn secondary sm"
            disabled={idx === 0}
            onClick={() => moveRule(idx, -1)}
          >
            Up
          </button>
          <button
            type="button"
            className="sw-btn secondary sm"
            disabled={idx === rules.length - 1}
            onClick={() => moveRule(idx, 1)}
          >
            Down
          </button>
          <button type="button" className="sw-btn danger sm" onClick={() => removeRule(idx)}>
            Remove
          </button>
        </div>
      ))}

      <div style={{ ...ROW, marginTop: 8 }}>
        <span style={ORD}>+</span>
        <Input
          value={newPattern}
          placeholder="path pattern (glob or prefix)"
          onChange={(e) => setNewPattern(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addRule()
          }}
          style={{ flex: 2 }}
        />
        <span style={SEP}>to</span>
        <Input
          value={newProject}
          placeholder="project name"
          onChange={(e) => setNewProject(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addRule()
          }}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="sw-btn primary sm"
          onClick={addRule}
          disabled={!newPattern.trim() || !newProject.trim()}
        >
          Add
        </button>
      </div>
    </section>
  )
}
