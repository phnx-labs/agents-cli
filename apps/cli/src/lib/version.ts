import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cached: string | null = null;

/**
 * Resolve the CLI version from the shipping package.json. Used by the daemon
 * to answer `IPCAction: 'version'` and by the client to detect daemon drift —
 * a dev-build CLI talking to a launchd-managed registry daemon would silently
 * get stale behavior without this check.
 */
export function getCliVersion(): string {
  if (cached) return cached;
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    cached = String(pkg.version || 'unknown');
  } catch {
    cached = 'unknown';
  }
  return cached;
}

/**
 * Read the version from package.json on disk every call, bypassing the cache.
 *
 * `getCliVersion()` memoizes the version a long-running process *started* with.
 * After `npm i -g` overwrites the install in place, the on-disk package.json
 * changes but the running process keeps its old in-memory code. Comparing this
 * fresh read against the cached startup value is how a daemon/broker detects it
 * is now stale and should reload onto the new code (self-healing). Returns
 * 'unknown' on any error.
 */
export function getCliVersionFresh(): string {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return String(pkg.version || 'unknown');
  } catch {
    return 'unknown';
  }
}
