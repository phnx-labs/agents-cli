import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, 'src', 'index.ts');
// Run tsx via `node node_modules/tsx/dist/cli.mjs`, not the .bin/tsx shim: on
// Windows the shim is tsx.cmd, which spawnSync cannot exec without a shell.
const tsxBin = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function mkdir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p: string, content: string): void {
  mkdir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf-8');
}

/**
 * Build a tmp HOME with a single Claude version installed at 9.9.9, a default
 * pin in agents.yaml, and a few user-scoped resources visible to inspect.
 */
function makeFixture(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-test-' + crypto.randomBytes(4).toString('hex') + '-'));

  // ensureInitialized() looks for ~/.agents/.system/.git as the setup marker.
  mkdir(path.join(home, '.agents', '.system', '.git'));
  writeFile(path.join(home, '.agents', '.system', 'hooks.yaml'), '{}\n');

  // Suppress the update-check network call.
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as { version: string };
  mkdir(path.join(home, '.agents', '.cache'));
  writeFile(
    path.join(home, '.agents', '.cache', '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: pkg.version })
  );

  // Versioned Claude install: ~/.agents/.history/versions/claude/9.9.9/home/.claude/
  const versionHome = path.join(home, '.agents', '.history', 'versions', 'claude', '9.9.9', 'home');
  const claudeCfg = path.join(versionHome, '.claude');
  mkdir(claudeCfg);

  // Default pin
  writeFile(
    path.join(home, '.agents', 'agents.yaml'),
    'agents:\n  claude: 9.9.9\nrun:\n  claude:\n    strategy: balanced\n'
  );

  // User-scoped skill that should appear in inspect's resources & be drillable.
  // listInstalledSkillsWithScope reads from the version home's .claude/skills/<name>/SKILL.md.
  const skillDir = path.join(claudeCfg, 'skills', 'demo-skill');
  writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: demo-skill\ndescription: A demo skill for inspect tests.\ntriggers: demo, hello\n---\n\nBody.\n'
  );

  // A second skill so the fuzzy/typo path has something to suggest.
  const skill2Dir = path.join(claudeCfg, 'skills', 'release');
  writeFile(
    path.join(skill2Dir, 'SKILL.md'),
    '---\nname: release\ndescription: Publish packages to a registry.\n---\n\nBody.\n'
  );

  // User-scoped command.
  writeFile(
    path.join(claudeCfg, 'commands', 'hello.md'),
    '---\ndescription: Say hello.\n---\n\nGreet the user.\n'
  );

  return home;
}

function run(home: string, args: string[], cwd: string = home) {
  return spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${path.join(home, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
      AGENTS_SKIP_MIGRATION: '1',
      NODE_NO_WARNINGS: '1',
    },
    encoding: 'utf-8',
  });
}

/**
 * Build a project dir (separate from HOME's ~/.agents) whose resources live
 * under `.agents/`, plus decoy top-level `agents.yaml` + `skills/` that must NOT
 * be mistaken for the DotAgents tree. The `.agents/` holds a skill, a command,
 * and a plugin bundling its own skill.
 */
function makeProjectRepo(): string {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-proj-' + crypto.randomBytes(4).toString('hex') + '-'));

  // Decoys at the project root — a version pin and an unrelated source skills/ dir.
  writeFile(path.join(proj, 'agents.yaml'), 'agents:\n  claude: 9.9.9\n');
  writeFile(
    path.join(proj, 'skills', 'decoy-skill', 'SKILL.md'),
    '---\nname: decoy-skill\ndescription: Top-level source skill, not a DotAgents resource.\n---\n\nBody.\n'
  );

  // The real DotAgents tree under .agents/.
  const dot = path.join(proj, '.agents');
  writeFile(
    path.join(dot, 'skills', 'proj-skill', 'SKILL.md'),
    '---\nname: proj-skill\ndescription: A project-scoped skill.\n---\n\nBody.\n'
  );
  writeFile(path.join(dot, 'commands', 'proj-cmd.md'), '---\ndescription: Project command.\n---\n\nDo it.\n');

  const plugin = path.join(dot, 'plugins', 'myplugin');
  writeFile(
    path.join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'myplugin', description: 'A bundled plugin.', version: '0.0.1' })
  );
  writeFile(
    path.join(plugin, 'skills', 'bundled', 'SKILL.md'),
    '---\nname: bundled\ndescription: Skill shipped inside the plugin.\n---\n\nBody.\n'
  );

  return proj;
}

let fixtureHome: string;

beforeEach(() => {
  fixtureHome = makeFixture();
});

afterEach(() => {
  try { fs.rmSync(fixtureHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('agents inspect', () => {
  it('exits non-zero on a target that is neither an agent nor a repo', () => {
    const r = run(fixtureHome, ['inspect', 'bogus']);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/Unknown target/);
  });

  it('summary --json carries paths, capabilities, and resource counts', () => {
    const r = run(fixtureHome, ['inspect', 'claude', '--json']);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.agent).toBe('claude');
    expect(data.version).toBe('9.9.9');
    expect(data.default).toBe(true);
    expect(data.home).toContain(path.join('versions', 'claude', '9.9.9', 'home'));
    expect(data.shim).toContain(path.join('shims', 'claude'));
    expect(data.alias).toContain('claude@9.9.9');
    expect(data.strategy).toBe('balanced');
    expect(data.capabilities.skills.ok).toBe(true);
    // Counts include at least our two seeded skills and one command.
    expect(data.resources.skills.total).toBeGreaterThanOrEqual(2);
    expect(data.resources.commands.total).toBeGreaterThanOrEqual(1);
  });

  it('--brief skips resources + sessions in JSON output', () => {
    const r = run(fixtureHome, ['inspect', 'claude', '--brief', '--json']);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.capabilities).toBeDefined();
    expect(data.resources).toBeNull();
    expect(data.sessions).toBeNull();
  });

  it('--skills lists installed skills with name + source + path', () => {
    const r = run(fixtureHome, ['inspect', 'claude', '--skills', '--json']);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.kind).toBe('skills');
    const names = (data.items as Array<{ name: string }>).map(i => i.name);
    expect(names).toContain('demo-skill');
    expect(names).toContain('release');
    const demo = (data.items as Array<{ name: string; path: string }>).find(i => i.name === 'demo-skill');
    // For bundled skills, path is the skill directory.
    expect(demo?.path).toMatch(/skills[\\/]demo-skill$/);
  });

  it('--skills <typo> resolves via fuzzy match; bogus query exits 1 with suggestions', () => {
    // Substring match still wins for "rele" → "release".
    const ok = run(fixtureHome, ['inspect', 'claude', '--skills', 'rele', '--json']);
    expect(ok.status).toBe(0);
    const okData = JSON.parse(ok.stdout);
    expect(okData.match.name).toBe('release');

    // Damerau-Levenshtein typo: "demoo-skill" → "demo-skill".
    const fuzzy = run(fixtureHome, ['inspect', 'claude', '--skills', 'demoo-skill', '--json']);
    expect(fuzzy.status).toBe(0);
    const fuzzyData = JSON.parse(fuzzy.stdout);
    expect(fuzzyData.match.name).toBe('demo-skill');
    expect(fuzzyData.match.matchKind).toBe('fuzzy');

    // No match → exit 1 + suggestions.
    const miss = run(fixtureHome, ['inspect', 'claude', '--skills', 'absolutelynothing', '--json']);
    expect(miss.status).toBe(1);
    const missData = JSON.parse(miss.stdout);
    expect(missData.match).toBeNull();
    expect(Array.isArray(missData.suggestions)).toBe(true);
  });

  it('rejects multiple drill-down flags at once', () => {
    const r = run(fixtureHome, ['inspect', 'claude', '--skills', '--commands']);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/at most one drill-down flag/i);
  });
});

describe('agents inspect <repo>', () => {
  let projectRepo: string;

  beforeEach(() => {
    projectRepo = makeProjectRepo();
  });

  afterEach(() => {
    try { fs.rmSync(projectRepo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('inspect . from a project root reads .agents/, not the top-level source dirs', () => {
    // cwd is the project root, which has a decoy top-level skills/ + agents.yaml.
    const r = run(fixtureHome, ['inspect', '.', '--json'], projectRepo);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    // Root must be the nested .agents/, not the project root.
    expect(data.root).toMatch(/\.agents$/);
    // .agents/ has exactly one skill (proj-skill) — the decoy top-level skill is excluded.
    expect(data.resources.skills.count).toBe(1);
    expect(data.resources.commands.count).toBe(1);
    expect(data.resources.plugins.count).toBe(1);
  });

  it('--skills lists the .agents/ skill, not the decoy top-level one', () => {
    const r = run(fixtureHome, ['inspect', '.', '--skills', '--json'], projectRepo);
    expect(r.status).toBe(0);
    const names = (JSON.parse(r.stdout).items as Array<{ name: string }>).map(i => i.name);
    expect(names).toContain('proj-skill');
    expect(names).not.toContain('decoy-skill');
  });

  it('--plugins surfaces the manifest description and bundled skills', () => {
    const list = run(fixtureHome, ['inspect', '.', '--plugins', '--json'], projectRepo);
    expect(list.status).toBe(0);
    const item = (JSON.parse(list.stdout).items as Array<{ name: string; description: string }>)
      .find(i => i.name === 'myplugin');
    expect(item?.description).toBe('A bundled plugin.');

    // Drilling into the plugin reports its nested skill.
    const detail = run(fixtureHome, ['inspect', '.', '--plugins', 'myplugin', '--json'], projectRepo);
    expect(detail.status).toBe(0);
    const match = JSON.parse(detail.stdout).match as { name: string; skills?: string };
    expect(match.name).toBe('myplugin');
    expect(match.skills).toContain('bundled');
  });

  it('resolves built-in repo layers (system) and reports resource counts', () => {
    const r = run(fixtureHome, ['inspect', 'system', '--json']);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.repo).toBe('system');
    expect(data.root).toMatch(/\.system$/);
  });
});
