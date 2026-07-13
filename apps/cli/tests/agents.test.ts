import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENTS, ALL_AGENT_IDS, getAccountEmail, getMcpConfigPathForHome, parseMcpConfig } from '../src/lib/agents.js';
import { capableAgents, supports } from '../src/lib/capabilities.js';
import {
  transformSubagentForDroid,
  transformSubagentForCodex,
  transformSubagentForKimi,
  buildKimiSubagentsParentYaml,
  installSubagentToAgent,
  listSubagentsForAgent,
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
    // No Droid equivalent for these — must stay false so the registry
    // assertion doesn't demand writers we can't provide.
    expect(capableAgents('skills')).not.toContain('droid');
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
