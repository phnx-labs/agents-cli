import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as state from '../state.js';
import { WorkflowsHandler } from './workflows.js';

let tmpDir = '';
let projectAgentsDir = '';
let userWorkflowsDir = '';
let systemWorkflowsDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflows-handler-test-'));
  projectAgentsDir = path.join(tmpDir, 'project', '.agents');
  userWorkflowsDir = path.join(tmpDir, 'user', 'workflows');
  systemWorkflowsDir = path.join(tmpDir, 'system', 'workflows');

  fs.mkdirSync(path.join(projectAgentsDir, 'workflows'), { recursive: true });
  fs.mkdirSync(userWorkflowsDir, { recursive: true });
  fs.mkdirSync(systemWorkflowsDir, { recursive: true });

  vi.spyOn(state, 'getProjectAgentsDir').mockReturnValue(projectAgentsDir);
  vi.spyOn(state, 'getUserWorkflowsDir').mockReturnValue(userWorkflowsDir);
  vi.spyOn(state, 'getSystemWorkflowsDir').mockReturnValue(systemWorkflowsDir);
  vi.spyOn(state, 'getEnabledExtraRepos').mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeWorkflow(
  dir: string,
  name: string,
  fm: { name?: string; description: string; model?: string },
): string {
  const workflowDir = path.join(dir, name);
  fs.mkdirSync(workflowDir, { recursive: true });
  const frontmatter = [
    '---',
    ...(fm.name ? [`name: ${fm.name}`] : []),
    `description: ${fm.description}`,
    ...(fm.model ? [`model: ${fm.model}`] : []),
    '---',
  ].join('\n');
  fs.writeFileSync(path.join(workflowDir, 'WORKFLOW.md'), frontmatter);
  return workflowDir;
}

describe('WorkflowsHandler', () => {
  describe('kind', () => {
    it('returns workflow as the resource kind', () => {
      expect(WorkflowsHandler.kind).toBe('workflow');
    });
  });

  describe('format', () => {
    it('returns md for all agents', () => {
      expect(WorkflowsHandler.format('claude')).toBe('md');
      expect(WorkflowsHandler.format('codex')).toBe('md');
    });
  });

  describe('targetDir', () => {
    it('returns workflows for all agents', () => {
      expect(WorkflowsHandler.targetDir('claude')).toBe('workflows');
      expect(WorkflowsHandler.targetDir('codex')).toBe('workflows');
    });
  });

  describe('sync', () => {
    it('completes without error (intentional no-op)', () => {
      const versionHome = path.join(tmpDir, 'version-home');
      fs.mkdirSync(versionHome, { recursive: true });
      expect(() => WorkflowsHandler.sync('claude', versionHome, tmpDir)).not.toThrow();
    });
  });

  describe('listAll', () => {
    it('returns empty array when no workflows exist', () => {
      const results = WorkflowsHandler.listAll('claude', tmpDir);
      expect(results).toEqual([]);
    });

    it('reads workflow item fields from frontmatter', () => {
      writeWorkflow(userWorkflowsDir, 'my-workflow', {
        name: 'My Workflow',
        description: 'Does things',
        model: 'claude-opus-4-7',
      });

      const results = WorkflowsHandler.listAll('claude', tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('my-workflow');
      expect(results[0].item.name).toBe('My Workflow');
      expect(results[0].item.description).toBe('Does things');
      expect(results[0].item.model).toBe('claude-opus-4-7');
      expect(results[0].layer).toBe('user');
    });

    it('counts subagents from the subagents/ subdirectory', () => {
      const wfDir = writeWorkflow(userWorkflowsDir, 'multi-agent', { description: 'With subagents' });
      const subagentsDir = path.join(wfDir, 'subagents');
      fs.mkdirSync(subagentsDir, { recursive: true });
      fs.writeFileSync(path.join(subagentsDir, 'researcher.md'), '# Researcher');
      fs.writeFileSync(path.join(subagentsDir, 'writer.md'), '# Writer');

      const results = WorkflowsHandler.listAll('claude', tmpDir);
      expect(results[0].item.subagentCount).toBe(2);
    });

    it('project layer wins over user and system on name collision', () => {
      writeWorkflow(systemWorkflowsDir, 'shared', { description: 'system version' });
      writeWorkflow(userWorkflowsDir, 'shared', { description: 'user version' });
      writeWorkflow(path.join(projectAgentsDir, 'workflows'), 'shared', { description: 'project version' });

      const results = WorkflowsHandler.listAll('claude', tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].layer).toBe('project');
      expect(results[0].item.description).toBe('project version');
    });

    it('unions workflows from all layers when names differ', () => {
      writeWorkflow(systemWorkflowsDir, 'system-wf', { description: 'system' });
      writeWorkflow(userWorkflowsDir, 'user-wf', { description: 'user' });
      writeWorkflow(path.join(projectAgentsDir, 'workflows'), 'project-wf', { description: 'project' });

      const results = WorkflowsHandler.listAll('claude', tmpDir);
      expect(results).toHaveLength(3);
    });

    it('skips directories without WORKFLOW.md', () => {
      writeWorkflow(userWorkflowsDir, 'valid', { description: 'has WORKFLOW.md' });
      fs.mkdirSync(path.join(userWorkflowsDir, 'no-manifest'), { recursive: true });

      const results = WorkflowsHandler.listAll('claude', tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('valid');
    });

    it('skips hidden directories', () => {
      writeWorkflow(userWorkflowsDir, 'visible', { description: 'visible workflow' });
      writeWorkflow(userWorkflowsDir, '.hidden', { description: 'hidden workflow' });

      const results = WorkflowsHandler.listAll('claude', tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('visible');
    });

    it('sorts results alphabetically by directory name', () => {
      writeWorkflow(userWorkflowsDir, 'zebra', { description: 'z' });
      writeWorkflow(userWorkflowsDir, 'alpha', { description: 'a' });
      writeWorkflow(userWorkflowsDir, 'mango', { description: 'm' });

      const results = WorkflowsHandler.listAll('claude', tmpDir);
      expect(results.map(r => r.name)).toEqual(['alpha', 'mango', 'zebra']);
    });

    it('includes extra repos as system layer', () => {
      const extraDir = path.join(tmpDir, 'extra-repo');
      fs.mkdirSync(path.join(extraDir, 'workflows'), { recursive: true });
      writeWorkflow(path.join(extraDir, 'workflows'), 'extra-workflow', { description: 'from extra' });

      vi.spyOn(state, 'getEnabledExtraRepos').mockReturnValue([
        { alias: 'extra', dir: extraDir, url: 'https://example.com/extra' },
      ]);

      const results = WorkflowsHandler.listAll('claude', tmpDir);
      const extra = results.find(r => r.name === 'extra-workflow');
      expect(extra).toBeDefined();
      expect(extra!.layer).toBe('system');
    });
  });

  describe('resolve', () => {
    it('returns null when workflow does not exist in any layer', () => {
      const result = WorkflowsHandler.resolve('claude', 'nonexistent', tmpDir);
      expect(result).toBeNull();
    });

    it('returns project layer when same name exists in all layers', () => {
      writeWorkflow(systemWorkflowsDir, 'shared', { description: 'system' });
      writeWorkflow(userWorkflowsDir, 'shared', { description: 'user' });
      writeWorkflow(path.join(projectAgentsDir, 'workflows'), 'shared', { description: 'project' });

      const result = WorkflowsHandler.resolve('claude', 'shared', tmpDir);
      expect(result).not.toBeNull();
      expect(result!.layer).toBe('project');
      expect(result!.item.description).toBe('project');
    });

    it('falls back from user to system when project is missing', () => {
      writeWorkflow(systemWorkflowsDir, 'system-only', { description: 'system' });
      writeWorkflow(userWorkflowsDir, 'user-only', { description: 'user' });

      const userResult = WorkflowsHandler.resolve('claude', 'user-only', tmpDir);
      expect(userResult).not.toBeNull();
      expect(userResult!.layer).toBe('user');

      const systemResult = WorkflowsHandler.resolve('claude', 'system-only', tmpDir);
      expect(systemResult).not.toBeNull();
      expect(systemResult!.layer).toBe('system');
    });

    it('returns the correct path to the workflow directory', () => {
      writeWorkflow(userWorkflowsDir, 'my-wf', { description: 'test' });

      const result = WorkflowsHandler.resolve('claude', 'my-wf', tmpDir);
      expect(result).not.toBeNull();
      expect(result!.path).toBe(path.join(userWorkflowsDir, 'my-wf'));
    });

    it('returns correct item fields from resolved workflow', () => {
      writeWorkflow(userWorkflowsDir, 'full-wf', {
        name: 'Full Workflow',
        description: 'Complete',
        model: 'claude-sonnet-4-6',
      });

      const result = WorkflowsHandler.resolve('claude', 'full-wf', tmpDir);
      expect(result).not.toBeNull();
      expect(result!.item.name).toBe('Full Workflow');
      expect(result!.item.description).toBe('Complete');
      expect(result!.item.model).toBe('claude-sonnet-4-6');
    });
  });
});
