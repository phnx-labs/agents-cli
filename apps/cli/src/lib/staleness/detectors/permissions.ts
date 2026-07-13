/**
 * Permissions detector — inspects the agent's native permission storage and
 * reports the permission GROUP names that have been applied.
 *
 * For claude/opencode the detector intersects with discovered groups (a group
 * is "applied" if any of its allow/deny rules are present). For Codex / Gemini /
 * Antigravity / Grok the on-disk format is lossy — once any group has been
 * applied the storage doesn't carry per-group provenance back, so we report
 * "all known groups applied" when any permission artifact is present. This
 * matches the existing behavior in versions.ts:445-518 (extended to the
 * agents that were previously silent-skipped).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as TOML from 'smol-toml';
import * as yaml from 'yaml';
import type { AgentId } from '../../types.js';
import { capableAgents } from '../../capabilities.js';
import {
  discoverPermissionGroups,
  buildPermissionsFromGroups,
  CODEX_RULES_FILENAME,
} from '../../permissions.js';
import type { ResourceDetector, DetectArgs } from './types.js';
import { lazyAgentMap } from '../writers/lazy-map.js';

function buildClaudeDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'claude',
    list({ versionHome }: DetectArgs): string[] {
      const settingsPath = path.join(versionHome, '.claude', 'settings.json');
      if (!fs.existsSync(settingsPath)) return [];
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const allowRules: string[] = settings.permissions?.allow || [];
        const denyRules: string[] = settings.permissions?.deny || [];
        if (allowRules.length === 0 && denyRules.length === 0) return [];

        const groups = discoverPermissionGroups();
        const applied: string[] = [];
        for (const group of groups) {
          const built = buildPermissionsFromGroups([group.name]);
          // Empty groups (header files) count as synced when anything is applied.
          if (built.allow.length === 0 && (!built.deny || built.deny.length === 0)) {
            applied.push(group.name);
            continue;
          }
          const hasAllow = built.allow.some(r => allowRules.includes(r));
          const hasDeny = built.deny?.some(r => denyRules.includes(r)) || false;
          if (hasAllow || hasDeny) applied.push(group.name);
        }
        return applied;
      } catch {
        return [];
      }
    },
  };
}

function buildCodexDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'codex',
    list({ versionHome }: DetectArgs): string[] {
      const codexConfigPath = path.join(versionHome, '.codex', 'config.toml');
      const codexRulesPath = path.join(versionHome, '.codex', 'rules', CODEX_RULES_FILENAME);
      const hasConfig = fs.existsSync(codexConfigPath);
      const hasRules = fs.existsSync(codexRulesPath);
      if (!hasConfig && !hasRules) return [];
      try {
        let hasPermKeys = false;
        if (hasConfig) {
          const config = TOML.parse(fs.readFileSync(codexConfigPath, 'utf-8')) as Record<string, unknown>;
          hasPermKeys = !!(config.approval_policy || config.sandbox_mode || config.sandbox_workspace_write);
        }
        if (hasPermKeys || hasRules) {
          return discoverPermissionGroups().map(g => g.name);
        }
      } catch { /* parse fail */ }
      return [];
    },
  };
}

function buildOpenCodeDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'opencode',
    list({ versionHome }: DetectArgs): string[] {
      const opencodeConfigPath = path.join(versionHome, '.opencode', 'opencode.jsonc');
      if (!fs.existsSync(opencodeConfigPath)) return [];
      try {
        const content = fs.readFileSync(opencodeConfigPath, 'utf-8');
        const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const config = JSON.parse(stripped);
        if (config.permission && Object.keys(config.permission.bash || {}).length > 0) {
          return discoverPermissionGroups().map(g => g.name);
        }
      } catch { /* parse fail */ }
      return [];
    },
  };
}

function buildGeminiDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'gemini',
    list({ versionHome }: DetectArgs): string[] {
      const settingsPath = path.join(versionHome, '.gemini', 'settings.json');
      if (!fs.existsSync(settingsPath)) return [];
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const allowed: unknown = settings?.tools?.allowed;
        if (Array.isArray(allowed) && allowed.length > 0) {
          return discoverPermissionGroups().map(g => g.name);
        }
      } catch { /* parse fail */ }
      return [];
    },
  };
}

function buildAntigravityDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'antigravity',
    list({ versionHome }: DetectArgs): string[] {
      const settingsPath = path.join(versionHome, '.gemini', 'antigravity-cli', 'settings.json');
      if (!fs.existsSync(settingsPath)) return [];
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const perms = settings?.permissions;
        const hasAllow = Array.isArray(perms?.allow) && perms.allow.length > 0;
        const hasDeny = Array.isArray(perms?.deny) && perms.deny.length > 0;
        if (hasAllow || hasDeny) {
          return discoverPermissionGroups().map(g => g.name);
        }
      } catch { /* parse fail */ }
      return [];
    },
  };
}

function buildGrokDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'grok',
    list({ versionHome }: DetectArgs): string[] {
      const configPath = path.join(versionHome, '.grok', 'config.toml');
      if (!fs.existsSync(configPath)) return [];
      try {
        const config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        const perm = config.permission as { rules?: unknown[] } | undefined;
        if (perm && Array.isArray(perm.rules) && perm.rules.length > 0) {
          return discoverPermissionGroups().map(g => g.name);
        }
      } catch { /* parse fail */ }
      return [];
    },
  };
}

function buildKimiDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'kimi',
    list({ versionHome }: DetectArgs): string[] {
      const configPath = path.join(versionHome, '.kimi-code', 'config.toml');
      if (!fs.existsSync(configPath)) return [];
      try {
        const config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        const perm = config.permission as { rules?: unknown[] } | undefined;
        if (perm && Array.isArray(perm.rules) && perm.rules.length > 0) {
          return discoverPermissionGroups().map(g => g.name);
        }
      } catch { /* parse fail */ }
      return [];
    },
  };
}

function buildCursorDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'cursor',
    list({ versionHome }: DetectArgs): string[] {
      const configPath = path.join(versionHome, '.cursor', 'cli-config.json');
      if (!fs.existsSync(configPath)) return [];
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
          permissions?: { allow?: string[]; deny?: string[] };
        };
        const allow = config.permissions?.allow?.length ?? 0;
        const deny = config.permissions?.deny?.length ?? 0;
        if (allow + deny > 0) return discoverPermissionGroups().map(g => g.name);
      } catch { /* parse fail */ }
      return [];
    },
  };
}

function buildKiroDetector(): ResourceDetector {
  return {
    kind: 'permissions',
    agent: 'kiro',
    list({ versionHome }: DetectArgs): string[] {
      const permissionsPath = path.join(versionHome, '.kiro', 'settings', 'permissions.yaml');
      if (!fs.existsSync(permissionsPath)) return [];
      try {
        const config = yaml.parse(fs.readFileSync(permissionsPath, 'utf-8')) as { rules?: unknown[] } | null;
        if (config && Array.isArray(config.rules) && config.rules.length > 0) {
          return discoverPermissionGroups().map(g => g.name);
        }
      } catch { /* parse fail */ }
      return [];
    },
  };
}

const handlers: Partial<Record<AgentId, () => ResourceDetector>> = {
  claude: buildClaudeDetector,
  codex: buildCodexDetector,
  opencode: buildOpenCodeDetector,
  gemini: buildGeminiDetector,
  antigravity: buildAntigravityDetector,
  grok: buildGrokDetector,
  kimi: buildKimiDetector,
  cursor: buildCursorDetector,
  kiro: buildKiroDetector,
};

export const permissionsDetectors = lazyAgentMap<ResourceDetector>(() => {
  const m: Partial<Record<AgentId, ResourceDetector>> = {};
  for (const agent of capableAgents('allowlist')) {
    const f = handlers[agent];
    if (f) m[agent] = f();
  }
  return m;
});
