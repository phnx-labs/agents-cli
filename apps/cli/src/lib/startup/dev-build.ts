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
 * Fix: resolve the symlink with realpath, then require the `.git`'s repo root to
 * actually be the agents-cli package (its package.json `name`), not some
 * unrelated ancestor that happens to be version-controlled.
 */
export function detectDevBuild(argv1: string, version: string): boolean {
  if (version.startsWith('0.0.0-dev')) return true;
  try {
    const cliPath = fs.realpathSync(argv1 || '');
    const repoRoot = path.dirname(path.dirname(cliPath));
    if (!fs.existsSync(path.join(repoRoot, '.git'))) return false;
    const pkgPath = path.join(repoRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const name = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))?.name;
    return name === '@phnx-labs/agents-cli';
  } catch {
    return false;
  }
}
