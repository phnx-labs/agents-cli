/**
 * Memory resource handler — knowledge/facts store (not rules/instructions).
 *
 * Canonical source: layered `memory/` dirs under project/user/system agents
 * roots. Sync copies into each capable agent's version home (see memory.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, Layer, ResolvedItem, ResourceHandler } from './types.js';
import {
  listMemoryFacts,
  readMemoryFact,
  syncMemoryToVersionHome,
  memoryTargetDir,
  type MemoryFact,
} from '../memory.js';

export interface MemoryItem {
  name: string;
  content: string;
  summary: string;
}

function toItem(fact: MemoryFact): ResolvedItem<MemoryItem> {
  let content = '';
  try {
    content = fs.readFileSync(fact.path, 'utf-8');
  } catch {
    content = '';
  }
  return {
    name: fact.name,
    item: { name: fact.name, content, summary: fact.summary },
    layer: fact.layer as Layer,
    path: fact.path,
  };
}

export const MemoryHandler: ResourceHandler<MemoryItem> = {
  kind: 'memory',

  listAll(_agent: AgentId, cwd?: string): ResolvedItem<MemoryItem>[] {
    return listMemoryFacts(cwd).map(toItem);
  },

  resolve(_agent: AgentId, name: string, cwd?: string): ResolvedItem<MemoryItem> | null {
    const fact = readMemoryFact(name, cwd);
    return fact ? toItem(fact) : null;
  },

  sync(agent: AgentId, versionHome: string, cwd?: string): void {
    syncMemoryToVersionHome(agent, versionHome, cwd);
  },

  format(_agent: AgentId): 'md' | 'toml' | 'json' | 'yaml' {
    return 'md';
  },

  targetDir(agent: AgentId): string {
    return memoryTargetDir(agent);
  },
};

/** Convenience: list fact names for a cwd. */
export function listMemoryNames(cwd?: string): string[] {
  return listMemoryFacts(cwd).map((f) => f.name);
}
