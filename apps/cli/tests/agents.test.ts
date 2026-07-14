import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENTS, ALL_AGENT_IDS, getAccountEmail, getMcpConfigPathForHome, parseMcpConfig } from '../src/lib/agents.js';
import { convertToOpenCodeFormat, convertToCursorFormat, applyPermissionsToVersion } from '../src/lib/permissions.js';
import { capableAgents, supports } from '../src/lib/capabilities.js';
import {
  transformSubagentForDroid,
  transformSubagentForCodex,
  transformSubagentForKimi,
  buildKimiSubagentsParentYaml,
  installSubagentToAgent,
  listSubagentsForAgent,
  transformSubagentForOpenCode,
  KIMI_SUBAGENTS_PARENT_FILE,
} from '../src/lib/subagents.js';

describe('capableAgents("commands")', () => {
  it('excludes openclaw since it uses Gateway-based slash commands', () => {
    expect(capableAgents('commands')).not.toContain('openclaw');
  });

  it('includes all other agents that support file-based commands', () => {
    const expected = ['claude', 'codex', 'gemini', 'cursor', 'opencode'];
    const agents = capableAgents('commands');
    for (const agent of expected) {
      expect(agents).toContain(agent);
    }
  });

  it('is derived from capabilities.commands', () => {
    const fromCapabilities = ALL_AGENT_IDS.filter(id => AGENTS[id].capabilities.commands);
    expect(capableAgents('commands')).toEqual(fromCapabilities);
  });

  it('openclaw has empty commandsDir and commands:false', () => {
    expect(AGENTS['openclaw'].commandsDir).toBe('');
    expect(AGENTS['openclaw'].capabilities.commands).toBe(false);
  });

  it('agents with capabilities.commands have non-empty commandsDir', () => {
    for (const id of ALL_AGENT_IDS) {
      if (!AGENTS[id].capabilities.commands) continue;
      expect(AGENTS[id].commandsDir).not.toBe('');
    }
  });
});

describe('droid (Factory AI)', () => {
  it('is registered with its supported resource capabilities', () => {
    expect(ALL_AGENT_IDS).toContain('droid');
    expect(capableAgents('mcp')).toContain('droid');
    expect(capableAgents('commands')).toContain('droid');
    expect(capableAgents('subagents')).toContain('droid');
    // Factory CLI (droid) supports Claude-shaped hooks in .factory/settings.json
    // (RUSH-1327) and plugins via the marketplace + installed_plugins.json model
    // (RUSH-1340). Both route through supports() like every other capability.
    expect(capableAgents('hooks')).toContain('droid');
    expect(capableAgents('plugins')).toContain('droid');
    expect(capableAgents('skills')).toContain('droid');
    // No Droid equivalent for workflows — keep it false so the registry
    // assertion doesn't demand a writer we can't provide.
    expect(capableAgents('workflows')).not.toContain('droid');
  });

  it('resolves MCP config to ~/.factory/mcp.json and parses the written shape back', () => {
    // Guards the writer/reader contract: installMcpToFactoryConfig writes
    // `mcpServers` JSON to <home>/.factory/mcp.json; the detector reads via
    // getMcpConfigPathForHome + parseMcpConfig. A path or format drift (e.g.
    // defaulting to settings.json or a TOML parser) would break sync silently.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-droid-mcp-'));
    try {
      const configPath = getMcpConfigPathForHome('droid', home);
      expect(configPath).toBe(path.join(home, '.factory', 'mcp.json'));

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({ mcpServers: { ctx: { command: 'ctx-server', args: ['--stdio'], env: {} } } })
      );

      const parsed = parseMcpConfig('droid', configPath);
      expect(Object.keys(parsed)).toContain('ctx');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('transformSubagentForDroid keeps name/description/model and drops color', () => {
    // Factory custom droids support name/description/model but have no `color`
    // field. Emitting it risks the droid being rejected, so it must be stripped.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-droid-sub-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'AGENT.md'),
        `---\nname: reviewer\ndescription: Reviews diffs\nmodel: inherit\ncolor: red\n---\n\nYou review code.\n`
      );
      const out = transformSubagentForDroid(dir);
      expect(out).toContain('name: reviewer');
      expect(out).toContain('description: Reviews diffs');
      expect(out).toContain('model: inherit');
      expect(out).not.toContain('color');
      expect(out).toContain('You review code.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Hermes and ForgeCode install targets', () => {
  it('registers Hermes with skills, MCP, and MEMORY.md rules', () => {
    expect(ALL_AGENT_IDS).toContain('hermes');
    expect(capableAgents('mcp')).toContain('hermes');
    expect(capableAgents('skills')).toContain('hermes');
    expect(capableAgents('commands')).not.toContain('hermes');
    expect(capableAgents('hooks')).not.toContain('hermes');
    expect(AGENTS.hermes.instructionsFile).toBe('MEMORY.md');
    expect(AGENTS.hermes.capabilities.rules).toEqual({ file: 'MEMORY.md' });
  });

  it('resolves Hermes MCP config to ~/.hermes/config.yaml and parses mcp_servers YAML', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-hermes-mcp-'));
    try {
      const configPath = getMcpConfigPathForHome('hermes', home);
      expect(configPath).toBe(path.join(home, '.hermes', 'config.yaml'));

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        [
          'model: openrouter/anthropic/claude-sonnet-4',
          'mcp_servers:',
          '  ctx:',
          '    command: ctx-server',
          '    args:',
          '      - --stdio',
          '',
        ].join('\n')
      );

      const parsed = parseMcpConfig('hermes', configPath);
      expect(parsed.ctx.command).toBe('ctx-server');
      expect(parsed.ctx.args).toEqual(['--stdio']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('registers ForgeCode with skills, MCP, and AGENTS.md rules', () => {
    expect(ALL_AGENT_IDS).toContain('forge');
    expect(capableAgents('mcp')).toContain('forge');
    expect(capableAgents('skills')).toContain('forge');
    expect(capableAgents('commands')).not.toContain('forge');
    expect(capableAgents('hooks')).not.toContain('forge');
    expect(AGENTS.forge.instructionsFile).toBe('AGENTS.md');
    expect(AGENTS.forge.capabilities.rules).toEqual({ file: 'AGENTS.md' });
  });

  it('resolves ForgeCode MCP config to ~/.forge/.mcp.json and parses mcpServers JSON', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-forge-mcp-'));
    try {
      const configPath = getMcpConfigPathForHome('forge', home);
      expect(configPath).toBe(path.join(home, '.forge', '.mcp.json'));

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({ mcpServers: { ctx: { command: 'ctx-server', args: ['--stdio'] } } })
      );

      const parsed = parseMcpConfig('forge', configPath);
      expect(parsed.ctx.command).toBe('ctx-server');
      expect(parsed.ctx.args).toEqual(['--stdio']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('codex subagents (TOML custom agents)', () => {
  it('is capable of subagents since 0.117.0', () => {
    expect(capableAgents('subagents')).toContain('codex');
    expect(supports('codex', 'subagents', '0.116.0').ok).toBe(false);
    expect(supports('codex', 'subagents', '0.117.0').ok).toBe(true);
  });

  it('transformSubagentForCodex emits required TOML fields', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-codex-sub-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'AGENT.md'),
        `---\nname: reviewer\ndescription: Reviews diffs\nmodel: gpt-5.4\n---\n\nYou review code.\n`
      );
      const out = transformSubagentForCodex(dir);
      expect(out).toContain('name = "reviewer"');
      expect(out).toContain('description = "Reviews diffs"');
      expect(out).toContain('model = "gpt-5.4"');
      expect(out).toContain('developer_instructions = """');
      expect(out).toContain('You review code.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installSubagentToAgent writes ~/.codex/agents/<name>.toml', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-codex-inst-'));
    try {
      const subDir = path.join(root, 'sub');
      fs.mkdirSync(subDir);
      fs.writeFileSync(
        path.join(subDir, 'AGENT.md'),
        `---\nname: explorer\ndescription: Explores code\n---\n\nExplore.\n`
      );
      const home = path.join(root, 'home');
      const r = installSubagentToAgent(subDir, 'explorer', 'codex', home);
      expect(r.success).toBe(true);
      const dest = path.join(home, '.codex', 'agents', 'explorer.toml');
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.readFileSync(dest, 'utf-8')).toContain('name = "explorer"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('kimi subagents (YAML agent files)', () => {
  it('is capable of subagents', () => {
    expect(capableAgents('subagents')).toContain('kimi');
    expect(supports('kimi', 'subagents').ok).toBe(true);
  });

  it('transformSubagentForKimi emits system_prompt_path (not inline system_prompt)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-kimi-sub-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'AGENT.md'),
        `---\nname: reviewer\ndescription: Reviews diffs\nmodel: kimi-k2\n---\n\nYou review code.\n`
      );
      const out = transformSubagentForKimi(dir, 'reviewer');
      expect(out.yaml).toContain('version: 1');
      expect(out.yaml).toContain('name: reviewer');
      expect(out.yaml).toContain('description: Reviews diffs');
      expect(out.yaml).toContain('model: kimi-k2');
      expect(out.yaml).toContain('extend: default');
      expect(out.yaml).toContain('system_prompt_path: ./reviewer.system.md');
      expect(out.yaml).not.toContain('system_prompt:');
      expect(out.systemPromptFileName).toBe('reviewer.system.md');
      expect(out.systemPrompt).toContain('You review code.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildKimiSubagentsParentYaml lists subagents for --agent-file', () => {
    expect(KIMI_SUBAGENTS_PARENT_FILE).toBe('_agents-cli.yaml');
    const out = buildKimiSubagentsParentYaml([
      { name: 'reviewer', description: 'Reviews diffs', relativePath: './reviewer.yaml' },
      { name: 'explorer', description: 'Explores', relativePath: './explorer.yaml' },
    ]);
    expect(out).toContain('name: agents-cli');
    expect(out).toContain('subagents:');
    expect(out).toContain('reviewer:');
    expect(out).toContain('path: ./reviewer.yaml');
    expect(out).toContain('explorer:');
  });

  it('installSubagentToAgent writes yaml + sibling system prompt md', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-kimi-inst-'));
    try {
      const subDir = path.join(root, 'sub');
      fs.mkdirSync(subDir);
      fs.writeFileSync(
        path.join(subDir, 'AGENT.md'),
        `---\nname: explorer\ndescription: Explores code\n---\n\nExplore.\n`
      );
      const home = path.join(root, 'home');
      const r = installSubagentToAgent(subDir, 'explorer', 'kimi', home);
      expect(r.success).toBe(true);
      const dest = path.join(home, '.kimi-code', 'agents', 'explorer.yaml');
      const prompt = path.join(home, '.kimi-code', 'agents', 'explorer.system.md');
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.existsSync(prompt)).toBe(true);
      expect(fs.readFileSync(dest, 'utf-8')).toContain('system_prompt_path: ./explorer.system.md');
      expect(fs.readFileSync(prompt, 'utf-8')).toContain('Explore.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('listSubagentsForAgent finds installed kimi yaml (excludes managed parent)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-kimi-list-'));
    try {
      const subDir = path.join(root, 'sub');
      fs.mkdirSync(subDir);
      fs.writeFileSync(
        path.join(subDir, 'AGENT.md'),
        `---\nname: explorer\ndescription: Explores code\n---\n\nExplore.\n`
      );
      const home = path.join(root, 'home');
      expect(installSubagentToAgent(subDir, 'explorer', 'kimi', home).success).toBe(true);
      // managed parent must not show as an installed subagent
      fs.writeFileSync(
        path.join(home, '.kimi-code', 'agents', KIMI_SUBAGENTS_PARENT_FILE),
        'version: 1\nagent:\n  name: agents-cli\n'
      );
      const listed = listSubagentsForAgent('kimi', home);
      expect(listed.map(s => s.name)).toEqual(['explorer']);
      expect(listed[0].files).toContain('explorer.yaml');
      expect(listed[0].files).toContain('explorer.system.md');
      expect(listed[0].frontmatter.description).toBe('Explores code');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('grok subagents (Claude-compatible agent defs)', () => {
  it('is capable of subagents', () => {
    expect(capableAgents('subagents')).toContain('grok');
    expect(supports('grok', 'subagents').ok).toBe(true);
  });

  it('installSubagentToAgent writes ~/.grok/agents/<name>.md', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-grok-inst-'));
    try {
      const subDir = path.join(root, 'sub');
      fs.mkdirSync(subDir);
      fs.writeFileSync(
        path.join(subDir, 'AGENT.md'),
        `---\nname: explorer\ndescription: Explores code\n---\n\nExplore.\n`
      );
      const home = path.join(root, 'home');
      const r = installSubagentToAgent(subDir, 'explorer', 'grok', home);
      expect(r.success).toBe(true);
      const dest = path.join(home, '.grok', 'agents', 'explorer.md');
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.readFileSync(dest, 'utf-8')).toContain('name: explorer');
      expect(fs.readFileSync(dest, 'utf-8')).toContain('Explore.');
      const listed = listSubagentsForAgent('grok', home);
      expect(listed.map(s => s.name)).toEqual(['explorer']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('opencode allowlist (permission in opencode.jsonc)', () => {
  it('is capable of allowlist since 1.1.1', () => {
    expect(capableAgents('allowlist')).toContain('opencode');
    expect(supports('opencode', 'allowlist', '1.1.0').ok).toBe(false);
    expect(supports('opencode', 'allowlist', '1.1.1').ok).toBe(true);
  });

  it('convertToOpenCodeFormat maps Bash patterns into permission.bash', () => {
    const out = convertToOpenCodeFormat({ name: 't', allow: ['Bash(git *)', 'Bash(*)'], deny: ['Bash(rm *)'] });
    expect(out.permission.bash['git *']).toBe('allow');
    expect(out.permission.bash['*']).toBe('allow');
    expect(out.permission.bash['rm *']).toBe('deny');
  });

  it('applyPermissionsToVersion writes permission.bash into opencode.jsonc', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-oc-perm-'));
    try {
      const home = path.join(root, 'home');
      const r = applyPermissionsToVersion(
        'opencode',
        { name: 't', allow: ['Bash(git *)'], deny: ['Bash(rm *)'] },
        home,
        false,
      );
      expect(r.success).toBe(true);
      const dest = path.join(home, '.config', 'opencode', 'opencode.jsonc');
      expect(fs.existsSync(dest)).toBe(true);
      const cfg = JSON.parse(fs.readFileSync(dest, 'utf-8'));
      expect(cfg.permission.bash['git *']).toBe('allow');
      expect(cfg.permission.bash['rm *']).toBe('deny');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('cursor allowlist (cli-config.json)', () => {
  it('is capable of allowlist', () => {
    expect(capableAgents('allowlist')).toContain('cursor');
    expect(supports('cursor', 'allowlist').ok).toBe(true);
  });

  it('convertToCursorFormat maps Bash to Shell', () => {
    const out = convertToCursorFormat({ name: 't', allow: ['Bash(git *)', 'Read(src/**)'], deny: ['Bash(rm *)'] });
    expect(out.permissions.allow).toContain('Shell(git *)');
    expect(out.permissions.allow).toContain('Read(src/**)');
    expect(out.permissions.deny).toContain('Shell(rm *)');
  });

  it('applyPermissionsToVersion writes ~/.cursor/cli-config.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cur-perm-'));
    try {
      const home = path.join(root, 'home');
      const r = applyPermissionsToVersion(
        'cursor',
        { name: 't', allow: ['Bash(ls)'], deny: ['Bash(rm)'] },
        home,
        false,
      );
      expect(r.success).toBe(true);
      const dest = path.join(home, '.cursor', 'cli-config.json');
      expect(fs.existsSync(dest)).toBe(true);
      const cfg = JSON.parse(fs.readFileSync(dest, 'utf-8'));
      expect(cfg.permissions.allow).toContain('Shell(ls)');
      expect(cfg.permissions.deny).toContain('Shell(rm)');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('opencode subagents (markdown mode: subagent)', () => {
  it('is capable of subagents', () => {
    expect(capableAgents('subagents')).toContain('opencode');
    expect(supports('opencode', 'subagents').ok).toBe(true);
  });

  it('transformSubagentForOpenCode emits mode subagent frontmatter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-oc-sub-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'AGENT.md'),
        `---\nname: reviewer\ndescription: Reviews diffs\nmodel: anthropic/claude-sonnet-4\n---\n\nYou review code.\n`
      );
      const out = transformSubagentForOpenCode(dir);
      expect(out).toContain('mode: subagent');
      expect(out).toContain('description: Reviews diffs');
      expect(out).toContain('model: anthropic/claude-sonnet-4');
      expect(out).toContain('You review code.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installSubagentToAgent writes ~/.config/opencode/agents/<name>.md', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-oc-inst-'));
    try {
      const subDir = path.join(root, 'sub');
      fs.mkdirSync(subDir);
      fs.writeFileSync(
        path.join(subDir, 'AGENT.md'),
        `---\nname: explorer\ndescription: Explores code\n---\n\nExplore.\n`
      );
      const home = path.join(root, 'home');
      const r = installSubagentToAgent(subDir, 'explorer', 'opencode', home);
      expect(r.success).toBe(true);
      const dest = path.join(home, '.config', 'opencode', 'agents', 'explorer.md');
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.readFileSync(dest, 'utf-8')).toContain('mode: subagent');
      expect(listSubagentsForAgent('opencode', home).map(s => s.name)).toEqual(['explorer']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('getAccountEmail', () => {
  it('returns null for a Claude version home without oauthAccount even when real home is logged in', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-claude-auth-'));
    const realHome = path.join(tempRoot, 'real-home');
    const versionHome = path.join(tempRoot, 'version-home');
    fs.mkdirSync(realHome, { recursive: true });
    fs.mkdirSync(versionHome, { recursive: true });

    fs.writeFileSync(
      path.join(realHome, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'global@example.com' } })
    );
    fs.writeFileSync(
      path.join(versionHome, '.claude.json'),
      JSON.stringify({ mcpServers: {} })
    );

    const originalHome = process.env.HOME;
    process.env.HOME = realHome;

    try {
      await expect(getAccountEmail('claude', versionHome)).resolves.toBeNull();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses the Claude version home when oauthAccount exists there', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-claude-auth-'));
    const realHome = path.join(tempRoot, 'real-home');
    const versionHome = path.join(tempRoot, 'version-home');
    fs.mkdirSync(realHome, { recursive: true });
    fs.mkdirSync(versionHome, { recursive: true });

    fs.writeFileSync(
      path.join(realHome, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'global@example.com' } })
    );
    fs.writeFileSync(
      path.join(versionHome, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'version@example.com' } })
    );

    const originalHome = process.env.HOME;
    process.env.HOME = realHome;

    try {
      await expect(getAccountEmail('claude', versionHome)).resolves.toBe('version@example.com');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
