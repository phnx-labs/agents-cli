import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveRepoTarget,
  collectRepoKind,
  repoManifestSummary,
  repoGitInfo,
  pathSize,
  formatBytes,
  summarizeHook,
  summarizeMcp,
  hookManifestByScript,
  wrapJoined,
} from './inspect.js';
import type { ManifestHook } from '../lib/types.js';
import { getUserAgentsDir, getSystemAgentsDir } from '../lib/state.js';
import { stringWidth } from '../lib/session/width.js';

const tempDirs: string[] = [];

/** A fake project repo: <root>/.agents/ with commands + a skill bundle. */
function makeProjectRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-inspect-'));
  tempDirs.push(root);
  const agentsDir = path.join(root, '.agents');
  fs.mkdirSync(path.join(agentsDir, 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, 'commands', 'ship.md'),
    '---\ndescription: Ship the thing\n---\n\nShip it.\n',
  );
  fs.writeFileSync(path.join(agentsDir, 'commands', 'plain.md'), '# Plain command\n\nbody\n');
  const skillDir = path.join(agentsDir, 'skills', 'deploy');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: deploy\ndescription: Deploy services\n---\n\nSteps.\n',
  );
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveRepoTarget', () => {
  it('maps the built-in layer names to their roots', () => {
    expect(resolveRepoTarget('user')).toEqual({ label: 'user', root: getUserAgentsDir() });
    expect(resolveRepoTarget('system')).toEqual({ label: 'system', root: getSystemAgentsDir() });
  });

  it('accepts a repo path and descends into its .agents/ dir', () => {
    const root = makeProjectRepo();
    const resolved = resolveRepoTarget(root);
    expect(resolved).toEqual({ label: path.basename(root), root: path.join(root, '.agents') });
  });

  it('accepts a DotAgents root directly and labels it by parent dir', () => {
    const root = makeProjectRepo();
    const resolved = resolveRepoTarget(path.join(root, '.agents'));
    expect(resolved).toEqual({ label: path.basename(root), root: path.join(root, '.agents') });
  });

  it('resolves relative paths against the provided cwd', () => {
    const root = makeProjectRepo();
    const resolved = resolveRepoTarget('.agents', root);
    expect(resolved?.root).toBe(path.join(root, '.agents'));
  });

  it('rejects directories with no DotAgents markers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-inspect-empty-'));
    tempDirs.push(dir);
    expect(resolveRepoTarget(dir)).toBeNull();
  });

  it('rejects targets that are not directories', () => {
    expect(resolveRepoTarget('definitely-not-a-repo-or-agent')).toBeNull();
  });
});

describe('collectRepoKind', () => {
  it('lists files with extension stripped and frontmatter descriptions', () => {
    const root = makeProjectRepo();
    const repo = resolveRepoTarget(root)!;

    const commands = collectRepoKind(repo, 'commands');
    expect(commands.map(c => c.name)).toEqual(['plain', 'ship']);
    const ship = commands.find(c => c.name === 'ship')!;
    expect(ship.description).toBe('Ship the thing');
    expect(ship.source).toBe(repo.label);
    const plain = commands.find(c => c.name === 'plain')!;
    expect(plain.description).toBe('Plain command');
  });

  it('lists skill bundles and links to their SKILL.md', () => {
    const root = makeProjectRepo();
    const repo = resolveRepoTarget(root)!;

    const skills = collectRepoKind(repo, 'skills');
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('deploy');
    expect(skills[0].description).toBe('Deploy services');
    expect(skills[0].linkTarget).toBe(path.join(root, '.agents', 'skills', 'deploy', 'SKILL.md'));
  });

  it('returns empty for kinds with no directory', () => {
    const root = makeProjectRepo();
    const repo = resolveRepoTarget(root)!;
    expect(collectRepoKind(repo, 'workflows')).toEqual([]);
  });

  it('skips build/tooling caches (__pycache__, node_modules)', () => {
    const root = makeProjectRepo();
    fs.mkdirSync(path.join(root, '.agents', 'commands', '__pycache__'));
    fs.mkdirSync(path.join(root, '.agents', 'commands', 'node_modules'));
    const repo = resolveRepoTarget(root)!;
    expect(collectRepoKind(repo, 'commands').map(c => c.name)).toEqual(['plain', 'ship']);
  });
});

describe('repoManifestSummary', () => {
  it('extracts run strategies and version pins from agents.yaml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-manifest-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'agents.yaml'),
      'run:\n  claude:\n    strategy: balanced\n  codex:\n    strategy: pinned\nagents:\n  claude: 2.1.170\n');

    const summary = repoManifestSummary(dir)!;
    expect(summary.strategies).toEqual([
      { agent: 'claude', strategy: 'balanced' },
      { agent: 'codex', strategy: 'pinned' },
    ]);
    expect(summary.versions).toEqual([{ agent: 'claude', version: '2.1.170' }]);
  });

  it('returns null when agents.yaml is absent or has nothing to summarize', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-manifest-empty-'));
    tempDirs.push(dir);
    expect(repoManifestSummary(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'agents.yaml'), 'hooks:\n  some-hook:\n    script: x.sh\n');
    expect(repoManifestSummary(dir)).toBeNull();
  });
});

describe('pathSize', () => {
  it('sums file bytes and counts, recursing dirs and ignoring symlinks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-size-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');          // 5 bytes
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'world!!');  // 7 bytes
    // A symlink to a real file must not be followed/counted.
    fs.symlinkSync(path.join(dir, 'a.txt'), path.join(dir, 'link.txt'));

    const size = pathSize(dir);
    expect(size.bytes).toBe(12);
    expect(size.files).toBe(2);
  });

  it('returns zero for a missing path', () => {
    expect(pathSize(path.join(os.tmpdir(), 'definitely-missing-xyz'))).toEqual({ bytes: 0, files: 0 });
  });
});

describe('formatBytes', () => {
  it('renders human-readable sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(86 * 1024)).toBe('86 KB');
    expect(formatBytes(3.1 * 1024 * 1024)).toBe('3.1 MB');
  });
});

describe('wrapJoined', () => {
  it('wraps separator-joined values with a hanging indent', () => {
    const lines = wrapJoined('  versions  ', ['claude 1.0.0', 'codex 2.0.0', 'kimi 3.0.0'], ' · ', 34);
    expect(lines).toEqual([
      '  versions  claude 1.0.0',
      '            codex 2.0.0',
      '            kimi 3.0.0',
    ]);
    expect(lines.every((line) => stringWidth(line) <= 34)).toBe(true);
  });

  it('keeps a wide row on one line', () => {
    expect(wrapJoined('  run       ', ['claude:balanced', 'codex:pinned'], ' · ', 80)).toEqual([
      '  run       claude:balanced · codex:pinned',
    ]);
  });
});

describe('summarizeHook', () => {
  it('shows events only when there is no matcher or predicate', () => {
    expect(summarizeHook({ script: 'x.sh', events: ['SessionStart'] })).toBe('SessionStart');
  });

  it('joins multiple events with a slash', () => {
    expect(summarizeHook({ script: 'x.sh', events: ['PreToolUse', 'PostToolUse'] }))
      .toBe('PreToolUse/PostToolUse');
  });

  it('puts the matcher in parens after the events', () => {
    expect(summarizeHook({ script: 'x.sh', events: ['PreToolUse'], matcher: 'Bash' }))
      .toBe('PreToolUse(Bash)');
  });

  it('uses matches.tool_name as the matcher when no explicit matcher is set', () => {
    expect(summarizeHook({ script: 'x.sh', events: ['PreToolUse'], matches: { tool_name: ['Bash', 'Edit'] } }))
      .toBe('PreToolUse(Bash|Edit)');
  });

  it('appends a `·`-separated predicate summary from matches', () => {
    const hook: ManifestHook = {
      script: 'x.sh',
      events: ['PreToolUse'],
      matcher: 'Bash',
      matches: { git_dirty: true, prompt_contains: 'deploy' },
    };
    expect(summarizeHook(hook)).toBe('PreToolUse(Bash) · git_dirty · prompt~"deploy"');
  });

  it('adds a cache tail, stripping the -bg background suffix', () => {
    expect(summarizeHook({ script: 'x.sh', events: ['SessionStart'], cache: '5m-bg' }))
      .toBe('SessionStart (5m cache)');
    expect(summarizeHook({ script: 'x.sh', events: ['SessionStart'], cache: { ttl: '1h', key: 'per-cwd' } }))
      .toBe('SessionStart (1h cache)');
  });
});

describe('summarizeMcp', () => {
  it('renders an http server as transport + url', () => {
    expect(summarizeMcp({ name: 'posthog', transport: 'http', url: 'https://mcp.posthog.com' }))
      .toBe('http   https://mcp.posthog.com');
  });

  it('renders a stdio server as transport + command line', () => {
    expect(summarizeMcp({ name: 'linear', transport: 'stdio', command: 'npx', args: ['linear-mcp-server'] }))
      .toBe('stdio  npx linear-mcp-server');
  });
});

describe('hookManifestByScript', () => {
  it('keys hooks by their script basename without extension, not the manifest key', () => {
    const manifest: Record<string, ManifestHook> = {
      'capture-session-start-metadata': { script: '04-capture-session-start-metadata.sh', events: ['SessionStart'] },
      'git-guard': { script: 'git-guard.sh', events: ['PreToolUse'], matcher: 'Bash' },
    };
    const byScript = hookManifestByScript(manifest);
    // Installed hook names equal the script basename, so that is the join key.
    expect(byScript.get('04-capture-session-start-metadata')?.events).toEqual(['SessionStart']);
    expect(byScript.get('git-guard')?.matcher).toBe('Bash');
    // The manifest key itself is NOT a lookup key.
    expect(byScript.get('capture-session-start-metadata')).toBeUndefined();
  });
});

describe('repoGitInfo', () => {
  it('reports branch, last commit, and dirty files on a real repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-git-'));
    tempDirs.push(dir);
    const g = (args: string) => execSync(`git -C ${JSON.stringify(dir)} ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] });
    g('init -q -b main');
    g('config user.email t@t.t');
    g('config user.name t');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
    g('add a.txt');
    g('commit -q -m "first commit"');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two');   // make the tree dirty

    const info = repoGitInfo(dir)!;
    expect(info.branch).toBe('main');
    expect(info.lastCommit?.subject).toBe('first commit');
    expect(info.lastCommit?.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(info.dirtyFiles).toContain('a.txt');
    expect(info.dirty).toBe(1);
  });

  it('returns null for a non-git directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-nogit-'));
    tempDirs.push(dir);
    expect(repoGitInfo(dir)).toBeNull();
  });
});
