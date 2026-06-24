import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// state.ts captures HOME at module load, so we point HOME at a temp dir and
// dynamic-import the budget config AFTER, giving us an isolated user agents.yaml.
let fakeHome: string;
let userYaml: string;
let resolveBudgetConfig: typeof import('./config.js').resolveBudgetConfig;
let hasAnyCap: typeof import('./config.js').hasAnyCap;

beforeAll(async () => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-config-home-'));
  process.env.HOME = fakeHome;
  fs.mkdirSync(path.join(fakeHome, '.agents'), { recursive: true });
  userYaml = path.join(fakeHome, '.agents', 'agents.yaml');
  const mod = await import('./config.js');
  resolveBudgetConfig = mod.resolveBudgetConfig;
  hasAnyCap = mod.hasAnyCap;
});

afterAll(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

let projectDir: string;

beforeEach(() => {
  // Fresh user agents.yaml each test.
  fs.writeFileSync(userYaml, '');
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-config-proj-'));
});

describe('resolveBudgetConfig', () => {
  it('reads the user-global budget when no project block exists', () => {
    fs.writeFileSync(userYaml, 'budget:\n  per_run: 5\n  per_day: 50\n  on_exceed: block\n');
    const cfg = resolveBudgetConfig(projectDir);
    expect(cfg.per_run).toBe(5);
    expect(cfg.per_day).toBe(50);
    expect(cfg.on_exceed).toBe('block');
  });

  it('project block OVERRIDES user on set fields, INHERITS unset ones', () => {
    fs.writeFileSync(userYaml, 'budget:\n  per_run: 5\n  per_day: 50\n  per_project: 100\n');
    fs.writeFileSync(path.join(projectDir, 'agents.yaml'), 'budget:\n  per_run: 1\n');
    const cfg = resolveBudgetConfig(projectDir);
    expect(cfg.per_run).toBe(1);   // project wins
    expect(cfg.per_day).toBe(50);  // inherited from user
    expect(cfg.per_project).toBe(100); // inherited from user
  });

  it('nearest project agents.yaml wins over an ancestor project agents.yaml', () => {
    const child = path.join(projectDir, 'sub');
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(projectDir, 'agents.yaml'), 'budget:\n  per_run: 10\n');
    fs.writeFileSync(path.join(child, 'agents.yaml'), 'budget:\n  per_run: 2\n');
    const cfg = resolveBudgetConfig(child);
    expect(cfg.per_run).toBe(2);
  });

  it('merges per_agent maps key-by-key (project adds a key without wiping user keys)', () => {
    fs.writeFileSync(userYaml, 'budget:\n  per_agent:\n    claude: 30\n    codex: 20\n');
    fs.writeFileSync(path.join(projectDir, 'agents.yaml'), 'budget:\n  per_agent:\n    codex: 5\n');
    const cfg = resolveBudgetConfig(projectDir);
    expect(cfg.per_agent).toEqual({ claude: 30, codex: 5 });
  });

  it('defaults on_exceed to block (fail-closed) when nothing sets it', () => {
    fs.writeFileSync(userYaml, 'budget:\n  per_run: 5\n');
    expect(resolveBudgetConfig(projectDir).on_exceed).toBe('block');
  });

  it('ignores a malformed project agents.yaml and keeps the user budget', () => {
    fs.writeFileSync(userYaml, 'budget:\n  per_run: 5\n');
    fs.writeFileSync(path.join(projectDir, 'agents.yaml'), 'budget:\n  per_run: [this: is: broken\n');
    const cfg = resolveBudgetConfig(projectDir);
    expect(cfg.per_run).toBe(5);
  });

  it('drops a cap whose value is the wrong type (string instead of number)', () => {
    fs.writeFileSync(userYaml, 'budget:\n  per_run: "lots"\n  per_day: 50\n');
    const cfg = resolveBudgetConfig(projectDir);
    expect(cfg.per_run).toBeUndefined();
    expect(cfg.per_day).toBe(50);
  });
});

describe('hasAnyCap', () => {
  it('is false for an empty config (feature dormant)', () => {
    expect(hasAnyCap({ on_exceed: 'block' })).toBe(false);
  });
  it('is true when any cap is set', () => {
    expect(hasAnyCap({ per_run: 5 })).toBe(true);
    expect(hasAnyCap({ per_agent: { claude: 1 } })).toBe(true);
  });
});
