import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseLoopBlock,
  parseWorkflowFrontmatter,
  listWorkflowsForAgent,
  resolveAllowedSubagents,
  pruneStaleWorkflowSubagents,
  syncWorkflowToVersion,
  transformWorkflowForKimi,
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
});
