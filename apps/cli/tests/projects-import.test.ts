/**
 * End-to-end `agents projects import` — the real CLI, a real registry file on
 * disk, real YAML written to a real directory. No mocks: the seams are
 * `AGENTS_FACTORY_PROJECTS_PATH` (the source) and `AGENTS_PROJECTS_DIR` (the
 * destination), plus a throwaway `HOME` carrying the beta opt-in.
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entrypoint = path.join(repoRoot, 'src', 'index.ts');

let home: string;
let projectsDir: string;
let registry: string;

/** The registry shape Factory writes, including the low-confidence guesses. */
const REGISTRY = [
  { id: 'me/agents-cli', name: 'agents-cli', path: '/tmp/src/agents-cli', repoSlug: 'me/agents-cli', confidence: 'high' },
  { id: 'me/agents', name: 'agents', path: '/tmp/src/agents', repoSlug: 'me/agents', confidence: 'high' },
  { id: 'me/swarmify', name: 'swarmify', path: '/tmp/src/swarmify', repoSlug: 'me/swarmify', confidence: 'medium' },
  { id: 'other/inflow', name: 'inflow', path: '/tmp/src/inflow', repoSlug: 'other/inflow', confidence: 'low' },
  // No `confidence` at all — an unranked guess, below every stated floor.
  { id: 'me/stale', name: 'agents-cleaned-stale2', path: '/tmp/src/agents-cleaned-stale2' },
];

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [tsxCli, entrypoint, ...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: '1',
        AGENTS_SKIP_MIGRATION: '1',
        AGENTS_PROJECTS_DIR: projectsDir,
        AGENTS_FACTORY_PROJECTS_PATH: registry,
      },
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
  }
}

const defined = () =>
  fs
    .readdirSync(projectsDir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort();

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-import-home-'));
  projectsDir = path.join(home, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  // The beta opt-in this command tree is gated on, plus a populated config so
  // the interactive first-run setup can never trigger.
  fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\nbeta:\n  enabled:\n    - projects\n');
  // ensureInitialized() gates every non-setup command on the system repo being a
  // git checkout — seed it, or every run errors "agents-cli is not set up".
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  registry = path.join(home, 'factory-projects.json');
  fs.writeFileSync(registry, JSON.stringify(REGISTRY, null, 2));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agents projects import --from-factory', () => {
  it('imports only high-confidence rows by default and names every skip', () => {
    const { stdout, status } = runCli(['projects', 'import', '--from-factory']);
    expect(status).toBe(0);
    expect(defined()).toEqual(['agents', 'agents-cli']);
    expect(stdout).toContain('Imported 2 projects (3 skipped)');
    expect(stdout).toContain('skip swarmify: confidence "medium" is below the "high" floor');
    expect(stdout).toContain('skip inflow: confidence "low" is below the "high" floor');
    expect(stdout).toContain('skip agents-cleaned-stale2: no confidence field is below the "high" floor');
  });

  it('widens with --min-confidence medium', () => {
    runCli(['projects', 'import', '--from-factory', '--min-confidence', 'medium']);
    expect(defined()).toEqual(['agents', 'agents-cli', 'swarmify']);
  });

  it('takes every row under --all, including one with no confidence field', () => {
    runCli(['projects', 'import', '--from-factory', '--all']);
    expect(defined()).toEqual(['agents', 'agents-cleaned-stale2', 'agents-cli', 'inflow', 'swarmify']);
  });

  it('writes the mapped fields into the YAML', () => {
    runCli(['projects', 'import', '--from-factory']);
    const yaml = fs.readFileSync(path.join(projectsDir, 'agents-cli.yaml'), 'utf8');
    expect(yaml).toContain('name: agents-cli');
    expect(yaml).toContain('root: /tmp/src/agents-cli');
    expect(yaml).toContain('repo: me/agents-cli');
  });

  it('is idempotent — a re-import skips what already exists', () => {
    runCli(['projects', 'import', '--from-factory']);
    const { stdout } = runCli(['projects', 'import', '--from-factory']);
    expect(stdout).toContain('Imported 0 projects (5 skipped)');
    expect(stdout).toContain('skip agents-cli: already defined — pass --force to overwrite');
    expect(defined()).toEqual(['agents', 'agents-cli']);
  });

  it('rejects an unknown --min-confidence loudly, writing nothing', () => {
    const { stdout, status } = runCli(['projects', 'import', '--from-factory', '--min-confidence', 'kinda']);
    expect(status).toBe(1);
    expect(stdout).toContain('Invalid --min-confidence "kinda"');
    expect(defined()).toEqual([]);
  });

  it('requires a source, and refuses both at once', () => {
    expect(runCli(['projects', 'import']).stdout).toContain('Pick an import source');
    expect(runCli(['projects', 'import', '--from-factory', '--from-linear']).stdout)
      .toContain('mutually exclusive');
    expect(defined()).toEqual([]);
  });

  it('refuses confidence flags on the Linear source instead of ignoring them', () => {
    const { stdout, status } = runCli(['projects', 'import', '--from-linear', '--all']);
    expect(status).toBe(1);
    expect(stdout).toContain('--from-factory only');
    expect(defined()).toEqual([]);
  });

  it('fails loudly on a missing registry rather than reporting zero imports', () => {
    fs.rmSync(registry);
    const { stdout, status } = runCli(['projects', 'import', '--from-factory']);
    expect(status).toBe(1);
    expect(stdout).toContain('No Factory registry at');
  });
});
