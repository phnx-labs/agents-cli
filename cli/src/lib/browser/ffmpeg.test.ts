import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ffmpegManualCommand, resetFfmpegResolverForTest, resolveFfmpeg } from './ffmpeg.js';

const roots: string[] = [];

afterEach(() => {
  resetFfmpegResolverForTest();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveFfmpeg', () => {
  it('uses a managed ~/.agents binary when ffmpeg is absent from PATH and resolves it only once', async () => {
    // On an ffmpeg-free host this first call exercises the real platform installer.
    const systemFfmpeg = await resolveFfmpeg();
    resetFfmpegResolverForTest();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ffmpeg-managed-'));
    roots.push(home);
    const managed = path.join(home, '.agents', '.cache', 'bin', 'ffmpeg');
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.symlinkSync(systemFfmpeg, managed);

    const options = { home, platform: process.platform, env: { PATH: '' }, executableDirs: [] } as const;
    await expect(resolveFfmpeg(options)).resolves.toBe(managed);
    fs.unlinkSync(managed);
    await expect(resolveFfmpeg(options)).resolves.toBe(managed);
  });

  it('runs an installer found outside PATH and discovers its installed binary', async () => {
    const realFfmpeg = await resolveFfmpeg();
    resetFfmpegResolverForTest();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ffmpeg-installer-'));
    roots.push(home);
    const binDir = path.join(home, 'canonical-bin');
    const managed = path.join(home, '.agents', '.cache', 'bin', 'ffmpeg');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    const brew = path.join(binDir, 'brew');
    fs.writeFileSync(brew, '#!/bin/sh\n/bin/ln -sf "$TEST_REAL_FFMPEG" "$TEST_MANAGED"\n');
    fs.chmodSync(brew, 0o755);

    await expect(resolveFfmpeg({
      home,
      platform: 'darwin',
      env: { PATH: '', TEST_REAL_FFMPEG: realFfmpeg, TEST_MANAGED: managed },
      executableDirs: [binDir],
    })).resolves.toBe(managed);
    expect(fs.realpathSync(managed)).toBe(fs.realpathSync(realFfmpeg));
  });

  it('fails loud with the exact macOS manual command when neither a binary nor installer exists', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ffmpeg-missing-'));
    roots.push(home);
    await expect(resolveFfmpeg({ home, platform: 'darwin', env: { PATH: '' }, executableDirs: [] })).rejects.toThrow(
      'Run `brew install ffmpeg`, then retry.',
    );
  });

  it('names apt-get exactly for Debian and Ubuntu', () => {
    expect(ffmpegManualCommand('linux', 'ID=ubuntu')).toBe(
      'sudo apt-get update && sudo apt-get install -y ffmpeg',
    );
    expect(ffmpegManualCommand('linux', 'ID_LIKE="debian"')).toBe(
      'sudo apt-get update && sudo apt-get install -y ffmpeg',
    );
  });
});
