import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as state from '../state.js';
import { SubagentsHandler, type SubagentItem } from './subagents.js';

let tmpDir = '';
let projectAgentsDir = '';
let userAgentsDir = '';
let systemAgentsDir = '';
let handler: SubagentsHandler;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-handler-test-'));
  projectAgentsDir = path.join(tmpDir, 'project', '.agents');
  userAgentsDir = path.join(tmpDir, 'user', '.agents');
  systemAgentsDir = path.join(tmpDir, 'system', '.agents');

  // Create subagents directories in each layer
  for (const dir of [projectAgentsDir, userAgentsDir, systemAgentsDir]) {
    fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
  }

  vi.spyOn(state, 'getProjectAgentsDir').mockReturnValue(projectAgentsDir);
  vi.spyOn(state, 'getUserSubagentsDir').mockReturnValue(path.join(userAgentsDir, 'subagents'));
  vi.spyOn(state, 'getSystemSubagentsDir').mockReturnValue(path.join(systemAgentsDir, 'subagents'));
  vi.spyOn(state, 'getEnabledExtraRepos').mockReturnValue([]);

  handler = new SubagentsHandler();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper to write a subagent YAML file. */
function writeSubagent(dir: string, name: string, content: SubagentItem): string {
  const filePath = path.join(dir, 'subagents', `${name}.yaml`);
  const yamlContent = [
    `name: ${content.name}`,
    `description: ${content.description}`,
    ...(content.model ? [`model: ${content.model}`] : []),
    ...(content.color ? [`color: ${content.color}`] : []),
  ].join('\n');
  fs.writeFileSync(filePath, yamlContent);
  return filePath;
}

describe('SubagentsHandler', () => {
  describe('kind', () => {
    it('returns subagent as the resource kind', () => {
      expect(handler.kind).toBe('subagent');
    });
  });

  describe('format', () => {
    it('returns yaml for all agents', () => {
      expect(handler.format('claude')).toBe('yaml');
      expect(handler.format('codex')).toBe('yaml');
      expect(handler.format('gemini')).toBe('yaml');
    });
  });

  describe('targetDir', () => {
    it('returns subagents for all agents', () => {
      expect(handler.targetDir('claude')).toBe('subagents');
      expect(handler.targetDir('codex')).toBe('subagents');
    });
  });

  describe('resolve', () => {
    it('returns the project subagent when the same name exists in every layer', () => {
      writeSubagent(systemAgentsDir, 'shared', { name: 'shared', description: 'system version' });
      writeSubagent(userAgentsDir, 'shared', { name: 'shared', description: 'user version' });
      writeSubagent(projectAgentsDir, 'shared', { name: 'shared', description: 'project version' });

      const resolved = handler.resolve('claude', 'shared', tmpDir);

      expect(resolved).not.toBeNull();
      expect(resolved!.name).toBe('shared');
      expect(resolved!.layer).toBe('project');
      expect(resolved!.item.description).toBe('project version');
      expect(resolved!.path).toBe(path.join(projectAgentsDir, 'subagents', 'shared.yaml'));
    });

    it('falls back from user to system when project is missing', () => {
      writeSubagent(systemAgentsDir, 'system-only', { name: 'system-only', description: 'system' });
      writeSubagent(userAgentsDir, 'user-only', { name: 'user-only', description: 'user' });

      const userResolved = handler.resolve('claude', 'user-only', tmpDir);
      expect(userResolved).not.toBeNull();
      expect(userResolved!.layer).toBe('user');
      expect(userResolved!.item.description).toBe('user');

      const systemResolved = handler.resolve('claude', 'system-only', tmpDir);
      expect(systemResolved).not.toBeNull();
      expect(systemResolved!.layer).toBe('system');
      expect(systemResolved!.item.description).toBe('system');
    });

    it('returns null when subagent does not exist in any layer', () => {
      const resolved = handler.resolve('claude', 'nonexistent', tmpDir);
      expect(resolved).toBeNull();
    });

    it('supports both .yaml and .yml extensions', () => {
      // Write with .yml extension
      const ymlPath = path.join(userAgentsDir, 'subagents', 'my-agent.yml');
      fs.writeFileSync(ymlPath, 'name: my-agent\ndescription: yml extension');

      const resolved = handler.resolve('claude', 'my-agent', tmpDir);
      expect(resolved).not.toBeNull();
      expect(resolved!.name).toBe('my-agent');
      expect(resolved!.item.description).toBe('yml extension');
    });

    it('prefers .yaml over .yml when both exist', () => {
      fs.writeFileSync(
        path.join(userAgentsDir, 'subagents', 'both.yaml'),
        'name: both\ndescription: yaml version'
      );
      fs.writeFileSync(
        path.join(userAgentsDir, 'subagents', 'both.yml'),
        'name: both\ndescription: yml version'
      );

      const resolved = handler.resolve('claude', 'both', tmpDir);
      expect(resolved).not.toBeNull();
      expect(resolved!.item.description).toBe('yaml version');
    });
  });

  describe('listAll', () => {
    it('returns union of all subagents with project winning on name collision', () => {
      writeSubagent(systemAgentsDir, 'shared', { name: 'shared', description: 'system' });
      writeSubagent(userAgentsDir, 'shared', { name: 'shared', description: 'user' });
      writeSubagent(projectAgentsDir, 'shared', { name: 'shared', description: 'project' });
      writeSubagent(userAgentsDir, 'user-only', { name: 'user-only', description: 'user only' });
      writeSubagent(systemAgentsDir, 'system-only', { name: 'system-only', description: 'system only' });

      const results = handler.listAll('claude', tmpDir);

      expect(results).toHaveLength(3);

      const shared = results.find((r) => r.name === 'shared');
      expect(shared).toBeDefined();
      expect(shared!.layer).toBe('project');
      expect(shared!.item.description).toBe('project');

      const userOnly = results.find((r) => r.name === 'user-only');
      expect(userOnly).toBeDefined();
      expect(userOnly!.layer).toBe('user');

      const systemOnly = results.find((r) => r.name === 'system-only');
      expect(systemOnly).toBeDefined();
      expect(systemOnly!.layer).toBe('system');
    });

    it('returns empty array when no subagents exist', () => {
      const results = handler.listAll('claude', tmpDir);
      expect(results).toEqual([]);
    });

    it('skips invalid YAML files', () => {
      writeSubagent(userAgentsDir, 'valid', { name: 'valid', description: 'valid subagent' });
      fs.writeFileSync(
        path.join(userAgentsDir, 'subagents', 'invalid.yaml'),
        'this is not valid yaml: ['
      );

      const results = handler.listAll('claude', tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('valid');
    });

    it('skips hidden files', () => {
      writeSubagent(userAgentsDir, 'visible', { name: 'visible', description: 'visible' });
      fs.writeFileSync(
        path.join(userAgentsDir, 'subagents', '.hidden.yaml'),
        'name: hidden\ndescription: hidden'
      );

      const results = handler.listAll('claude', tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('visible');
    });

    it('includes extra repos after system', () => {
      const extraDir = path.join(tmpDir, 'extra-repo');
      fs.mkdirSync(path.join(extraDir, 'subagents'), { recursive: true });
      writeSubagent(extraDir, 'extra-agent', { name: 'extra-agent', description: 'from extra' });

      vi.spyOn(state, 'getEnabledExtraRepos').mockReturnValue([
        { alias: 'extra', dir: extraDir, url: 'https://example.com/extra' },
      ]);

      const results = handler.listAll('claude', tmpDir);
      const extra = results.find((r) => r.name === 'extra-agent');
      expect(extra).toBeDefined();
      expect(extra!.layer).toBe('system'); // Extra repos are treated as system layer
    });
  });

  describe('sync', () => {
    it('copies resolved subagents to version home', () => {
      const versionHome = path.join(tmpDir, 'version-home');
      fs.mkdirSync(versionHome, { recursive: true });

      writeSubagent(userAgentsDir, 'agent-a', { name: 'agent-a', description: 'A' });
      writeSubagent(systemAgentsDir, 'agent-b', { name: 'agent-b', description: 'B' });

      handler.sync('claude', versionHome, tmpDir);

      const targetDir = path.join(versionHome, 'subagents');
      expect(fs.existsSync(targetDir)).toBe(true);

      const files = fs.readdirSync(targetDir);
      expect(files).toContain('agent-a.yaml');
      expect(files).toContain('agent-b.yaml');
    });

    it('clears existing subagents before syncing', () => {
      const versionHome = path.join(tmpDir, 'version-home');
      const targetDir = path.join(versionHome, 'subagents');
      fs.mkdirSync(targetDir, { recursive: true });

      // Pre-existing file that should be removed
      fs.writeFileSync(path.join(targetDir, 'old-agent.yaml'), 'name: old\ndescription: old');

      writeSubagent(userAgentsDir, 'new-agent', { name: 'new-agent', description: 'new' });

      handler.sync('claude', versionHome, tmpDir);

      const files = fs.readdirSync(targetDir);
      expect(files).toContain('new-agent.yaml');
      expect(files).not.toContain('old-agent.yaml');
    });

    it('preserves .yml extension when copying', () => {
      const versionHome = path.join(tmpDir, 'version-home');
      fs.mkdirSync(versionHome, { recursive: true });

      const ymlPath = path.join(userAgentsDir, 'subagents', 'yml-agent.yml');
      fs.writeFileSync(ymlPath, 'name: yml-agent\ndescription: yml');

      handler.sync('claude', versionHome, tmpDir);

      const targetDir = path.join(versionHome, 'subagents');
      const files = fs.readdirSync(targetDir);
      expect(files).toContain('yml-agent.yml');
    });

    it('handles project override during sync', () => {
      const versionHome = path.join(tmpDir, 'version-home');
      fs.mkdirSync(versionHome, { recursive: true });

      writeSubagent(systemAgentsDir, 'overridden', { name: 'overridden', description: 'system' });
      writeSubagent(projectAgentsDir, 'overridden', { name: 'overridden', description: 'project' });

      handler.sync('claude', versionHome, tmpDir);

      const targetDir = path.join(versionHome, 'subagents');
      const content = fs.readFileSync(path.join(targetDir, 'overridden.yaml'), 'utf-8');
      expect(content).toContain('description: project');
    });
  });
});
