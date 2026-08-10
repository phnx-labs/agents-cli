// Pure functions for CLAUDE.md manipulation (no VS Code dependencies - testable)

// Check if content already has Swarm instructions
export function hasSwarmInstructions(content: string): boolean {
  const patterns = [/mcp__Swarm/i, /Swarm MCP/i];
  return patterns.some(p => p.test(content));
}

// Generate the instructions block
export function getSwarmInstructionsBlock(): string {
  return `## Agent Spawning

When asked to spawn agents or perform multi-agent tasks, use the Swarm MCP extension:

- \`mcp__Swarm__Spawn\` - Spawn agents (codex, cursor, gemini, claude)
- \`mcp__Swarm__Status\` - Check agent status
- \`mcp__Swarm__Read\` - Read agent output
- \`mcp__Swarm__Stop\` - Stop agents

Do NOT use built-in Claude Code agents (Task tool with Explore/Plan subagent_type) when Swarm agents are requested.

`;
}

// Prepend instructions to content
export function injectSwarmInstructions(content: string): string {
  return getSwarmInstructionsBlock() + content;
}
