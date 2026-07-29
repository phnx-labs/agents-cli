import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as yaml from 'yaml';
import { syncProjectResourcesToAgent } from './project-resources.js';

const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-project-resources-'));
  tempDirs.push(dir);
  return path.join(dir, 'repo');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('syncProjectResourcesToAgent', () => {
  it('syncs project skills into native skill agents project config dirs', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    const skillDir = path.join(projectAgentsDir, 'skills', 'myskill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'Project skill.', 'utf-8');

    const gemini = syncProjectResourcesToAgent('gemini', '0.36.0', projectAgentsDir);
    const goose = syncProjectResourcesToAgent('goose', '1.25.0', projectAgentsDir);

    expect(gemini.synced).toEqual(['skills/myskill']);
    expect(gemini.skipped).toEqual([]);
    expect(goose.synced).toEqual(['skills/myskill']);
    expect(goose.skipped).toEqual([]);

    expect(fs.readFileSync(path.join(project, '.gemini', 'skills', 'myskill', 'SKILL.md'), 'utf-8')).toBe('Project skill.');
    expect(fs.readFileSync(path.join(project, '.config', 'goose', 'skills', 'myskill', 'SKILL.md'), 'utf-8')).toBe('Project skill.');

    const geminiManifest = JSON.parse(fs.readFileSync(path.join(project, '.gemini', '.agents-managed.json'), 'utf-8')) as { paths: string[] };
    const gooseManifest = JSON.parse(fs.readFileSync(path.join(project, '.config', 'goose', '.agents-managed.json'), 'utf-8')) as { paths: string[] };
    expect(geminiManifest.paths).toEqual(['skills/myskill']);
    expect(gooseManifest.paths).toEqual(['skills/myskill']);
  });

  it('cleans up a manifest written on Windows, with backslash-separated paths', () => {
    // .agents-managed.json travels with the version-controlled project dir, so
    // a manifest minted by a Windows build (or by a pre-fix version of this
    // code) can be read on POSIX. Its entries must still match, or the cleanup
    // pass silently leaves previously managed files behind.
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    fs.mkdirSync(projectAgentsDir, { recursive: true });

    // A file this manifest claims to manage, which is no longer backed by any
    // project resource — the next sync must remove it.
    const geminiRoot = path.join(project, '.gemini');
    const stale = path.join(geminiRoot, 'skills', 'gone');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'SKILL.md'), 'stale', 'utf-8');
    fs.writeFileSync(
      path.join(geminiRoot, '.agents-managed.json'),
      // Backslashes exactly as a Windows run would have persisted them.
      JSON.stringify({ v: 1, paths: ['skills\\gone'] }),
      'utf-8',
    );

    syncProjectResourcesToAgent('gemini', '0.36.0', projectAgentsDir);

    expect(fs.existsSync(stale)).toBe(false);
  });

  it('tracks Goose workflow subrecipes in the manifest from the first sync', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    const workflowDir = path.join(projectAgentsDir, 'workflows', 'review-wf');
    const subagentsDir = path.join(workflowDir, 'subagents');
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
      'utf-8',
    );
    fs.writeFileSync(
      path.join(subagentsDir, 'reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews code\n---\n\nInspect code changes.',
      'utf-8',
    );

    const first = syncProjectResourcesToAgent('goose', '1.0.0', projectAgentsDir);
    expect(first.synced).toContain('workflows/review-wf');
    expect(first.skipped).toEqual([]);

    const recipePath = path.join(project, '.config', 'goose', 'recipes', 'review-wf.yaml');
    const subrecipesPath = path.join(project, '.config', 'goose', 'recipes', 'review-wf.subrecipes');
    expect(fs.existsSync(recipePath)).toBe(true);
    expect(fs.existsSync(subrecipesPath)).toBe(true);

    const manifestPath = path.join(project, '.config', 'goose', '.agents-managed.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { paths: string[] };
    expect(manifest.paths).toContain('recipes/review-wf.yaml');
    expect(manifest.paths).toContain('recipes/review-wf.subrecipes');

    const second = syncProjectResourcesToAgent('goose', '1.0.0', projectAgentsDir);
    expect(second.synced).toContain('workflows/review-wf');
    expect(second.skipped).toEqual([]);
  });

  it('clears the Kimi parent subagent index when the last project subagent is removed', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    const subagentDir = path.join(projectAgentsDir, 'subagents', 'reviewer');
    fs.mkdirSync(subagentDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentDir, 'AGENT.md'),
      '---\nname: reviewer\ndescription: Reviews diffs\n---\n\nReview the diff.',
      'utf-8',
    );

    const first = syncProjectResourcesToAgent('kimi', '0.1.0', projectAgentsDir);

    const agentsDir = path.join(project, '.kimi-code', 'agents');
    const parentPath = path.join(agentsDir, '_agents-cli.yaml');
    expect(first.synced).toContain('subagents/reviewer');
    expect(fs.existsSync(path.join(agentsDir, 'reviewer.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'reviewer.system.md'))).toBe(true);
    let parent = yaml.parse(fs.readFileSync(parentPath, 'utf-8')) as { agent?: { subagents?: Record<string, unknown> } };
    expect(parent.agent?.subagents?.reviewer).toBeDefined();

    fs.rmSync(subagentDir, { recursive: true, force: true });
    const second = syncProjectResourcesToAgent('kimi', '0.1.0', projectAgentsDir);

    expect(second.synced).toEqual([]);
    expect(fs.existsSync(path.join(agentsDir, 'reviewer.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, 'reviewer.system.md'))).toBe(false);
    parent = yaml.parse(fs.readFileSync(parentPath, 'utf-8')) as { agent?: { subagents?: Record<string, unknown> } };
    expect(parent.agent?.subagents).toEqual({});
    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.kimi-code', '.agents-managed.json'), 'utf-8')) as { paths: string[] };
    expect(manifest.paths).toEqual(['agents/_agents-cli.yaml']);
  });
});
