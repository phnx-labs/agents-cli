import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as yaml from 'yaml';
import { formatKeptProjectResources, managedGitignoreEntries, syncProjectResourcesToAgent } from './project-resources.js';

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

describe('syncProjectResourcesToAgent — self-managed .gitignore', () => {
  // Build a project that is a git repo (has .git) with one project command.
  function makeRepoWithCommand(): { project: string; projectAgentsDir: string; gitignore: string } {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    const command = path.join(projectAgentsDir, 'commands', 'ping.md');
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, 'Ping from the project.', 'utf-8');
    return { project, projectAgentsDir, gitignore: path.join(project, '.gitignore') };
  }

  it('ignores the generated per-harness dir, anchored and scoped to that dir', () => {
    const { project, projectAgentsDir, gitignore } = makeRepoWithCommand();
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);

    const gi = fs.readFileSync(gitignore, 'utf-8');
    expect(gi).toContain('# >>> agents-cli project resources: cursor');
    expect(gi).toContain('# <<< agents-cli project resources: cursor <<<');
    // Every entry is anchored (/) and lives under the harness root — never
    // outside it, and never a bare unanchored root that could match elsewhere.
    const entries = gi.split('\n').filter((l) => l.startsWith('/'));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.startsWith('/.cursor/')).toBe(true);
    // The generated file is actually covered by an entry.
    expect(gi).toContain('/.cursor/commands/ping.md');
  });

  it('does NOT create a .gitignore in a non-git directory', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    const command = path.join(projectAgentsDir, 'commands', 'ping.md');
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, 'Ping.', 'utf-8');

    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    expect(fs.existsSync(path.join(project, '.gitignore'))).toBe(false);
  });

  it('amends an existing .gitignore, preserving hand-written rules', () => {
    const { projectAgentsDir, gitignore } = makeRepoWithCommand();
    fs.writeFileSync(gitignore, 'node_modules/\n.env\n', 'utf-8');

    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    const gi = fs.readFileSync(gitignore, 'utf-8');
    expect(gi).toContain('node_modules/');
    expect(gi).toContain('.env');
    expect(gi).toContain('# >>> agents-cli project resources: cursor');
    // Hand-written rules come first, the managed block is appended after them.
    expect(gi.indexOf('node_modules/')).toBeLessThan(gi.indexOf('# >>> agents-cli'));
  });

  it('is idempotent — a second sync leaves .gitignore byte-for-byte identical', () => {
    const { projectAgentsDir, gitignore } = makeRepoWithCommand();
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    const first = fs.readFileSync(gitignore, 'utf-8');
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    const second = fs.readFileSync(gitignore, 'utf-8');
    expect(second).toBe(first);
  });

  it('drops resource entries but keeps the manifest ignored when the source resources are gone', () => {
    const { projectAgentsDir, gitignore } = makeRepoWithCommand();
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    expect(fs.readFileSync(gitignore, 'utf-8')).toContain('/.cursor/commands/ping.md');

    // Remove the project command, then re-sync. The sync still leaves an
    // (emptied) .agents-managed.json in the harness dir, so the block must NOT
    // vanish — it shrinks to just the manifest entry, keeping the dir clean.
    fs.rmSync(path.join(projectAgentsDir, 'commands', 'ping.md'));
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    const gi = fs.readFileSync(gitignore, 'utf-8');
    expect(gi).not.toContain('/.cursor/commands/ping.md');
    expect(gi).toContain('/.cursor/.agents-managed.json');
  });

  it('keeps a hand-written rule intact when resources are removed', () => {
    const { projectAgentsDir, gitignore } = makeRepoWithCommand();
    fs.writeFileSync(gitignore, 'dist/\n', 'utf-8');
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    fs.rmSync(path.join(projectAgentsDir, 'commands', 'ping.md'));
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    const gi = fs.readFileSync(gitignore, 'utf-8');
    expect(gi).toContain('dist/');
    expect(gi).not.toContain('/.cursor/commands/ping.md');
  });

  it('managedGitignoreEntries drops any path that escapes the harness dir', () => {
    // grok writes commands back into the tracked .agents/ tree via a ../ subdir
    // (commandsSubdir = ../.agents/commands). Ignoring tracked source is exactly
    // the wrong move — the escape guard must drop those, keep in-root paths.
    const projectRoot = path.join(os.tmpdir(), 'proj');
    const agentRoot = path.join(projectRoot, '.grok');
    const entries = managedGitignoreEntries(agentRoot, projectRoot, [
      'commands/ok.md',
      path.join('..', '.agents', 'commands', 'leak.md'),
      path.join('..', '..', 'outside.md'),
    ]);
    expect(entries).toContain('/.grok/commands/ok.md');
    expect(entries.every((e) => !e.includes('.agents/commands'))).toBe(true);
    expect(entries.every((e) => !e.includes('..'))).toBe(true);
    expect(entries).toHaveLength(1);
  });

  it('re-syncing one harness does not reorder another harness block (no churn)', () => {
    // The blocker regression: strip-then-append moved the re-synced agent's
    // block to the end, bumping the other agent every launch. In-place
    // replacement must leave a multi-harness .gitignore byte-stable.
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    const command = path.join(projectAgentsDir, 'commands', 'ping.md');
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, 'Ping.', 'utf-8');
    const skillDir = path.join(projectAgentsDir, 'skills', 'myskill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'Project skill.', 'utf-8');
    const gitignore = path.join(project, '.gitignore');

    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    syncProjectResourcesToAgent('opencode', '1.0.0', projectAgentsDir);
    const afterBoth = fs.readFileSync(gitignore, 'utf-8');
    // Both harness blocks are present.
    expect(afterBoth).toContain('agents-cli project resources: cursor');
    expect(afterBoth).toContain('agents-cli project resources: opencode');

    // Re-sync the first harness: the file must not change at all.
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    expect(fs.readFileSync(gitignore, 'utf-8')).toBe(afterBoth);
    // And re-syncing the second is also a no-op.
    syncProjectResourcesToAgent('opencode', '1.0.0', projectAgentsDir);
    expect(fs.readFileSync(gitignore, 'utf-8')).toBe(afterBoth);
  });

  it('never truncates the file when the managed block has an orphaned begin marker', () => {
    const { projectAgentsDir, gitignore } = makeRepoWithCommand();
    // A begin marker with NO matching end (hand-truncated / botched merge),
    // with a legitimate hand-written rule below it.
    const orphaned =
      'node_modules/\n' +
      '# >>> agents-cli project resources: cursor (generated on launch — do not edit) >>>\n' +
      '/.cursor/commands/ping.md\n' +
      'dist/\n';
    fs.writeFileSync(gitignore, orphaned, 'utf-8');

    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    const gi = fs.readFileSync(gitignore, 'utf-8');
    // The hand-written rule below the orphaned marker must survive untouched.
    expect(gi).toContain('dist/');
    expect(gi).toContain('node_modules/');
  });

  it('ignores the .agents-managed.json manifest too, not just the synced resources', () => {
    const { projectAgentsDir, gitignore } = makeRepoWithCommand();
    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);
    // The manifest file the sync writes into the harness dir must be ignored —
    // otherwise the dir still shows as untracked on the strength of that one file.
    expect(fs.readFileSync(gitignore, 'utf-8')).toContain('/.cursor/.agents-managed.json');
  });

  it('leaves the whole generated harness dir clean in a REAL git status (the actual goal)', () => {
    // The assertion the earlier tests missed: not "a block exists" but "git no
    // longer reports the harness dir". Uses a real git repo so gitignore is
    // actually evaluated over every file the sync wrote, manifest included.
    const project = makeTempProject();
    fs.mkdirSync(project, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project }).toString();
    git('init', '-q');
    git('config', 'user.email', 'demo@x.co');
    git('config', 'user.name', 'demo');
    const projectAgentsDir = path.join(project, '.agents');
    const command = path.join(projectAgentsDir, 'commands', 'ping.md');
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.writeFileSync(command, 'Ping.', 'utf-8');
    const skillDir = path.join(projectAgentsDir, 'skills', 'demoskill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demoskill\n---\n', 'utf-8');
    git('add', '.agents');
    git('commit', '-qm', 'project source');

    syncProjectResourcesToAgent('cursor', '2026.07.23-e383d2b', projectAgentsDir);

    const status = git('status', '--porcelain').split('\n').filter(Boolean);
    // The generated .cursor/ dir (commands, skills, AND its manifest) is fully
    // ignored — the only new untracked path is .gitignore itself.
    expect(status.some((l) => l.includes('.cursor'))).toBe(false);
    expect(status.every((l) => l.includes('.gitignore'))).toBe(true);
  });
});
