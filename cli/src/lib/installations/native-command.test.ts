import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('finite native account command', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-command-'));
    vi.stubEnv('HOME', root);
  });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

  it('executes a fast native command under the selected home and releases its lease', async () => {
    const { createInstallation } = await import('./store.js');
    const { runNativeAccountCommand } = await import('./native-command.js');
    const { hasLiveLaunchLease } = await import('./shims.js');
    const dir = path.join(root, '.agents', '.history', 'versions', 'codex', 'main');
    const bin = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    const script = path.join(bin, 'command.js');
    const result = path.join(root, 'result.json');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(result)}, JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME}));`);
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    } else {
      fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node\nrequire(${JSON.stringify(script)});`, { mode: 0o755 });
    }
    createInstallation('codex', 'main', '0.153.4');
    const selected = path.join(dir, 'home', '.codex');
    expect(await runNativeAccountCommand('codex', 'main', ['login', 'status'], { ...process.env, CODEX_HOME: selected })).toEqual({ code: 0 });
    expect(JSON.parse(fs.readFileSync(result, 'utf8'))).toEqual({ args: ['login', 'status'], home: selected });
    expect(hasLiveLaunchLease('codex', 'main')).toBe(false);
  });
});
