/**
 * PHNX-3236: the teammate self-merge boundary is injected as a DISPATCH DEFAULT.
 * A write-capable teammate authenticates as the repo owner, so it can merge its
 * OWN PR past the required non-author-review gate (the RUSH-2988 wave-1 incident,
 * PRs #1817/#1820). Making the boundary a default the runner appends to every
 * non-plan teammate — rather than per-brief wording one teammate got and its
 * siblings didn't — is what closes the gap uniformly across every harness.
 *
 * Real builder, no mocking: buildRunArgv is the production argv builder; these
 * assert the policy rides the teammate's prompt on every write-capable launch and
 * is absent from a read-only plan-mode launch.
 */
import { describe, it, expect } from 'vitest';
import { AgentManager } from './agents.js';

// buildRunArgv is private; reach it through a cast — testing the real builder,
// not a re-implementation. Same seam as agents.resume.test.ts.
function argv(opts: {
  agentType?: string;
  prompt?: string;
  mode?: string;
  resume?: { id: string; message: string };
}): string[] {
  const mgr = new AgentManager() as any;
  return mgr.buildRunArgv(
    opts.agentType ?? 'claude',
    opts.prompt ?? 'the original brief',
    opts.mode ?? 'edit',
    null,
    'medium',
    null,
    null,
    opts.resume,
  );
}

// The prompt is always the first positional after `run <target>`.
const promptOf = (a: string[]): string => a[2];

describe('buildRunArgv — teammate self-merge policy (PHNX-3236)', () => {
  it('appends the no-self-merge policy to a fresh write-capable teammate', () => {
    const p = promptOf(argv({ mode: 'edit', prompt: 'ship the fix' }));
    expect(p).toContain('do NOT merge your OWN PR');
    expect(p).toContain('NON-AUTHOR review verdict');
    // The policy names the hard enforcement so it is not a naked instruction.
    expect(p).toContain('merge-guard');
    // The original brief and the summary suffix are still present.
    expect(p).toContain('ship the fix');
    expect(p).toContain('provide a brief summary');
  });

  it('appends the policy to a resumed teammate too (the incident recurred on resume)', () => {
    const p = promptOf(argv({ mode: 'edit', resume: { id: 's1', message: 'keep going' } }));
    expect(p.startsWith('keep going')).toBe(true);
    expect(p).toContain('do NOT merge your OWN PR');
  });

  it('is applied in auto and skip modes as well — any write mode can open a PR', () => {
    for (const mode of ['auto', 'skip']) {
      expect(promptOf(argv({ mode }))).toContain('do NOT merge your OWN PR');
    }
  });

  it('is harness-independent — a codex teammate gets the same policy', () => {
    expect(promptOf(argv({ agentType: 'codex', mode: 'edit' }))).toContain('do NOT merge your OWN PR');
  });

  it('is NOT injected into a read-only plan-mode teammate (it opens no PR)', () => {
    const claudePlan = promptOf(argv({ agentType: 'claude', mode: 'plan', prompt: 'design it' }));
    expect(claudePlan).not.toContain('do NOT merge your OWN PR');
    // Plan mode still carries its own scaffolding.
    expect(claudePlan).toContain('HEADLESS PLAN MODE');
    const codexPlan = promptOf(argv({ agentType: 'codex', mode: 'plan' }));
    expect(codexPlan).not.toContain('do NOT merge your OWN PR');
  });
});
