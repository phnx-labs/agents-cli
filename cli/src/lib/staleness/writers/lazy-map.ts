/**
 * Lazy-built per-agent map.
 *
 * The writer/detector modules form a circular dependency with agents.ts:
 * agents.ts → versions.ts → staleness/registry.ts → writers/<kind>.ts →
 * (capableAgents/AGENTS via capabilities or agents directly). If a writer
 * module iterates AGENTS at module top-level it fires before the AGENTS
 * const is initialized through the cycle. Wrapping the per-agent map in a
 * lazily-evaluated Proxy defers every read until call time, by which point
 * the cycle has resolved.
 */
import type { AgentId } from '../../types.js';

export function lazyAgentMap<T>(
  build: () => Partial<Record<AgentId, T>>
): Partial<Record<AgentId, T>> {
  let cache: Partial<Record<AgentId, T>> | null = null;
  const ensure = (): Partial<Record<AgentId, T>> => {
    if (!cache) cache = build();
    return cache;
  };
  return new Proxy({} as Partial<Record<AgentId, T>>, {
    get(_t, prop) { return ensure()[prop as AgentId]; },
    has(_t, prop) { return prop in ensure(); },
    ownKeys() { return Reflect.ownKeys(ensure()); },
    getOwnPropertyDescriptor(_t, prop) {
      const m = ensure();
      if (prop in m) return { configurable: true, enumerable: true, value: m[prop as AgentId] };
      return undefined;
    },
  });
}
