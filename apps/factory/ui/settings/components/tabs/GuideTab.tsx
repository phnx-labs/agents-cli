import React from 'react'
import { ExternalLink as ExternalLinkIcon } from 'lucide-react'
import { SectionHeader, ExtLink } from '../common'

const WORKFLOW_STEPS = [
  {
    title: 'Run /swarm',
    detail: 'Cmd+Shift+P → type /swarm to open the orchestrator entry point.',
  },
  {
    title: 'Describe task + mix',
    detail: 'Spell out what you need and the Mix of Agents (e.g., "Mostly Codex for quick fixes, Cursor for debugging traces").',
  },
  {
    title: 'Review plan, then approve',
    detail: 'Inspect the distribution plan and approve before agents execute.',
  },
]

const TREE_EXAMPLE = [
  'Claude (lead)',
  '├─ Codex (fix)',
  '├─ Gemini (research)',
  '└─ Cursor (trace)',
]

const MIX_TIPS = [
  'State ratios up front (70% Claude, 20% Codex, 10% Cursor).',
  'Tie mix to work type: Codex for edits, Gemini for research, Cursor for tracing.',
  'Adjust the mix in the approval prompt before agents launch.',
]

export function GuideTab() {
  return (
    <div className="space-y-6">
      <section>
        <SectionHeader>Get started with the 3-step workflow</SectionHeader>
        <div className="space-y-2">
          {WORKFLOW_STEPS.map((step, index) => (
            <div key={step.title} className="flex items-start gap-3 px-4 py-3 rounded-xl bg-[var(--muted)]">
              <span className="text-sm font-semibold text-[var(--primary)] w-4">{index + 1}</span>
              <div className="flex-1">
                <div className="text-sm font-semibold">{step.title}</div>
                <div className="text-xs text-[var(--muted-foreground)]">{step.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <SectionHeader>Entry point: /swarm</SectionHeader>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--muted)] p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
            Command Palette
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-1 rounded-md bg-[var(--background)] border border-[var(--border)] font-mono text-sm">/swarm</span>
            <span className="text-xs text-[var(--muted-foreground)]">Highlight it and hit Enter</span>
          </div>
          <div className="text-xs text-[var(--foreground)]">
            Example task: "Need mostly Codex for quick fixes and Cursor for debugging this failing test"
          </div>
        </div>
      </section>

      <section>
        <SectionHeader>Approval checkpoint</SectionHeader>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--muted)] p-4 space-y-2">
          <div className="text-xs text-[var(--muted-foreground)]">You stay in control at every step</div>
          <pre className="text-xs font-mono bg-[var(--background)] border border-[var(--border)] rounded-lg p-3 leading-relaxed">
Task → Plan → Approval → Execution
          </pre>
          <div className="text-xs text-[var(--foreground)]">
            Approve the plan (mix + roles) before any agent executes. Edit the mix if it looks off.
          </div>
        </div>
      </section>

      <section>
        <SectionHeader>Hierarchical spawning</SectionHeader>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--muted)] p-4 space-y-2">
          <div className="text-xs text-[var(--foreground)]">
            Agents can spawn other agents as work expands. Parent stays the lead; children handle focused work.
          </div>
          <pre className="text-xs font-mono bg-[var(--background)] border border-[var(--border)] rounded-lg p-3 leading-relaxed">
{TREE_EXAMPLE.join('\n')}
          </pre>
        </div>
      </section>

      <section>
        <SectionHeader>Mix of Agents</SectionHeader>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--muted)] p-4 space-y-2">
          <div className="text-xs text-[var(--foreground)]">Pick the composition that matches the work:</div>
          <ul className="list-disc list-inside text-xs text-[var(--muted-foreground)] space-y-1">
            {MIX_TIPS.map(tip => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </div>
      </section>

      <section>
        <SectionHeader>Learn More</SectionHeader>
        <div className="space-y-2">
          <ExtLink
            href="https://github.com/muqsitnawaz/swarmify"
            className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--muted)] hover:bg-[var(--muted-foreground)]/10 transition-colors"
          >
            <ExternalLinkIcon className="w-4 h-4 text-[var(--muted-foreground)]" />
            <span className="text-sm">GitHub</span>
          </ExtLink>
        </div>
      </section>
    </div>
  )
}
