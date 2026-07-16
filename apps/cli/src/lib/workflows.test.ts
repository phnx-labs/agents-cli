import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  parseLoopBlock,
  parseWorkflowFrontmatter,
  listWorkflowsForAgent,
  resolveAllowedSubagents,
  pruneStaleWorkflowSubagents,
  ensureSubagentDispatchTool,
  syncWorkflowToVersion,
  transformWorkflowForKimi,
  transformWorkflowForAntigravity,
} from './workflows.js';

describe('parseLoopBlock — defensive coercion (issue #332)', () => {
  it('parses a well-formed loop block', () => {
    expect(parseLoopBlock({ until: 'signal', max_iterations: 3, budget: 500000, interval: '30m' }))
      .toEqual({ until: 'signal', max_iterations: 3, budget: 500000, interval: '30m' });
  });

  it('returns undefined when the block is absent or not an object', () => {
    expect(parseLoopBlock(undefined)).toBeUndefined();
    expect(parseLoopBlock(null)).toBeUndefined();
    expect(parseLoopBlock('signal')).toBeUndefined();
    expect(parseLoopBlock([1, 2])).toBeUndefined();
  });

  it('drops an unknown until value (only `signal` is valid)', () => {
    expect(parseLoopBlock({ until: 'whenever', max_iterations: 2 }))
      .toEqual({ max_iterations: 2 });
  });

  it('drops a non-integer / non-positive max_iterations', () => {
    expect(parseLoopBlock({ max_iterations: 2.5 })).toBeUndefined();
    expect(parseLoopBlock({ max_iterations: 0 })).toBeUndefined();
    expect(parseLoopBlock({ max_iterations: -3 })).toBeUndefined();
    expect(parseLoopBlock({ max_iterations: '5' })).toBeUndefined(); // string, not number
  });

  it('drops a non-positive or non-numeric budget', () => {
    expect(parseLoopBlock({ budget: 0 })).toBeUndefined();
    expect(parseLoopBlock({ budget: -1 })).toBeUndefined();
    expect(parseLoopBlock({ budget: 'lots' })).toBeUndefined();
  });

  it('drops a non-string interval', () => {
    expect(parseLoopBlock({ interval: 30 })).toBeUndefined();
    expect(parseLoopBlock({ interval: '0' })).toEqual({ interval: '0' });
  });

  it('returns undefined when an all-garbage block leaves no recognized field', () => {
    expect(parseLoopBlock({ until: 'nope', max_iterations: -1, budget: 'x', interval: 5 }))
      .toBeUndefined();
  });
});

describe('pruneStaleWorkflowSubagents — fail-closed cleanup (issue #401)', () => {
  function makeSharedDir(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shared-agents-'));
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body, 'utf-8');
    }
    return dir;
  }

  it('removes a stale non-permitted workflow subagent while preserving the user\'s own', () => {
    // Shared per-agent agents dir as left by a PRIOR unrestricted run: it holds
    // a workflow subagent (`danger.md`) that this scoped run does NOT permit,
    // plus the user's own hand-placed subagent (`myhelper.md`) and the permitted
    // `security.md`.
    const shared = makeSharedDir({
      'security.md': 'stale security',
      'danger.md': 'leftover from unrestricted run',
      'myhelper.md': 'user hand-placed subagent',
    });

    // The workflow declares subagents security + danger, but allows only security.
    const workflowSubagentFiles = ['security.md', 'danger.md'];
    const { allowedStems } = resolveAllowedSubagents(workflowSubagentFiles, ['security']);
    expect(allowedStems).toEqual(['security']);

    const pruned = pruneStaleWorkflowSubagents(shared, workflowSubagentFiles, allowedStems);

    // The unlisted workflow subagent is gone (fail-closed); it can no longer be
    // dispatched despite lingering from a prior run.
    expect(pruned).toEqual(['danger.md']);
    expect(fs.existsSync(path.join(shared, 'danger.md'))).toBe(false);

    // The user's own subagent — NOT part of the workflow's subagents/ — survives.
    expect(fs.existsSync(path.join(shared, 'myhelper.md'))).toBe(true);

    // The permitted subagent is left in place for the copy step to (re)write.
    expect(fs.existsSync(path.join(shared, 'security.md'))).toBe(true);

    fs.rmSync(shared, { recursive: true, force: true });
  });

  it('prunes every workflow subagent when allowedAgents is explicitly empty', () => {
    const shared = makeSharedDir({
      'security.md': 'stale',
      'danger.md': 'stale',
      'notes.md': 'user file',
    });
    const workflowSubagentFiles = ['security.md', 'danger.md'];
    const { allowedStems } = resolveAllowedSubagents(workflowSubagentFiles, []);
    expect(allowedStems).toEqual([]);

    const pruned = pruneStaleWorkflowSubagents(shared, workflowSubagentFiles, allowedStems);

    expect(pruned.sort()).toEqual(['danger.md', 'security.md']);
    expect(fs.existsSync(path.join(shared, 'security.md'))).toBe(false);
    expect(fs.existsSync(path.join(shared, 'danger.md'))).toBe(false);
    // The user's own file is untouched.
    expect(fs.existsSync(path.join(shared, 'notes.md'))).toBe(true);

    fs.rmSync(shared, { recursive: true, force: true });
  });

  it('prunes nothing on a fresh dir or when all subagents are permitted', () => {
    const shared = makeSharedDir({ 'security.md': 'present' });
    // allowedAgents absent -> everything permitted -> nothing pruned.
    const { allowedStems } = resolveAllowedSubagents(['security.md'], undefined);
    expect(pruneStaleWorkflowSubagents(shared, ['security.md'], allowedStems)).toEqual([]);
    expect(fs.existsSync(path.join(shared, 'security.md'))).toBe(true);
    fs.rmSync(shared, { recursive: true, force: true });

    // A shared dir that does not exist yet is a no-op, never a throw.
    expect(pruneStaleWorkflowSubagents(path.join(os.tmpdir(), 'agents-missing-xyz-401'), ['a.md'], [])).toEqual([]);
  });
});

describe('ensureSubagentDispatchTool — keep Task for orchestrators', () => {
  const base = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebFetch'];

  it('appends Task when the workflow ships subagents and Task is missing', () => {
    // This is the doc-gaps / blog-engine bug: a `tools:` list that omits Task
    // while shipping a subagents/ dir strips the orchestrator's only dispatch
    // path, so the run silently no-ops.
    expect(ensureSubagentDispatchTool(base, true)).toEqual([...base, 'Task']);
  });

  it('leaves the list unchanged when the workflow has no subagents', () => {
    const out = ensureSubagentDispatchTool(base, false);
    expect(out).toEqual(base);
    expect(out).not.toContain('Task');
  });

  it('does not duplicate Task when it is already listed', () => {
    const withTask = [...base, 'Task'];
    expect(ensureSubagentDispatchTool(withTask, true)).toEqual(withTask);
    expect(ensureSubagentDispatchTool(withTask, true).filter(t => t === 'Task')).toHaveLength(1);
  });

  it('does not mutate the input array', () => {
    const input = [...base];
    ensureSubagentDispatchTool(input, true);
    expect(input).toEqual(base);
  });
});

describe('parseWorkflowFrontmatter — loop block', () => {
  function writeWorkflow(frontmatter: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-wf-loop-test-'));
    fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), `---\n${frontmatter}\n---\nbody\n`, 'utf-8');
    return dir;
  }

  it('parses a declared loop block from real WORKFLOW.md frontmatter', () => {
    const dir = writeWorkflow([
      'name: cluster-feedback',
      'description: cluster mentions',
      'loop:',
      '  until: signal',
      '  max_iterations: 3',
      '  budget: 500000',
      '  interval: "0"',
    ].join('\n'));
    const fm = parseWorkflowFrontmatter(dir)!;
    expect(fm.loop).toEqual({ until: 'signal', max_iterations: 3, budget: 500000, interval: '0' });
  });

  it('leaves loop undefined when no loop block is present', () => {
    const dir = writeWorkflow('name: plain\ndescription: no loop');
    const fm = parseWorkflowFrontmatter(dir)!;
    expect(fm.loop).toBeUndefined();
  });

  it('drops a malformed loop block rather than passing a bad shape to the driver', () => {
    const dir = writeWorkflow([
      'name: bad',
      'description: bad loop',
      'loop:',
      '  until: forever',
      '  max_iterations: -1',
    ].join('\n'));
    const fm = parseWorkflowFrontmatter(dir)!;
    expect(fm.loop).toBeUndefined();
  });
});

describe('workflow native projections', () => {
  function writeWorkflow(body: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-wf-projection-'));
    fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), body, 'utf-8');
    return dir;
  }

  it('converts a workflow into a Kimi flow skill', () => {
    const dir = writeWorkflow('---\nname: Review Flow\ndescription: Review code\n---\n\nCheck the diff and report findings.');

    const skill = transformWorkflowForKimi(dir, 'review-flow');

    expect(skill).toContain('name: review-flow');
    expect(skill).toContain('type: flow');
    expect(skill).toContain('agents_workflow: review-flow');
    expect(skill).toContain('description: Review code');
    expect(skill).toContain('```d2');
    expect(skill).toContain('BEGIN -> step -> END');
    expect(skill).toContain('Check the diff and report findings.');
  });

  it('preserves an existing Mermaid diagram for Kimi flow skills', () => {
    const dir = writeWorkflow('---\nname: Mermaid Flow\ndescription: Has diagram\n---\n\n```mermaid\nflowchart TD\nBEGIN --> END\n```');

    const skill = transformWorkflowForKimi(dir, 'mermaid-flow');

    expect(skill).toContain('type: flow');
    expect(skill).toContain('```mermaid');
    expect(skill).toContain('BEGIN --> END');
  });

  it('syncs and lists only agents-cli managed Kimi workflow destinations', () => {
    const dir = writeWorkflow('---\nname: Native Flow\ndescription: Native projection\n---\n\nDo the work.');
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-kimi-wf-home-'));

    try {
      const nativeSkillDir = path.join(kimiHome, '.kimi-code', 'skills', 'native-flow');
      fs.mkdirSync(nativeSkillDir, { recursive: true });
      fs.writeFileSync(path.join(nativeSkillDir, 'SKILL.md'), '---\nname: Native Flow\ndescription: User-owned\ntype: flow\n---\n\n```d2\nBEGIN -> END\n```\n');
      expect(syncWorkflowToVersion(dir, 'native-flow', 'kimi', kimiHome).success).toBe(false);
      expect(listWorkflowsForAgent('kimi', kimiHome)).toEqual([]);

      fs.rmSync(nativeSkillDir, { recursive: true, force: true });
      expect(syncWorkflowToVersion(dir, 'native-flow', 'kimi', kimiHome).success).toBe(true);
      expect(fs.existsSync(path.join(kimiHome, '.kimi-code', 'skills', 'native-flow', 'SKILL.md'))).toBe(true);
      expect(listWorkflowsForAgent('kimi', kimiHome)).toEqual(['native-flow']);
    } finally {
      fs.rmSync(kimiHome, { recursive: true, force: true });
    }
  });

  it('converts a workflow into an Antigravity workflow markdown file', () => {
    const dir = writeWorkflow('---\nname: Ship Flow\ndescription: Ship safely\n---\n\n1. Test\n2. Release');

    const workflow = transformWorkflowForAntigravity(dir, 'ship-flow');

    // Required `description` frontmatter (agy's discovery contract) + ownership marker.
    expect(workflow).toContain('description: Ship safely');
    expect(workflow).toContain('name: Ship Flow');
    expect(workflow).toContain('agents_workflow: ship-flow');
    // Numbered-step body preserved verbatim below the frontmatter.
    expect(workflow).toContain('1. Test');
    expect(workflow).toContain('2. Release');
  });

  it('syncs Antigravity workflows to the shared HOME-global dir, guarding user-owned files', () => {
    const dir = writeWorkflow('---\nname: Global Flow\ndescription: Global projection\n---\n\nRun the steps.');
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-agy-home-'));
    const realHome = process.env.HOME;
    // Antigravity workflows are HOME-global (agy scans ~/.gemini/config/global_workflows/),
    // not version-isolated — so the writer ignores versionHome and resolves from $HOME.
    process.env.HOME = fakeHome;

    try {
      const globalDir = path.join(fakeHome, '.gemini', 'config', 'global_workflows');
      fs.mkdirSync(globalDir, { recursive: true });
      // A user-authored workflow of the same name (no ownership marker) must not be clobbered.
      fs.writeFileSync(path.join(globalDir, 'global-flow.md'), '---\ndescription: User-owned\n---\n\nHand-written.\n');
      // versionHome is intentionally unused for antigravity; pass a dummy to prove it.
      expect(syncWorkflowToVersion(dir, 'global-flow', 'antigravity', '/nonexistent-version-home').success).toBe(false);
      expect(listWorkflowsForAgent('antigravity', '/nonexistent-version-home')).toEqual([]);

      fs.rmSync(path.join(globalDir, 'global-flow.md'), { force: true });
      expect(syncWorkflowToVersion(dir, 'global-flow', 'antigravity', '/nonexistent-version-home').success).toBe(true);
      expect(fs.existsSync(path.join(globalDir, 'global-flow.md'))).toBe(true);
      expect(listWorkflowsForAgent('antigravity', '/nonexistent-version-home')).toEqual(['global-flow']);
      // Re-syncing an agents-cli-managed file is idempotent (marker matches).
      expect(syncWorkflowToVersion(dir, 'global-flow', 'antigravity', '/nonexistent-version-home').success).toBe(true);
    } finally {
      if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('Goose workflow recipe sync', () => {
  it('writes a recipe YAML and subrecipe YAML files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-goose-workflow-'));
    try {
      const workflowDir = path.join(root, 'wf');
      const subagentsDir = path.join(workflowDir, 'subagents');
      const versionHome = path.join(root, 'home');
      fs.mkdirSync(subagentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(workflowDir, 'WORKFLOW.md'),
        [
          '---',
          'name: Review workflow',
          'description: Review code',
          'model: claude-sonnet-4',
          'allowedAgents:',
          '  - reviewer',
          '---',
          'Coordinate the review.',
          '',
        ].join('\n'),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(subagentsDir, 'reviewer.md'),
        '---\nname: reviewer\ndescription: Reviews code\n---\n\nInspect code changes.',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(subagentsDir, 'ignored.md'),
        '---\nname: ignored\ndescription: Ignored\n---\n\nDo not include.',
        'utf-8'
      );

      const result = syncWorkflowToVersion(workflowDir, 'review-wf', 'goose', versionHome);
      expect(result).toEqual({ success: true });

      const recipePath = path.join(versionHome, '.config', 'goose', 'recipes', 'review-wf.yaml');
      const recipe = yaml.parse(fs.readFileSync(recipePath, 'utf-8'));
      expect(recipe).toMatchObject({
        version: '1.0.0',
        title: 'Review workflow',
        description: 'Review code',
        instructions: 'Coordinate the review.',
        prompt: 'Coordinate the review.',
        settings: { goose_model: 'claude-sonnet-4' },
      });
      expect(recipe.sub_recipes).toEqual([{
        name: 'reviewer',
        path: './review-wf.subrecipes/reviewer.yaml',
        description: 'Workflow subrecipe reviewer',
      }]);

      const subrecipe = yaml.parse(fs.readFileSync(path.join(versionHome, '.config', 'goose', 'recipes', 'review-wf.subrecipes', 'reviewer.yaml'), 'utf-8'));
      expect(subrecipe).toMatchObject({
        version: '1.0.0',
        title: 'reviewer',
        description: 'Reviews code',
        instructions: 'Inspect code changes.',
      });
      expect(fs.existsSync(path.join(versionHome, '.config', 'goose', 'recipes', 'review-wf.subrecipes', 'ignored.yaml'))).toBe(false);
      expect(listWorkflowsForAgent('goose', versionHome)).toEqual(['review-wf']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
