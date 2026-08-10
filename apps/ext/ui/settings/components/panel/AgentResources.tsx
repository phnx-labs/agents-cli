import React, { useEffect, useState } from 'react'
import { postMessage } from '../../hooks'
import type { AgentResourceRepo } from '../../types'

const KINDS: Array<keyof AgentResourceRepo['counts']> = [
  'commands', 'skills', 'hooks', 'mcp', 'rules', 'plugins', 'workflows', 'subagents',
]

const TAG_CLASS: Record<string, string> = {
  user: 'user',
  system: 'system',
  project: 'project',
}

export function AgentResources() {
  const [repos, setRepos] = useState<AgentResourceRepo[] | null>(null)

  useEffect(() => {
    const onMsg = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'agentResourcesData' && Array.isArray(msg.repos)) {
        setRepos(msg.repos as AgentResourceRepo[])
      }
    }
    window.addEventListener('message', onMsg)
    postMessage({ type: 'fetchAgentResources' })
    return () => window.removeEventListener('message', onMsg)
  }, [])

  return (
    <section className="sw-panel-section">
      <div className="sw-panel-section-head">
        Agent Resources
        <button
          type="button"
          className="sw-roster-refresh"
          title="Re-scan .agents repos"
          onClick={() => { setRepos(null); postMessage({ type: 'fetchAgentResources', force: true }) }}
        >
          Refresh
        </button>
      </div>

      {repos === null ? (
        <div className="sw-resources-loading">Scanning .agents repos…</div>
      ) : repos.length === 0 ? (
        <div className="sw-resources-empty">No .agents repos found, or the scan timed out on a large repo. Hit Refresh to retry.</div>
      ) : (
        <div className="sw-resources-grid">
          {repos.map(repo => {
            const tagCls = TAG_CLASS[repo.repo] || 'alias'
            const root = repo.root.replace(/^\/Users\/[^/]+/, '~')
            return (
              <div key={repo.repo + repo.root} className="sw-resource-repo">
                <div className="sw-resource-repo-top">
                  <span className={`sw-resource-tag ${tagCls}`}>{repo.repo}</span>
                  <span className="sw-resource-path">{root}</span>
                  {repo.git?.branch && <span className="sw-roster-chip mono">{repo.git.branch}</span>}
                  {typeof repo.git?.behind === 'number' && repo.git.behind > 0 && (
                    <span className="sw-roster-chip mono" title="commits behind origin">↓{repo.git.behind}</span>
                  )}
                </div>
                <div className="sw-resource-counts">
                  {KINDS.map(kind => (
                    <div key={kind} className={`sw-resource-stat ${repo.counts[kind] === 0 ? 'zero' : ''}`}>
                      <span className="n">{repo.counts[kind]}</span>
                      <span className="l">{kind}</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
