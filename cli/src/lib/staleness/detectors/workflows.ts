/**
 * Workflows detector — lists the workflows agents-cli has synced into a
 * version home, in that harness's native layout (Claude WORKFLOW.md trees,
 * Kimi flow skills, Antigravity global_workflows, Goose recipes, OpenClaw
 * Lobster, Grok Rhai). The layout is not repeated here: the detector reads the
 * same `WORKFLOW_TARGETS` entry the writer materializes through, so the two
 * can never disagree about what counts as synced.
 */
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import { workflowTarget } from '../../workflows-registry.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

function buildWorkflowsDetector(agent: AgentId): ResourceDetector {
  return {
    kind: 'workflows',
    agent,
    list({ versionHome }: DetectArgs): string[] {
      const target = workflowTarget(agent);
      return target.names(target.dir(versionHome));
    },
  };
}

export const workflowsDetectors = lazyAgentMap<ResourceDetector>(() => {
  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const agent of capableAgents('workflows')) m[agent] = buildWorkflowsDetector(agent);
  return m;
});
