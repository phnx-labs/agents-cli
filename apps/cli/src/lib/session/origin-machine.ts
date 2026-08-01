/**
 * Resolve which machine a session transcript originated on.
 *
 * Cross-machine sync mirrors a remote transcript to
 * `backups/<agent>/<machine>/<subdir>/…`. Every other transcript is a live-home
 * file on this box, so the origin is the local machine id.
 *
 * Kept in a leaf module (no session/db imports) so both discovery and the
 * sessions DB upsert path can stamp `machine` without circular deps.
 */

import * as path from 'path';
import { getHistoryDir } from '../state.js';
import { machineId } from '../machine-id.js';

let _localMachineId: string | undefined;

/** Local machine id, cached for the process lifetime. */
export function localMachineId(): string {
  return (_localMachineId ??= machineId());
}

/**
 * The machine a discovered session originated on.
 * When the path sits under the agent's backups root, the first segment below it
 * is the origin machine id; otherwise it's the local machine.
 */
export function machineForSessionFile(filePath: string, agent: string): string {
  if (!filePath) return localMachineId();
  const base = path.join(getHistoryDir(), 'backups', agent) + path.sep;
  if (filePath.startsWith(base)) {
    const seg = filePath.slice(base.length).split(path.sep)[0];
    if (seg) return seg;
  }
  return localMachineId();
}
