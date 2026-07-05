import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn((file, args, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      if (file === 'npm' && Array.isArray(args) && args[0] === 'install') {
        npmInstallCapture.argv = args;
        if (cb) cb(null, 'mock npm install success', '');
      } else if (file === 'npm' && Array.isArray(args) && args[0] === '--version') {
        if (cb) cb(null, '10.0.0', '');
      } else {
        if (cb) cb(new Error(`unexpected execFile call: ${file} ${args?.join(' ')}`), '', '');
      }
      return undefined;
    }),
  };
});

describe('installVersion npm install argv', () => {
  it('includes --ignore-scripts in npm install arguments', async () => {
    const home = makeTempHome();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { installVersion } = await import('./versions.js');
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
