import * as os from 'os';
import * as path from 'path';
import { commonBinDirs, resolveExecutable } from './binResolve';

export const LINEAR_NOT_FOUND_MESSAGE =
  'Linear CLI not found. Install it at ~/.local/bin/linear.';

export function linearBinDirs(
  home: string = os.homedir(),
  pathEnv: string = process.env.PATH ?? '',
): string[] {
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const directory of [path.join(home, '.local', 'bin'), ...commonBinDirs(pathEnv)]) {
    if (directory.length === 0 || seen.has(directory)) continue;
    seen.add(directory);
    directories.push(directory);
  }
  return directories;
}

export function resolveLinearBin(dirs: string[] = linearBinDirs()): string | null {
  return resolveExecutable('linear', dirs);
}
