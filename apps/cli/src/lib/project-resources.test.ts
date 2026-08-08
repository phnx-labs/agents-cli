import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as yaml from 'yaml';
import { formatKeptProjectResources, syncProjectResourcesToAgent } from './project-resources.js';

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
  it('syncs Cursor project commands to both native and generated-skill surfaces', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    const command = path.join(projectAgentsDir, 'commands', 'ping.md');
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, 'Ping from the project.', 'utf-8');

    const result = syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);

    expect(result.synced).toEqual(['commands/ping']);
    expect(fs.readFileSync(path.join(project, '.cursor', 'commands', 'ping.md'), 'utf-8')).toBe('Ping from the project.');
    expect(fs.readFileSync(path.join(project, '.cursor', 'skills', 'ping', 'SKILL.md'), 'utf-8')).toContain('agents_command: "ping"');
  });

  it('skips hard-deprecated gemini when syncing project resources', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    const skillDir = path.join(projectAgentsDir, 'skills', 'myskill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'Project skill.', 'utf-8');

    const gemini = syncProjectResourcesToAgent('gemini', '0.36.0', projectAgentsDir);

    expect(gemini.synced).toEqual([]);
    expect(gemini.skipped).toEqual([]);
    expect(fs.existsSync(path.join(project, '.gemini'))).toBe(false);
  });

  it('syncs project skills into native skill agents project config dirs', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    const skillDir = path.join(projectAgentsDir, 'skills', 'myskill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'Project skill.', 'utf-8');

    const goose = syncProjectResourcesToAgent('goose', '1.25.0', projectAgentsDir);

    expect(goose.synced).toEqual(['skills/myskill']);
    expect(goose.skipped).toEqual([]);

    expect(fs.readFileSync(path.join(project, '.config', 'goose', 'skills', 'myskill', 'SKILL.md'), 'utf-8')).toBe('Project skill.');

    const gooseManifest = JSON.parse(fs.readFileSync(path.join(project, '.config', 'goose', '.agents-managed.json'), 'utf-8')) as { paths: string[] };
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
    const gooseRoot = path.join(project, '.config', 'goose');
    const stale = path.join(gooseRoot, 'skills', 'gone');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'SKILL.md'), 'stale', 'utf-8');
    fs.writeFileSync(
      path.join(gooseRoot, '.agents-managed.json'),
      // Backslashes exactly as a Windows run would have persisted them.
      JSON.stringify({ v: 1, paths: ['skills\\gone'] }),
      'utf-8',
    );

    syncProjectResourcesToAgent('goose', '1.25.0', projectAgentsDir);

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

  it('removes the Kimi subagent markdown when the last project subagent is removed', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    const subagentDir = path.join(projectAgentsDir, 'subagents', 'reviewer');
    fs.mkdirSync(subagentDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentDir, 'AGENT.md'),
      '---\nname: reviewer\ndescription: Reviews diffs\n---\n\nReview the diff.',
      'utf-8',
    );

    const first = syncProjectResourcesToAgent('kimi', '0.29.0', projectAgentsDir);

    const agentsDir = path.join(project, '.kimi-code', 'agents');
    expect(first.synced).toContain('subagents/reviewer');
    // One Claude-shaped markdown file; no yaml pair and no parent index.
    expect(fs.existsSync(path.join(agentsDir, 'reviewer.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'reviewer.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, '_agents-cli.yaml'))).toBe(false);

    fs.rmSync(subagentDir, { recursive: true, force: true });
    const second = syncProjectResourcesToAgent('kimi', '0.29.0', projectAgentsDir);

    expect(second.synced).toEqual([]);
    expect(fs.existsSync(path.join(agentsDir, 'reviewer.md'))).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.kimi-code', '.agents-managed.json'), 'utf-8')) as { paths: string[] };
    expect(manifest.paths).toEqual([]);
  });

  it('reports files it left alone in the result, without printing one warning per file', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    for (const name of ['debug', 'product', 'prune']) {
      const command = path.join(projectAgentsDir, 'commands', `${name}.md`);
      fs.mkdirSync(path.dirname(command), { recursive: true });
      fs.writeFileSync(command, `Project ${name}.`, 'utf-8');
      const existing = path.join(project, '.claude', 'commands', `${name}.md`);
      fs.mkdirSync(path.dirname(existing), { recursive: true });
      fs.writeFileSync(existing, `Mine: ${name}.`, 'utf-8');
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = syncProjectResourcesToAgent('claude', '2.1.143', projectAgentsDir);

      expect(result.skipped.sort()).toEqual([
        path.join('.claude', 'commands', 'debug.md'),
        path.join('.claude', 'commands', 'product.md'),
        path.join('.claude', 'commands', 'prune.md'),
      ]);
      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      // The user's own files survive untouched.
      expect(fs.readFileSync(path.join(project, '.claude', 'commands', 'debug.md'), 'utf-8')).toBe('Mine: debug.');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

describe('formatKeptProjectResources', () => {
  it('says nothing when nothing was kept', () => {
    expect(formatKeptProjectResources([])).toBeNull();
  });

  it('names a lone file in full', () => {
    expect(formatKeptProjectResources(['.claude/commands/debug.md'])).toBe(
      'Kept your existing .claude/commands/debug.md',
    );
  });

  it('folds one directory into a single line with a preview', () => {
    const kept = ['debug', 'product', 'prune', 'video-k3z', 'doc-gaps', 'image-nbp']
      .map((n) => `.claude/commands/${n}.md`);
    expect(formatKeptProjectResources(kept)).toBe(
      'Kept 6 of your own files in .claude/commands: debug.md, doc-gaps.md, image-nbp.md, +3 more',
    );
  });

  it('counts per directory when several are involved', () => {
    expect(formatKeptProjectResources([
      '.claude/commands/debug.md',
      '.claude/commands/prune.md',
      '.claude/skills/rqa',
    ])).toBe('Kept 3 of your own files in .claude/commands (2), .claude/skills (1)');
  });

  it('normalizes Windows separators so the line reads the same on every platform', () => {
    expect(formatKeptProjectResources(['.claude\\commands\\debug.md', '.claude\\commands\\prune.md'])).toBe(
      'Kept 2 of your own files in .claude/commands: debug.md, prune.md',
    );
  });
});
