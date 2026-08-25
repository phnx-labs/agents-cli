import * as fs from 'fs';
import * as path from 'path';

/**
 * Decide whether the CLI is running from a source checkout (a "dev build") vs an
 * installed package. Dev builds suppress autopull / migrations / auto-update so
 * iterating on the repo never mutates the user's real setup.
 *
 * Two signals:
 *   1. A `0.0.0-dev*` version stamp (scripts/install.sh dev installs).
 *   2. Running out of an actual agents-cli git checkout.
 *
 * Signal 2 must be precise. The naive check —
 * `existsSync(dirname(dirname(argv[1])) + '/.git')` — false-positives badly:
 *   - npm-global bins are symlinks. `/opt/homebrew/bin/agents` →
 *     `…/node_modules/@phnx-labs/agents-cli/dist/index.js`. Without resolving the
 *     symlink, `dirname(dirname())` walks to `/opt/homebrew`, which is **itself a
 *     git repo** (Homebrew). So every Homebrew-node user looked like a dev build
 *     and had migrations + the menu-bar self-heal silently disabled.
 *
 * Fix: resolve the symlink with realpath and require the resolved package root's
 * own package.json `name` to actually be the agents-cli package, before ever
 * looking for `.git`.
 *
 * That package root does not always hold `.git` itself, though — this repo is a
 * monorepo where the package lives at `cli` and `.git` sits one level
 * higher, at the true repo root. `.git` is therefore searched for in a SMALL,
 * bounded set of ancestors above the package root (see
 * `DEV_BUILD_GIT_ANCESTOR_DEPTH`), not just the package root itself — a source
 * checkout run via tsx/ts-node from `cli/src/` or built to
 * `cli/dist/` must still be recognized. The bound keeps this well short of
 * an unrelated ancestor repo: a real Homebrew npm-global install's package root
 * sits 3 directories below `/opt/homebrew` (`lib/node_modules/@phnx-labs/…`),
 * so a depth of 2 finds this repo's `.git` while staying short of Homebrew's.
 */
const DEV_BUILD_GIT_ANCESTOR_DEPTH = 2;
/**
 * Whether a version string is the `0.0.0-dev.<sha>[-dirty]` stamp
 * `scripts/install.sh` writes for a side-by-side dev install (`install.sh:61`).
 *
 * Split out from {@link detectDevBuild} because a caller holding only a version
 * string — a fleet rollout reading `agents --version` off a remote box — cannot
 * run signal 2 (it needs that machine's filesystem), and must not re-spell the
 * stamp prefix.
 */
export function isDevVersionStamp(version: string): boolean {
  return version.startsWith('0.0.0-dev');
}

export function detectDevBuild(argv1: string, version: string): boolean {
  if (isDevVersionStamp(version)) return true;
  try {
    const cliPath = fs.realpathSync(argv1 || '');
    const packageRoot = path.dirname(path.dirname(cliPath));
    const pkgPath = path.join(packageRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const name = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))?.name;
    if (name !== '@phnx-labs/agents-cli') return false;

    let dir = packageRoot;
    for (let depth = 0; depth <= DEV_BUILD_GIT_ANCESTOR_DEPTH; depth++) {
      if (fs.existsSync(path.join(dir, '.git'))) return true;
      const parent = path.dirname(dir);
      if (parent === dir) return false; // reached the filesystem root
      dir = parent;
    }
    return false;
  } catch {
    return false;
  }
}
