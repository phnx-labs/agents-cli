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
