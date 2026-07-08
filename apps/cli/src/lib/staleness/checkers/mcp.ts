/**
 * MCP server staleness — one `.yaml`/`.yml` file per server, first-wins
 * across project > user > system > extras. Name is the `name:` field inside
 * the YAML, NOT the filename (per `getAvailableResources`).
 *
 * We delegate name/path discovery to `listMcpServerConfigs(cwd)` which
 * already handles parsing — keeps a single source of truth for "what counts
 * as a discoverable MCP server."
 */

import { fingerprintFile, isFileStale } from '../fingerprint.js';
import { listMcpServerConfigs } from '../../mcp.js';
import type { FileEntry } from '../types.js';
import type { TypedResourceChecker } from './types.js';

function indexByName(cwd: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const cfg of listMcpServerConfigs(cwd)) {
    if (!map.has(cfg.name)) map.set(cfg.name, cfg.path);
  }
  return map;
}

export const mcpChecker: TypedResourceChecker<FileEntry> = {
  type: 'mcp',

  listNames(cwd) {
    return Array.from(indexByName(cwd).keys());
  },

  build(name, cwd) {
    const src = indexByName(cwd).get(name);
    if (!src) return null;
    const fp = fingerprintFile(src);
    return fp ? { source: fp } : null;
  },

  isFresh(name, stored, cwd) {
    const src = indexByName(cwd).get(name);
    if (!src) return false;
    return !isFileStale(stored.source, src);
  },
};
