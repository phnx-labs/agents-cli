import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENTS, COMMANDS_CAPABLE_AGENTS, ALL_AGENT_IDS, getAccountEmail } from '../src/lib/agents.js';

describe('COMMANDS_CAPABLE_AGENTS', () => {
  it('excludes openclaw since it uses Gateway-based slash commands', () => {
    expect(COMMANDS_CAPABLE_AGENTS).not.toContain('openclaw');
  });

  it('includes all other agents that support file-based commands', () => {
    const expected = ['claude', 'codex', 'gemini', 'cursor', 'opencode'];
    for (const agent of expected) {
      expect(COMMANDS_CAPABLE_AGENTS).toContain(agent);
    }
  });

  it('is derived from capabilities.commands', () => {
    const fromCapabilities = ALL_AGENT_IDS.filter(id => AGENTS[id].capabilities.commands);
    expect(COMMANDS_CAPABLE_AGENTS).toEqual(fromCapabilities);
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
