import { describe, test, expect } from 'bun:test';
import {
  hasSwarmInstructions,
  getSwarmInstructionsBlock,
  injectSwarmInstructions
} from './claudemd';

describe('hasSwarmInstructions', () => {
  test('returns false for empty content', () => {
    expect(hasSwarmInstructions('')).toBe(false);
  });

  test('returns false for unrelated content', () => {
    const content = `## Project Setup

This is a project about something else.

- Use npm to install
- Run tests with jest
`;
    expect(hasSwarmInstructions(content)).toBe(false);
  });

  test('returns true when mcp__Swarm is present', () => {
    const content = `## Instructions

Use mcp__Swarm__Spawn to spawn agents.
`;
    expect(hasSwarmInstructions(content)).toBe(true);
  });

  test('returns true when Swarm MCP is present', () => {
    const content = `## Instructions

Use the Swarm MCP extension for agent spawning.
`;
    expect(hasSwarmInstructions(content)).toBe(true);
  });

  test('is case insensitive', () => {
    expect(hasSwarmInstructions('use MCP__SWARM__Spawn')).toBe(true);
    expect(hasSwarmInstructions('use swarm mcp')).toBe(true);
  });
});

describe('getSwarmInstructionsBlock', () => {
  test('returns a non-empty string', () => {
    const block = getSwarmInstructionsBlock();
    expect(block.length).toBeGreaterThan(0);
  });

  test('starts with H2 heading', () => {
    const block = getSwarmInstructionsBlock();
    expect(block.startsWith('## ')).toBe(true);
  });

  test('contains Swarm MCP tools', () => {
    const block = getSwarmInstructionsBlock();
    expect(block).toContain('mcp__Swarm__Spawn');
    expect(block).toContain('mcp__Swarm__Status');
    expect(block).toContain('mcp__Swarm__Read');
    expect(block).toContain('mcp__Swarm__Stop');
  });

  test('ends with newline', () => {
    const block = getSwarmInstructionsBlock();
    expect(block.endsWith('\n')).toBe(true);
  });
});

describe('injectSwarmInstructions', () => {
  test('prepends block to empty content', () => {
    const result = injectSwarmInstructions('');
    expect(result).toBe(getSwarmInstructionsBlock());
  });

  test('prepends block to existing content', () => {
    const existing = '## Existing Section\n\nSome content.';
    const result = injectSwarmInstructions(existing);

    expect(result.startsWith('## Agent Spawning')).toBe(true);
    expect(result).toContain(existing);
    expect(result.indexOf('## Agent Spawning')).toBeLessThan(result.indexOf('## Existing Section'));
  });

  test('result passes hasSwarmInstructions check', () => {
    const result = injectSwarmInstructions('Some content');
    expect(hasSwarmInstructions(result)).toBe(true);
  });
});
