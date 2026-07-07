import { describe, expect, test } from 'bun:test';
import {
  AGENTS_CONFIG_FILENAME,
  AgentsConfig,
  getDefaultConfig,
  parseAgentsConfig,
  parseAgentsConfigOverrides,
  mergeAgentsConfig,
  serializeAgentsConfig,
  isValidAgentId,
  getContextMappings,
  getSourceFiles,
  getAliasesForSource,
} from './swarmifyConfig';

describe('swarmifyConfig', () => {
  describe('constants', () => {
    test('AGENTS_CONFIG_FILENAME is .agents', () => {
      expect(AGENTS_CONFIG_FILENAME).toBe('.agents');
    });
  });

  describe('getDefaultConfig', () => {
    test('returns default config with AGENTS.md source', () => {
      const config = getDefaultConfig();
      expect(config.context[0].source).toBe('AGENTS.md');
    });

    test('returns default aliases as CLAUDE.md and GEMINI.md', () => {
      const config = getDefaultConfig();
      expect(config.context[0].aliases).toEqual(['CLAUDE.md', 'GEMINI.md']);
    });

    test('returns default agents as claude, codex, gemini', () => {
      const config = getDefaultConfig();
      expect(config.agents).toEqual(['claude', 'codex', 'gemini']);
    });

    test('returns default ralph filename as RALPH.md', () => {
      const config = getDefaultConfig();
      expect(config.tasks.ralph).toBe('RALPH.md');
    });

    test('returns default todo filename as TODO.md', () => {
      const config = getDefaultConfig();
      expect(config.tasks.todo).toBe('TODO.md');
    });
  });

  describe('isValidAgentId', () => {
    test('returns true for valid agent ids', () => {
      expect(isValidAgentId('claude')).toBe(true);
      expect(isValidAgentId('codex')).toBe(true);
      expect(isValidAgentId('gemini')).toBe(true);
      expect(isValidAgentId('cursor')).toBe(true);
      expect(isValidAgentId('opencode')).toBe(true);
    });

    test('returns false for invalid agent ids', () => {
      expect(isValidAgentId('gpt')).toBe(false);
      expect(isValidAgentId('Claude')).toBe(false); // case sensitive
    });
  });

  describe('parseAgentsConfig', () => {
    test('returns defaults for empty string', () => {
      const config = parseAgentsConfig('');
      expect(config).toEqual(getDefaultConfig());
    });

    test('returns defaults for whitespace-only string', () => {
      const config = parseAgentsConfig('   \n\t  ');
      expect(config).toEqual(getDefaultConfig());
    });

    test('parses YAML config with new schema', () => {
      const yaml = `
context:
  - source: CLAUDE.md
    aliases:
      - AGENTS.md
      - GEMINI.md
agents:
  - claude
  - codex
tasks:
  ralph: TASKS.md
  todo: TODOS.md
`;
      const config = parseAgentsConfig(yaml);
      expect(config.context[0].source).toBe('CLAUDE.md');
      expect(config.context[0].aliases).toEqual(['AGENTS.md', 'GEMINI.md']);
      expect(config.agents).toEqual(['claude', 'codex']);
      expect(config.tasks.ralph).toBe('TASKS.md');
      expect(config.tasks.todo).toBe('TODOS.md');
    });

    test('parses multiple context mappings', () => {
      const yaml = `
context:
  - source: AGENTS.md
    aliases:
      - CLAUDE.md
  - source: TASKS.md
    aliases:
      - TASKS_CLAUDE.md
      - TASKS_GEMINI.md
`;
      const config = parseAgentsConfig(yaml);
      expect(config.context).toHaveLength(2);
      expect(config.context[0].source).toBe('AGENTS.md');
      expect(config.context[0].aliases).toEqual(['CLAUDE.md']);
      expect(config.context[1].source).toBe('TASKS.md');
      expect(config.context[1].aliases).toEqual(['TASKS_CLAUDE.md', 'TASKS_GEMINI.md']);
    });

    test('filters out invalid agent ids', () => {
      const yaml = `
agents:
  - claude
  - invalid
  - codex
`;
      const config = parseAgentsConfig(yaml);
      expect(config.agents).toEqual(['claude', 'codex']);
    });

    test('uses defaults for empty agents array', () => {
      const yaml = `
agents: []
`;
      const config = parseAgentsConfig(yaml);
      expect(config.agents).toEqual(['claude', 'codex', 'gemini']); // default
    });

    test('trims task file names', () => {
      const yaml = `
tasks:
  ralph: "  TASKS.md  "
  todo: "  TODOS.md  "
`;
      const config = parseAgentsConfig(yaml);
      expect(config.tasks.ralph).toBe('TASKS.md');
      expect(config.tasks.todo).toBe('TODOS.md');
    });

    test('uses defaults for empty task file names', () => {
      const yaml = `
tasks:
  ralph: ""
  todo: "   "
`;
      const config = parseAgentsConfig(yaml);
      expect(config.tasks.ralph).toBe('RALPH.md'); // default
      expect(config.tasks.todo).toBe('TODO.md'); // default
    });

    test('trims sources and aliases', () => {
      const yaml = `
context:
  - source: "  AGENTS.md  "
    aliases:
      - "  CLAUDE.md  "
`;
      const config = parseAgentsConfig(yaml);
      expect(config.context[0].source).toBe('AGENTS.md');
      expect(config.context[0].aliases).toEqual(['CLAUDE.md']);
    });
  });

  describe('parseAgentsConfigOverrides', () => {
    test('returns null for empty string', () => {
      const overrides = parseAgentsConfigOverrides('');
      expect(overrides).toBeNull();
    });

    test('returns overrides for valid fields only', () => {
      const yaml = `
context:
  - source: AGENTS.md
    aliases:
      - CLAUDE.md
agents:
  - claude
  - invalid
tasks:
  ralph: TASKS.md
  todo: "   "
`;
      const overrides = parseAgentsConfigOverrides(yaml);
      expect(overrides?.context).toEqual([
        { source: 'AGENTS.md', aliases: ['CLAUDE.md'] },
      ]);
      expect(overrides?.agents).toEqual(['claude']);
      expect(overrides?.tasks).toEqual({ ralph: 'TASKS.md' });
    });
  });

  describe('mergeAgentsConfig', () => {
    test('unions context mappings with workspace overrides', () => {
      const base: AgentsConfig = {
        context: [
          { source: 'AGENTS.md', aliases: ['CLAUDE.md'] },
          { source: 'TASKS.md', aliases: ['TASKS_CLAUDE.md'] },
        ],
        agents: ['claude'],
        tasks: { ralph: 'RALPH.md', todo: 'TODO.md' },
      };

      const overrides = {
        context: [
          { source: 'AGENTS.md', aliases: ['GEMINI.md'] },
        ],
        agents: ['codex'],
        tasks: { todo: 'TODOS.md' },
      };

      const merged = mergeAgentsConfig(base, overrides, { contextMerge: 'union' });

      expect(merged.context).toEqual([
        { source: 'AGENTS.md', aliases: ['GEMINI.md'] },
        { source: 'TASKS.md', aliases: ['TASKS_CLAUDE.md'] },
      ]);
      expect(merged.agents).toEqual(['codex']);
      expect(merged.tasks).toEqual({ ralph: 'RALPH.md', todo: 'TODOS.md' });
    });
  });

  describe('serializeAgentsConfig', () => {
    test('serializes config to valid YAML', () => {
      const config = getDefaultConfig();
      const yaml = serializeAgentsConfig(config);

      // Parse it back to verify
      const parsed = parseAgentsConfig(yaml);
      expect(parsed.context).toEqual(config.context);
      expect(parsed.agents).toEqual(config.agents);
      expect(parsed.tasks.ralph).toBe(config.tasks.ralph);
      expect(parsed.tasks.todo).toBe(config.tasks.todo);
    });

    test('serializes custom config correctly', () => {
      const config: AgentsConfig = {
        context: [
          { source: 'CLAUDE.md', aliases: ['AGENTS.md'] },
        ],
        agents: ['claude'],
        tasks: {
          ralph: 'TASKS.md',
          todo: 'TODOS.md',
        },
      };
      const yaml = serializeAgentsConfig(config);
      const parsed = parseAgentsConfig(yaml);

      expect(parsed.context[0].source).toBe('CLAUDE.md');
      expect(parsed.context[0].aliases).toEqual(['AGENTS.md']);
      expect(parsed.agents).toEqual(['claude']);
      expect(parsed.tasks.ralph).toBe('TASKS.md');
      expect(parsed.tasks.todo).toBe('TODOS.md');
    });
  });

  describe('getContextMappings', () => {
    test('returns all context mappings', () => {
      const config: AgentsConfig = {
        context: [
          { source: 'AGENTS.md', aliases: ['CLAUDE.md', 'GEMINI.md'] },
          { source: 'TASKS.md', aliases: ['TASKS_CLAUDE.md'] },
        ],
        agents: ['claude'],
        tasks: { ralph: 'RALPH.md', todo: 'TODO.md' },
      };
      const mappings = getContextMappings(config);
      expect(mappings).toHaveLength(2);
      expect(mappings[0].source).toBe('AGENTS.md');
      expect(mappings[1].source).toBe('TASKS.md');
    });
  });

  describe('getSourceFiles', () => {
    test('returns all source files from config', () => {
      const config: AgentsConfig = {
        context: [
          { source: 'AGENTS.md', aliases: ['CLAUDE.md'] },
          { source: 'TASKS.md', aliases: ['TASKS_CLAUDE.md'] },
        ],
        agents: ['claude'],
        tasks: { ralph: 'RALPH.md', todo: 'TODO.md' },
      };
      const sources = getSourceFiles(config);
      expect(sources).toEqual(['AGENTS.md', 'TASKS.md']);
    });
  });

  describe('getAliasesForSource', () => {
    test('returns aliases for a specific source', () => {
      const config: AgentsConfig = {
        context: [
          { source: 'AGENTS.md', aliases: ['CLAUDE.md', 'GEMINI.md'] },
          { source: 'TASKS.md', aliases: ['TASKS_CLAUDE.md'] },
        ],
        agents: ['claude'],
        tasks: { ralph: 'RALPH.md', todo: 'TODO.md' },
      };
      expect(getAliasesForSource(config, 'AGENTS.md')).toEqual(['CLAUDE.md', 'GEMINI.md']);
      expect(getAliasesForSource(config, 'TASKS.md')).toEqual(['TASKS_CLAUDE.md']);
    });

    test('returns empty array for unknown source', () => {
      const config = getDefaultConfig();
      expect(getAliasesForSource(config, 'UNKNOWN.md')).toEqual([]);
    });
  });
});
