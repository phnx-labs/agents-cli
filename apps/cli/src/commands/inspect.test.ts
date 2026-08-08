import { execFileSync } from 'child_process';
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
  summaryLine,
} from './inspect.js';
import { listHookEntriesFromDir } from '../lib/hooks.js';
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

  it('skips directory-doc files (README/AGENTS/CLAUDE/GEMINI), including symlinks', () => {
    const root = makeProjectRepo();
    const commandsDir = path.join(root, '.agents', 'commands');
    // Every resource dir carries README.md + AGENTS.md by convention, with
    // CLAUDE.md/GEMINI.md symlinked to AGENTS.md. None is a command.
    fs.writeFileSync(path.join(commandsDir, 'README.md'), '# Commands\n');
    fs.writeFileSync(path.join(commandsDir, 'AGENTS.md'), '# Maintenance\n');
    fs.symlinkSync('AGENTS.md', path.join(commandsDir, 'CLAUDE.md'));
    fs.symlinkSync('AGENTS.md', path.join(commandsDir, 'GEMINI.md'));
    const repo = resolveRepoTarget(root)!;
    // Only the real commands remain — the four doc files are filtered out.
    expect(collectRepoKind(repo, 'commands').map(c => c.name)).toEqual(['plain', 'ship']);
  });

  it('lists rules from subrules/, not the composed AGENTS.md output', () => {
    const root = makeProjectRepo();
    const rulesDir = path.join(root, '.agents', 'rules');
    fs.mkdirSync(path.join(rulesDir, 'subrules'), { recursive: true });
    // The composed output + its symlinks + the maintenance doc + the preset file.
    // None of these is a rule you can drill into by name.
    fs.writeFileSync(path.join(rulesDir, 'AGENTS.md'), '# Composed ruleset\n');
    fs.symlinkSync('AGENTS.md', path.join(rulesDir, 'CLAUDE.md'));
    fs.writeFileSync(path.join(rulesDir, 'README.md'), '# Rules\n');
    fs.writeFileSync(path.join(rulesDir, 'rules.yaml'), 'presets:\n  default:\n    subrules: []\n');
    // The addressable fragments.
    fs.writeFileSync(path.join(rulesDir, 'subrules', 'foundations.md'), '# Foundations\n\nF1.\n');
    fs.writeFileSync(path.join(rulesDir, 'subrules', 'code-quality.md'), '# Code Quality\n\nTactics.\n');
    const repo = resolveRepoTarget(root)!;
    // Before this fix `subrules` came back as a single opaque leaf alongside the
    // doc files, so `--rule foundations` could never resolve.
    expect(collectRepoKind(repo, 'rules').map(r => r.name)).toEqual(['code-quality', 'foundations']);
  });

  it('omits the author row when the manifest author has no name', () => {
    const root = makeProjectRepo();
    const dir = path.join(root, '.agents', 'plugins', 'noauthor', '.claude-plugin');
    fs.mkdirSync(dir, { recursive: true });
    // loadPluginManifest is a bare JSON cast, so `author.name` is typed required
    // but never validated. An author object without a name used to push
    // `undefined` into the row list and crash the renderer on stripAnsi.
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
      name: 'noauthor', version: '1.0.0', description: 'no author name', author: { email: 'x@y.z' },
    }));
    const repo = resolveRepoTarget(root)!;
    const [plugin] = collectRepoKind(repo, 'plugins');
    expect(plugin.name).toBe('noauthor');
    expect(plugin.extra?.map(([k]) => k)).not.toContain('author');
    // Every emitted value must be a string — the crash was an undefined here.
    for (const [, v] of plugin.extra ?? []) expect(typeof v).toBe('string');
  });

  it('survives manifest fields whose JSON type contradicts the declared type', () => {
    const root = makeProjectRepo();
    const dir = path.join(root, '.agents', 'plugins', 'wrongtypes', '.claude-plugin');
    fs.mkdirSync(dir, { recursive: true });
    // loadPluginManifest validates only name/version, so every other field is
    // whatever the JSON says. `dependencies` as a bare string is the sharp one:
    // `.length` is truthy on a string and `.join` does not exist, which threw
    // inside pluginToItem — i.e. while BUILDING THE LIST, taking down `inspect .`,
    // `--plugins`, and even a query for a different, valid plugin.
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
      name: 'wrongtypes', version: 2, description: 'd', dependencies: 'some-plugin',
    }));
    const repo = resolveRepoTarget(root)!;
    const items = collectRepoKind(repo, 'plugins');
    expect(items.map(i => i.name)).toContain('wrongtypes');
    const plugin = items.find(i => i.name === 'wrongtypes')!;
    // A non-array `dependencies` still renders, and a numeric version coerces.
    expect(plugin.extra).toEqual(
      expect.arrayContaining([['version', '2'], ['depends on', 'some-plugin']]),
    );
    for (const [, v] of plugin.extra ?? []) expect(typeof v).toBe('string');
  });

  it('reads a dir-form subrule description from rule.md', () => {
    const root = makeProjectRepo();
    const dir = path.join(root, '.agents', 'rules', 'subrules', 'gh-merge-guard');
    fs.mkdirSync(dir, { recursive: true });
    // The directory form documented in lib/rules/compose.ts (SUBRULE_RULE_FILE).
    fs.writeFileSync(path.join(dir, 'rule.md'), '# Merge & Admin-Bypass Guard\n\nNever bypass.\n');
    const repo = resolveRepoTarget(root)!;
    const [rule] = collectRepoKind(repo, 'rules');
    expect(rule.name).toBe('gh-merge-guard');
    expect(rule.description).toBe('Merge & Admin-Bypass Guard');
  });

  it('falls back to the flat rules dir when there is no subrules/', () => {
    const root = makeProjectRepo();
    const rulesDir = path.join(root, '.agents', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'house-style.md'), '# House style\n');
    const repo = resolveRepoTarget(root)!;
    expect(collectRepoKind(repo, 'rules').map(r => r.name)).toEqual(['house-style']);
  });

  it('reads hooks through the grouped reader, matching the summary view', () => {
    const root = makeProjectRepo();
    const hooksDir = path.join(root, '.agents', 'hooks');
    // Hooks nest under event directories, and a script pairs with its data
    // sidecar. A flat readdir returned the event dir itself ('pre-tool-use') and
    // counted the sidecar separately, so `--hooks` and the summary disagreed.
    fs.mkdirSync(path.join(hooksDir, 'pre-tool-use'), { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-tool-use', 'guard.sh'), '#!/usr/bin/env bash\necho ok\n');
    fs.writeFileSync(path.join(hooksDir, 'pre-tool-use', 'guard.yaml'), 'matches: {}\n');
    fs.writeFileSync(path.join(hooksDir, 'README.md'), '# Hooks\n');

    const repo = resolveRepoTarget(root)!;
    const names = collectRepoKind(repo, 'hooks').map(h => h.name);
    // The nested script is found, its sidecar collapses into it, and neither the
    // event directory nor the directory doc is reported as a hook.
    expect(names).toEqual(['guard']);
    // The drill and the summary must never report different counts again — both
    // now go through listHookEntriesFromDir.
    expect(names).toEqual(listHookEntriesFromDir(hooksDir).map(h => h.name));
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

describe('summaryLine', () => {
  it('drops the trigger clause so the row says what the thing does', () => {
    // 15 of 20 skills in .system append "Triggers on: …" to their description.
    // In a one-line row that clause is what survived truncation, so the row
    // showed trigger keywords instead of the purpose.
    expect(summaryLine(
      "Manage AI coding agent CLIs with agents-cli. Triggers on: 'agents add', 'agents use', installing agent versions",
    )).toBe('Manage AI coding agent CLIs with agents-cli.');

    expect(summaryLine(
      'Drive a browser to automate websites — fill forms, click buttons. Use this skill when automating a site.',
    )).toBe('Drive a browser to automate websites — fill forms, click buttons.');
  });

  it('keeps the whole text when there is no trigger clause and no sentence break', () => {
    expect(summaryLine('Write documentation — user-facing, technical, runbooks'))
      .toBe('Write documentation — user-facing, technical, runbooks');
  });

  it('does not chop a description to a fragment on an early abbreviation', () => {
    // A naive first-sentence split would cut at "e.g." and leave three words.
    const d = 'Publish artifacts, e.g. Plans and reports, to a shareable link on your own storage.';
    expect(summaryLine(d)).toBe(d);
  });

  it('is empty for an empty description', () => {
    expect(summaryLine('')).toBe('');
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

  it('survives agents.yaml values whose YAML type contradicts the declared type', () => {
    // A hook entry is an unvalidated yaml.parse cast. `events` as a scalar is
    // neither null nor an array, so `(hook.events ?? []).join()` threw — killing
    // bare `agents inspect <repo>`, and via the central manifest every box's
    // `agents inspect <agent>`. Renders the scalar rather than dropping it.
    expect(summarizeHook({ script: 'x.sh', events: 'PreToolUse' } as unknown as ManifestHook))
      .toBe('PreToolUse');
    // Predicates reach `truncate`, which calls `.slice`.
    expect(summarizeHook({
      script: 'x.sh',
      events: ['Stop'],
      matches: { prompt_contains: 12345, cwd_includes: 99 },
    } as unknown as ManifestHook)).toBe('Stop · prompt~"12345" · cwd~99');
    // An object carries no one-line form: dropped, never `[object Object]`.
    expect(summarizeHook({
      script: 'x.sh', events: [{ a: 1 }, 'Stop'],
    } as unknown as ManifestHook)).toBe('Stop');
    expect(summarizeHook({ script: 'x.sh', events: {} } as unknown as ManifestHook))
      .toBe('(no event)');
    // `cache: 5` has no `.ttl` and `{ttl: {…}}` has a non-scalar one; both used
    // to render a tail reading `(undefined cache)` / `([object Object] cache)`.
    for (const cache of [5, [1, 2], { ttl: { a: 1 } }, {}]) {
      expect(summarizeHook({ script: 'x.sh', events: ['Stop'], cache } as unknown as ManifestHook))
        .toBe('Stop');
    }
    // A well-formed ttl still renders.
    expect(summarizeHook({ script: 'x.sh', events: ['Stop'], cache: { ttl: '5m' } } as unknown as ManifestHook))
      .toBe('Stop (5m cache)');
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
    const g = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@t.t']);
    g(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
    g(['add', 'a.txt']);
    g(['commit', '-q', '-m', 'first commit']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two');   // make the tree dirty

    const info = repoGitInfo(dir)!;
    expect(info.branch).toBe('main');
    expect(info.lastCommit?.subject).toBe('first commit');
    expect(info.lastCommit?.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(info.dirtyFiles).toContain('a.txt');
    expect(info.dirty).toBe(1);
  });

  // The `$(touch …)` payload is POSIX-shell syntax and embeds an absolute
  // sentinel path (which contains `:` / `\` on Windows — illegal in a filename),
  // so the demonstrator runs on POSIX only. The fix (argv-form execFileSync)
  // removes the shell on every platform, so Windows is covered by construction,
  // not by this sh-specific probe.
  it.skipIf(process.platform === 'win32')('treats a repo path with shell metacharacters as a literal argument', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-inject-'));
    tempDirs.push(base);
    const sentinel = path.join(base, 'pwned');
    const maliciousDir = path.join(base, `$(touch ${sentinel})`);
    fs.mkdirSync(maliciousDir, { recursive: true });
    expect(fs.existsSync(sentinel)).toBe(false);

    const info = repoGitInfo(maliciousDir);

    expect(fs.existsSync(sentinel)).toBe(false);
    expect(info).toBeNull();
  });

  it('returns null for a non-git directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-nogit-'));
    tempDirs.push(dir);
    expect(repoGitInfo(dir)).toBeNull();
  });
});
