import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-test-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// Run a script under an isolated HOME so state.ts derives ~/.agents inside it.
// Real fs, no mocking (repo convention). Returns the parsed last JSON line.
function runInHome(body: string): Record<string, unknown> {
  const script = String.raw`
    import * as fs from 'fs';
    import * as path from 'path';
    import { planUninstall, executeUninstall } from './src/lib/uninstall.ts';
    const home = process.env.HOME;
    const userDir = path.join(home, '.agents');
    const versionsRoot = path.join(userDir, '.history', 'versions');
    const backupsRoot = path.join(userDir, '.history', 'backups');
    const shimsDir = path.join(userDir, '.cache', 'shims');
    // Minimal ~/.agents so planUninstall sees an install.
    fs.mkdirSync(shimsDir, { recursive: true });

    // Helper: adopt <agent> — a ~/.<agent> symlink into a version home.
    function adopt(agent, configDirName, version, managedContent) {
      const versionHome = path.join(versionsRoot, agent, version, 'home', configDirName);
      fs.mkdirSync(versionHome, { recursive: true });
      fs.writeFileSync(path.join(versionHome, 'marker'), managedContent);
      fs.symlinkSync(versionHome, path.join(home, configDirName));
      return versionHome;
    }
    function backup(agent, ts, originalContent) {
      const dir = path.join(backupsRoot, agent, String(ts));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'marker'), originalContent);
    }
    ${body}
  `;
  // Pin BOTH HOME and AGENTS_REAL_HOME to the test dir. state.ts derives
  // ~/.agents from HOME while getAgentConfigPath honors AGENTS_REAL_HOME; if a
  // stale AGENTS_REAL_HOME leaks in from the outer env the two diverge and the
  // test breaks. Setting both keeps this subprocess hermetic regardless.
  const out = execFileSync('bun', ['--eval', script], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, AGENTS_REAL_HOME: home },
    encoding: 'utf-8',
  });
  return JSON.parse(out.trim().split('\n').at(-1) ?? '{}');
}

describe('uninstall restores adopted configs and never touches un-adopted ones', () => {
  it('restores an adopted config from its backup and leaves a real un-adopted dir untouched', () => {
    const result = runInHome(String.raw`
      adopt('claude', '.claude', '1.0.0', 'MANAGED');
      backup('claude', 1700000000000, 'ORIGINAL_CLAUDE');

      // A real ~/.codex that agents-cli never adopted.
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'ORIGINAL_CODEX');

      // An rc file carrying the shim PATH line.
      const rc = path.join(home, '.zshrc');
      fs.writeFileSync(rc, '# agents-cli: version-managed agent CLIs\nexport PATH="' + shimsDir + ':$PATH"\nexport KEEP=1\n');

      const plan = planUninstall();
      const res = executeUninstall(plan, { purge: false, timestamp: 42 });

      const claudePath = path.join(home, '.claude');
      const rcAfter = fs.readFileSync(rc, 'utf-8');
      console.log(JSON.stringify({
        codexKind: plan.configs.find(c => c.agent === 'codex').kind,
        claudeKind: plan.configs.find(c => c.agent === 'claude').kind,
        claudeIsRealDir: fs.lstatSync(claudePath).isDirectory() && !fs.lstatSync(claudePath).isSymbolicLink(),
        claudeContent: fs.readFileSync(path.join(claudePath, 'marker'), 'utf-8'),
        codexContent: fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8'),
        agentsMovedAside: fs.existsSync(userDir + '.removed-42') && !fs.existsSync(userDir),
        rcStrippedButKept: !rcAfter.includes('version-managed') && rcAfter.includes('KEEP=1'),
        errors: res.errors,
      }));
    `);

    expect(result.claudeKind).toBe('restore-backup');
    // The un-adopted real dir must be classified untouchable and left as-is.
    expect(result.codexKind).toBe('leave-real');
    expect(result.claudeIsRealDir).toBe(true);
    expect(result.claudeContent).toBe('ORIGINAL_CLAUDE');
    expect(result.codexContent).toBe('ORIGINAL_CODEX');
    expect(result.agentsMovedAside).toBe(true);
    expect(result.rcStrippedButKept).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('restores from the version home when there is no backup (importAgent case)', () => {
    const result = runInHome(String.raw`
      adopt('claude', '.claude', '2.0.0', 'IMPORTED_ORIGINAL');   // no backup() call
      const plan = planUninstall();
      const res = executeUninstall(plan, { purge: false, timestamp: 7 });
      const claudePath = path.join(home, '.claude');
      console.log(JSON.stringify({
        kind: plan.configs.find(c => c.agent === 'claude').kind,
        isRealDir: fs.lstatSync(claudePath).isDirectory() && !fs.lstatSync(claudePath).isSymbolicLink(),
        content: fs.readFileSync(path.join(claudePath, 'marker'), 'utf-8'),
        errors: res.errors,
      }));
    `);
    expect(result.kind).toBe('restore-version-home');
    expect(result.isRealDir).toBe(true);
    expect(result.content).toBe('IMPORTED_ORIGINAL');
    expect(result.errors).toEqual([]);
  });

  it('planUninstall is read-only — a dry run mutates nothing', () => {
    const result = runInHome(String.raw`
      adopt('claude', '.claude', '1.0.0', 'MANAGED');
      backup('claude', 1700000000000, 'ORIGINAL');
      const before = fs.lstatSync(path.join(home, '.claude')).isSymbolicLink();
      const plan = planUninstall();   // must not touch disk
      console.log(JSON.stringify({
        stillSymlink: fs.lstatSync(path.join(home, '.claude')).isSymbolicLink(),
        wasSymlink: before,
        agentsIntact: fs.existsSync(userDir),
        claudeToRestore: plan.configs.find(c => c.agent === 'claude').kind,
      }));
    `);
    expect(result.wasSymlink).toBe(true);
    expect(result.stillSymlink).toBe(true);
    expect(result.agentsIntact).toBe(true);
    expect(result.claudeToRestore).toBe('restore-backup');
  });
});
