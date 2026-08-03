import { describe, expect, it } from 'vitest';
import {
  bucketKey,
  classifyBashCommand,
  detectBashMilestone,
  tokenizeBash,
  categoryLabel,
} from './bash-command.js';

describe('tokenizeBash', () => {
  it('splits a simple command into tokens', () => {
    expect(tokenizeBash('git status')).toEqual([['git', 'status']]);
  });

  it('splits on && while respecting quotes', () => {
    expect(tokenizeBash('git add . && git commit -m "hello world"')).toEqual([
      ['git', 'add', '.'],
      ['git', 'commit', '-m', 'hello world'],
    ]);
  });

  it('splits on || and ;', () => {
    expect(tokenizeBash('a || b; c')).toEqual([['a'], ['b'], ['c']]);
  });

  it('splits on pipes', () => {
    expect(tokenizeBash('cat file | grep x | wc -l')).toEqual([
      ['cat', 'file'],
      ['grep', 'x'],
      ['wc', '-l'],
    ]);
  });

  it('unwraps ssh wrappers', () => {
    expect(tokenizeBash('ssh host "ls -la /tmp"')).toEqual([['ls', '-la', '/tmp']]);
  });

  it('unwraps env prefixes', () => {
    expect(tokenizeBash('NODE_ENV=test bun test')).toEqual([['bun', 'test']]);
  });

  it('unwraps sudo/time prefixes', () => {
    expect(tokenizeBash('sudo -S apt update')).toEqual([['apt', 'update']]);
  });

  it('unwraps sudo with a value-taking flag (-u user)', () => {
    expect(tokenizeBash('sudo -u deploy apt install foo')).toEqual([['apt', 'install', 'foo']]);
  });

  it('unwraps env prefixes whose value is a quoted string with spaces', () => {
    expect(tokenizeBash('GIT_AUTHOR_NAME="Jane Doe" git commit -m "automated fix"')).toEqual([
      ['git', 'commit', '-m', 'automated fix'],
    ]);
    expect(tokenizeBash("GIT_AUTHOR_NAME='Jane Doe' GIT_AUTHOR_EMAIL=bot@x.com git commit -m x")).toEqual([
      ['git', 'commit', '-m', 'x'],
    ]);
  });

  it('unwraps cd && prefixes', () => {
    expect(tokenizeBash('cd /repo && git status')).toEqual([['git', 'status']]);
  });

  it('unwraps npx/bunx prefixes', () => {
    expect(tokenizeBash('npx -y vitest run')).toEqual([['vitest', 'run']]);
  });

  it('returns an empty array for empty input', () => {
    expect(tokenizeBash('')).toEqual([]);
    expect(tokenizeBash('   ')).toEqual([]);
  });
});

describe('classifyBashCommand', () => {
  it('classifies git with subcommand', () => {
    expect(classifyBashCommand('git commit -m fix')).toEqual({
      tool: 'git',
      category: 'vcs',
      subcommand: 'commit',
      action: 'working in git',
      summary: 'git commit',
      signal: 'mid',
    });
  });

  it('skips leading git flags to find subcommand', () => {
    expect(classifyBashCommand('git -C /repo status')).toEqual({
      tool: 'git',
      category: 'vcs',
      subcommand: 'status',
      action: 'working in git',
      summary: 'git status',
      signal: 'mid',
    });
  });

  it('skips a value-taking flag on gh (-R owner/repo)', () => {
    expect(classifyBashCommand('gh -R owner/repo pr create --title x')).toMatchObject({
      tool: 'gh',
      subcommand: 'pr',
      summary: 'gh pr',
    });
  });

  it('skips a value-taking flag on bun (--cwd dir)', () => {
    expect(classifyBashCommand('bun --cwd apps/cli test')).toMatchObject({
      tool: 'bun',
      subcommand: 'test',
      summary: 'bun test',
    });
  });

  it('skips per-tool value flags for two-level tools not in the registry', () => {
    // kubectl -n <ns> and docker -H <host> take a value; the subcommand follows.
    expect(classifyBashCommand('kubectl -n prod get pods')).toMatchObject({
      tool: 'kubectl',
      subcommand: 'get',
      summary: 'kubectl get',
    });
    expect(classifyBashCommand('docker -H tcp://1.2.3.4:2375 ps')).toMatchObject({
      tool: 'docker',
      subcommand: 'ps',
      summary: 'docker ps',
    });
    expect(classifyBashCommand('openclaw browser profiles')).toMatchObject({
      tool: 'openclaw',
      subcommand: 'browser',
    });
  });

  it('classifies ffmpeg', () => {
    expect(classifyBashCommand('ffmpeg -i a.mp4 b.mp4')).toEqual({
      tool: 'ffmpeg',
      category: 'media',
      subcommand: '',
      action: 'using ffmpeg',
      summary: 'ffmpeg',
      signal: 'high',
    });
  });

  it('classifies realesrgan aliases', () => {
    expect(classifyBashCommand('realesrgan-ncnn-vulkan -i in.png -o out.png')).toEqual({
      tool: 'realesrgan',
      category: 'upscaling',
      subcommand: '',
      action: 'upscaling with realesrgan',
      summary: 'realesrgan',
      signal: 'high',
    });
  });

  it('classifies probe tools', () => {
    expect(classifyBashCommand('ls -la /tmp')).toMatchObject({
      tool: 'ls',
      category: 'probe',
      action: 'listing files',
    });
  });

  it('falls back to other for unknown executables', () => {
    expect(classifyBashCommand('./custom-tool arg')).toEqual({
      tool: 'custom-tool',
      category: 'other',
      subcommand: '',
      action: 'running command',
      summary: 'custom-tool',
      signal: 'low',
    });
  });
});

describe('bucketKey', () => {
  it('groups two-level tools by subcommand', () => {
    expect(bucketKey('git commit')).toBe('git commit');
    expect(bucketKey('git push')).toBe('git push');
  });

  it('groups single-level tools by executable', () => {
    expect(bucketKey('ffmpeg -i a.mp4 b.mp4')).toBe('ffmpeg');
    expect(bucketKey('ls -la')).toBe('ls');
  });

  it('returns the executable for unknown commands', () => {
    expect(bucketKey('./something-weird')).toBe('something-weird');
  });

  it('buckets by real subcommand, skipping value-taking flags', () => {
    // `git -C /repo commit` must bucket as `git commit`, never `git -C`.
    expect(bucketKey('git -C /repo commit -m "fix"')).toBe('git commit');
    expect(bucketKey('gh -R owner/repo pr create --title x')).toBe('gh pr');
    // docker/kubectl carry their own value flags, not git's.
    expect(bucketKey('kubectl -n prod get pods')).toBe('kubectl get');
    expect(bucketKey('docker -H tcp://1.2.3.4:2375 ps')).toBe('docker ps');
  });

  it('prefixes remote-wrapped commands with ssh→', () => {
    expect(bucketKey('ssh host "git push"')).toBe('ssh→git push');
    expect(bucketKey('ssh host "ls -la"')).toBe('ssh→ls');
    expect(bucketKey('scp a host:/b')).toBe('ssh→scp');
  });
});

describe('detectBashMilestone', () => {
  it('detects video.rendered for ffmpeg with output', () => {
    expect(detectBashMilestone('ffmpeg -i a.mp4 -c:v libx264 b.mp4')).toEqual({
      event: 'video.rendered',
      detail: 'ffmpeg render',
    });
  });

  it('detects video.converted for ffmpeg without clear output', () => {
    expect(detectBashMilestone('ffmpeg -i a.mp4 -c copy output.avi')).toEqual({
      event: 'video.rendered',
      detail: 'ffmpeg render',
    });
  });

  it('detects image.upscaled', () => {
    expect(detectBashMilestone('realesrgan-ncnn-vulkan -i in.png -o out.png')).toEqual({
      event: 'image.upscaled',
      detail: 'upscaling with realesrgan',
    });
  });

  it('detects metadata.edited', () => {
    expect(detectBashMilestone('exiftool -Artist=me photo.jpg')).toEqual({
      event: 'metadata.edited',
      detail: 'editing exif metadata',
    });
  });

  it('detects commit.created', () => {
    expect(detectBashMilestone('git commit -m fix')).toEqual({
      event: 'commit.created',
      detail: 'git commit',
    });
  });

  it('detects pushed', () => {
    expect(detectBashMilestone('git push origin main')).toEqual({
      event: 'pushed',
      detail: 'git push',
    });
  });

  it('detects worktree.created', () => {
    expect(detectBashMilestone('git worktree add -b feat /repo/.agents/worktrees/feat')).toEqual({
      event: 'worktree.created',
      detail: 'git worktree add',
    });
  });

  it('detects pr.opened', () => {
    expect(detectBashMilestone('gh pr create --title x')).toEqual({
      event: 'pr.opened',
      detail: 'gh pr create',
    });
  });

  it('detects commit.created behind an env-var prefix with a quoted value', () => {
    expect(detectBashMilestone('GIT_AUTHOR_NAME="Jane Doe" git commit -m "x"')).toEqual({
      event: 'commit.created',
      detail: 'git commit',
    });
  });

  it('detects pr.opened behind gh -R owner/repo', () => {
    expect(detectBashMilestone('gh -R owner/repo pr create --title x')).toEqual({
      event: 'pr.opened',
      detail: 'gh pr create',
    });
  });

  it('returns null for routine commands', () => {
    expect(detectBashMilestone('ls -la /tmp')).toBeNull();
    expect(detectBashMilestone('cat file.txt')).toBeNull();
  });
});

describe('categoryLabel', () => {
  it('returns human labels', () => {
    expect(categoryLabel('vcs')).toBe('Version control');
    expect(categoryLabel('media')).toBe('Media');
    expect(categoryLabel('other')).toBe('Other');
  });
});
