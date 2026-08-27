import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let resolvedFfmpeg: Promise<string> | undefined;

type Platform = NodeJS.Platform;

function pathCandidates(env: NodeJS.ProcessEnv, platform: Platform): string[] {
  const names = platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

function managedCandidates(home: string, platform: Platform): string[] {
  const name = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return [
    path.join(home, '.agents', '.cache', 'bin', name),
    path.join(home, '.agents', '.cache', 'ffmpeg', 'bin', name),
  ];
}

async function isUsable(binary: string): Promise<boolean> {
  try {
    await execFileAsync(binary, ['-version'], { timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function firstUsable(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && await isUsable(candidate)) return candidate;
  }
  return undefined;
}

function commandOnPath(name: string, env: NodeJS.ProcessEnv, platform: Platform): string | undefined {
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const candidate of names.map((entry) => path.join(dir, entry))) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function ffmpegManualCommand(platform: Platform, osRelease = ''): string {
  if (platform === 'darwin') return 'brew install ffmpeg';
  if (platform === 'win32') return 'winget install Gyan.FFmpeg';
  if (/\b(ID|ID_LIKE)=(?:"[^"]*\b)?(?:ubuntu|debian)\b/m.test(osRelease)) {
    return 'sudo apt-get update && sudo apt-get install -y ffmpeg';
  }
  return 'install ffmpeg with your system package manager';
}

function readOsRelease(): string {
  try { return fs.readFileSync('/etc/os-release', 'utf8'); } catch { return ''; }
}

type InstallStep = { command: string; args: string[] };

function installAttempt(platform: Platform, env: NodeJS.ProcessEnv, osRelease: string): InstallStep[] | undefined {
  if (platform === 'darwin') {
    const brew = commandOnPath('brew', env, platform);
    return brew ? [{ command: brew, args: ['install', 'ffmpeg'] }] : undefined;
  }
  if (platform === 'win32') {
    const winget = commandOnPath('winget', env, platform);
    return winget ? [{ command: winget, args: ['install', '--id', 'Gyan.FFmpeg', '--exact', '--accept-source-agreements', '--accept-package-agreements'] }] : undefined;
  }
  if (platform !== 'linux') return undefined;

  if (/\b(ID|ID_LIKE)=(?:"[^"]*\b)?(?:ubuntu|debian)\b/m.test(osRelease)) {
    const apt = commandOnPath('apt-get', env, platform);
    if (!apt) return undefined;
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return [
        { command: apt, args: ['update'] },
        { command: apt, args: ['install', '-y', 'ffmpeg'] },
      ];
    }
    const sudo = commandOnPath('sudo', env, platform);
    return sudo ? [
      { command: sudo, args: ['-n', apt, 'update'] },
      { command: sudo, args: ['-n', apt, 'install', '-y', 'ffmpeg'] },
    ] : undefined;
  }

  const managers: Array<[string, string[]]> = [
    ['apk', ['add', 'ffmpeg']],
    ['dnf', ['install', '-y', 'ffmpeg']],
    ['yum', ['install', '-y', 'ffmpeg']],
    ['pacman', ['-S', '--noconfirm', 'ffmpeg']],
    ['zypper', ['--non-interactive', 'install', 'ffmpeg']],
  ];
  for (const [name, args] of managers) {
    const command = commandOnPath(name, env, platform);
    if (command) return [{ command, args }];
  }
  return undefined;
}

export async function resolveFfmpeg(options: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: Platform;
  osRelease?: string;
} = {}): Promise<string> {
  if (resolvedFfmpeg) return resolvedFfmpeg;
  resolvedFfmpeg = (async () => {
    const env = options.env ?? process.env;
    const home = options.home ?? os.homedir();
    const platform = options.platform ?? os.platform();
    const osRelease = options.osRelease ?? readOsRelease();
    const candidates = [...pathCandidates(env, platform), ...managedCandidates(home, platform)];
    const existing = await firstUsable(candidates);
    if (existing) return existing;

    const attempt = installAttempt(platform, env, osRelease);
    let failure = 'no supported automatic installer was found';
    if (attempt) {
      try {
        for (const step of attempt) {
          await execFileAsync(step.command, step.args, {
            env,
            timeout: 10 * 60_000,
            windowsHide: true,
          });
        }
        const installed = await firstUsable([...pathCandidates(env, platform), ...managedCandidates(home, platform)]);
        if (installed) return installed;
        failure = `${path.basename(attempt.at(-1)!.command)} completed but ffmpeg is still unavailable`;
      } catch (error) {
        failure = `${path.basename(attempt.at(-1)!.command)} failed: ${(error as Error).message}`;
      }
    }

    const manual = ffmpegManualCommand(platform, osRelease);
    throw new Error(`ffmpeg is required for browser recording and automatic installation failed (${failure}). Run \`${manual}\`, then retry.`);
  })();
  try {
    return await resolvedFfmpeg;
  } catch (error) {
    resolvedFfmpeg = undefined;
    throw error;
  }
}

export function resetFfmpegResolverForTest(): void {
  resolvedFfmpeg = undefined;
}
