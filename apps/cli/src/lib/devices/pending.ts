/**
 * "Pending device" sentinels.
 *
 * When the daemon's tailscale probe finds a node that is neither registered nor
 * ignored, it drops a sentinel file under ~/.agents/.cache/state/devices-pending/
 * — the same filesystem-signal pattern the attention hook uses for the menu bar.
 * The Swift helper polls that dir every 10s and renders a "NEW DEVICES" section
 * with Register / Ignore. The file NAME is the device name; the file CONTENT is
 * the platform (one line), so the tray can show "zion (macos)" without opening
 * the registry.
 *
 * The daemon owns writes (reconcile to match the current pending set); the CLI
 * `agents devices register|ignore` clears a single sentinel the moment the user
 * acts, so the badge updates immediately instead of waiting for the next probe.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getDevicesPendingDir } from '../state.js';
import { loadIgnored } from './registry.js';

export interface PendingDevice {
  name: string;
  platform: string;
}

/** Device-name sentinels must be safe filenames (no path traversal). The device
 * name charset is already the ssh-alias set, but guard defensively. */
function isSafeName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/**
 * Make the sentinel dir exactly match `pending`: create a file per pending
 * device (content = platform), and delete any leftover sentinel whose device is
 * no longer pending (it got registered, ignored, or left the tailnet). Best-
 * effort — a filesystem error here must never crash the daemon, so callers pass
 * this through their existing try/catch.
 *
 * The sentinel writer is the single authoritative choke point every discovery
 * path flows through (the daemon device-probe timer and `agents sync`), so it
 * re-subtracts the persisted ignore-list here rather than trusting the caller's
 * `pending` set. This closes the probe/ignore race (RUSH-2495): a probe that
 * computed `pending` BEFORE the user pressed "Ignore" (which persists the
 * dismissal via `addIgnored`) would otherwise re-create the just-dismissed
 * device's sentinel and the menu bar would re-surface it. A device on the
 * ignore-list is never written, regardless of what the caller passed.
 */
export async function reconcilePendingSentinels(pending: PendingDevice[]): Promise<void> {
  const dir = getDevicesPendingDir();
  // Best-effort: a corrupted ignore-list (loadIgnored throws by design) must not
  // crash the daemon loop — treat it as "nothing ignored" and let the next probe
  // recover once the file is fixed, rather than failing the whole reconcile.
  let ignored: Set<string>;
  try { ignored = await loadIgnored(); } catch { ignored = new Set(); }
  const want = new Map(
    pending
      .filter((p) => isSafeName(p.name) && !ignored.has(p.name))
      .map((p) => [p.name, p.platform]),
  );

  // Whole body is best-effort: a filesystem error here must never propagate into
  // the daemon loop or `agents sync`. The top-level mkdir/readdir are guarded
  // too, so no caller needs its own try/catch.
  let existing: string[];
  try {
    fs.mkdirSync(dir, { recursive: true });
    existing = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return;
  }

  // Remove sentinels that are no longer pending.
  for (const name of existing) {
    if (!want.has(name)) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* already gone */ }
    }
  }
  // Write/refresh the sentinels that should exist.
  for (const [name, platform] of want) {
    const p = path.join(dir, name);
    const body = `${platform}\n`;
    // Only write when missing or changed, to avoid needless mtime churn.
    let current: string | null = null;
    try { current = fs.readFileSync(p, 'utf-8'); } catch { current = null; }
    if (current !== body) {
      try { fs.writeFileSync(p, body); } catch { /* best-effort */ }
    }
  }
}

/** Remove one device's pending sentinel (after the user registers or ignores it).
 * No-op if it doesn't exist. */
export function clearPendingSentinel(name: string): void {
  if (!isSafeName(name)) return;
  try { fs.unlinkSync(path.join(getDevicesPendingDir(), name)); } catch { /* already gone */ }
}

/** Read the current pending sentinels (name + platform). Used by tests and any
 * TS-side consumer; the menu-bar helper reads the dir directly in Swift. */
export function readPendingSentinels(): PendingDevice[] {
  const dir = getDevicesPendingDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
  return names.map((name) => {
    let platform = 'unknown';
    try { platform = fs.readFileSync(path.join(dir, name), 'utf-8').trim() || 'unknown'; } catch { /* keep default */ }
    return { name, platform };
  });
}
