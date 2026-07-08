import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolated in its own file: mocking `child_process` module-wide (below) would
// otherwise pollute the subprocess-based tests in versions.test.ts and break
// them under the node test runner. Keep this test's mock contained here.

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-installscripts-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const npmInstallCapture = vi.hoisted(() => ({ argv: undefined as string[] | undefined }));
// Every non-`npm` execFile call the mock sees, recorded so tests can assert what
// installVersion runs after the npm install: the first-party postinstall command
// (args=[], shell:true) and the integrity-gate `--version` probe (args=['--version']).
const execCalls = vi.hoisted(() => ({ list: [] as Array<{ file: string; args: string[]; cwd?: string; shell?: boolean }> }));
// Lets a test force the mocked postinstall to fail, exercising the best-effort path.
const behavior = vi.hoisted(() => ({ failPostinstall: false }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn((file, args, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      const opts = (typeof options === 'function' ? {} : options) ?? {};
      const argv: string[] = Array.isArray(args) ? args : [];
      if (file === 'npm' && argv[0] === 'install') {
        npmInstallCapture.argv = argv;
        if (cb) cb(null, 'mock npm install success', '');
      } else if (file === 'npm' && argv[0] === '--version') {
        if (cb) cb(null, '10.0.0', '');
      } else {
        // Postinstall command string (args=[], shell:true) or a binary --version
        // probe. Record both; a postinstall is distinguished by shell === true.
        execCalls.list.push({ file, args: argv, cwd: (opts as any).cwd, shell: (opts as any).shell });
        const isPostinstall = (opts as any).shell === true && argv.length === 0;
        if (isPostinstall && behavior.failPostinstall) {
          if (cb) cb(new Error('mock postinstall failed'), '', 'boom');
        } else if (cb) {
          cb(null, '', '');
        }
      }
      return undefined;
    }),
  };
});

beforeEach(() => {
  npmInstallCapture.argv = undefined;
  execCalls.list = [];
  behavior.failPostinstall = false;
});

/** The postinstall calls the mock captured (shell command strings, not probes). */
function postinstallCalls() {
  return execCalls.list.filter(c => c.shell === true && c.args.length === 0);
}

/** Lay down the on-disk shape a real `npm install` would leave for `agent`, plus
 * an optional package.json `scripts` block, so installVersion's postinstall step
 * and integrity gate have real files to read/probe under the mocked install. */
function stageInstall(home: string, agent: string, npmPackage: string, version: string, scripts?: Record<string, string>): string {
  const versionDir = path.join(home, '.agents', '.history', 'versions', agent, version);
  // node_modules/.bin/<cli> — the integrity gate probes this on POSIX.
  const binDir = path.join(versionDir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const cli = agent === 'claude' ? 'claude' : agent;
  fs.writeFileSync(path.join(binDir, cli), `#!/bin/sh\necho ${version}\n`);
  fs.chmodSync(path.join(binDir, cli), 0o755);
  // node_modules/<npmPackage>/package.json — read by the postinstall step.
  const pkgRoot = path.join(versionDir, 'node_modules', ...npmPackage.split('/'));
  fs.mkdirSync(pkgRoot, { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: npmPackage, version, ...(scripts ? { scripts } : {}) }));
  return pkgRoot;
}

describe('installVersion npm install argv', () => {
  it('includes --ignore-scripts in npm install arguments', async () => {
    const home = makeTempHome();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { installVersion } = await import('./versions.js');
      // installVersion verifies the installed binary actually launches (an
      // integrity gate against gutted installs). The mocked `npm install` writes
      // no files, so stub the binary a real install would drop into
      // node_modules/.bin — otherwise the gate correctly fails the install and
      // this argv assertion never runs.
      const binDir = path.join(home, '.agents', '.history', 'versions', 'codex', '0.116.0', 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\necho 0.116.0\n');
      fs.chmodSync(path.join(binDir, 'codex'), 0o755);
      const result = await installVersion('codex', '0.116.0');
      expect(result.success).toBe(true);
      expect(npmInstallCapture.argv).toBeDefined();
      expect(npmInstallCapture.argv).toContain('install');
      expect(npmInstallCapture.argv).toContain('--ignore-scripts');
    } finally {
      process.env.HOME = originalHome;
    }
  });
});

describe('installVersion first-party postinstall', () => {
  it('runs the package postinstall (never prepare), scoped to the package root', async () => {
    const home = makeTempHome();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { installVersion } = await import('./versions.js');
      const pkgRoot = stageInstall(home, 'claude', '@anthropic-ai/claude-code', '2.1.186', {
        postinstall: 'node install.cjs',
        // prepare is an unconditional publish guard that exits 1 — must never run.
        prepare: "node -e \"process.exit(1)\"",
      });
      const result = await installVersion('claude', '2.1.186');
      expect(result.success).toBe(true);

      const posts = postinstallCalls();
      expect(posts).toHaveLength(1);
      expect(posts[0].file).toBe('node install.cjs');
      expect(posts[0].cwd).toBe(pkgRoot);
      // prepare must never be invoked by any execFile call.
      expect(execCalls.list.some(c => /process\.exit\(1\)/.test(c.file))).toBe(false);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('is a no-op when the package declares no postinstall', async () => {
    const home = makeTempHome();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { installVersion } = await import('./versions.js');
      stageInstall(home, 'claude', '@anthropic-ai/claude-code', '2.1.186', { build: 'tsc' });
      const result = await installVersion('claude', '2.1.186');
      expect(result.success).toBe(true);
      expect(postinstallCalls()).toHaveLength(0);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('is best-effort: a failing postinstall does not throw or fail the install', async () => {
    const home = makeTempHome();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      behavior.failPostinstall = true;
      const { installVersion } = await import('./versions.js');
      stageInstall(home, 'claude', '@anthropic-ai/claude-code', '2.1.186', { postinstall: 'node install.cjs' });
      // The postinstall is attempted (and fails), but the binary stub still lets
      // the integrity gate pass — so the overall result reflects the gate, not
      // the postinstall error, and installVersion does not throw.
      const result = await installVersion('claude', '2.1.186');
      expect(postinstallCalls()).toHaveLength(1);
      expect(result.success).toBe(true);
    } finally {
      process.env.HOME = originalHome;
    }
  });
});

describe('isMissingBinarySignature', () => {
  it('matches the claude gutted-stub phrases and the generic ENOENT signatures', async () => {
    vi.resetModules();
    const { isMissingBinarySignature } = await import('./versions.js');
    // Generic (pre-existing) signatures.
    expect(isMissingBinarySignature('spawn /x/claude ENOENT')).toBe(true);
    expect(isMissingBinarySignature("'…claude.exe' is not recognized")).toBe(true);
    // The claude stub reports its own breakage politely — these must now match.
    expect(isMissingBinarySignature('Error: claude native binary not installed.')).toBe(true);
    expect(isMissingBinarySignature('Either postinstall did not run')).toBe(true);
    expect(isMissingBinarySignature('the platform-native optional dependency was not downloaded')).toBe(true);
  });

  it('never matches a healthy --version banner', async () => {
    vi.resetModules();
    const { isMissingBinarySignature } = await import('./versions.js');
    expect(isMissingBinarySignature('2.1.186 (Claude Code)')).toBe(false);
    expect(isMissingBinarySignature('codex-cli 0.116.0')).toBe(false);
  });
});
