/**
 * Shared helpers for the Linux/Windows encrypted-file fallback.
 *
 * When the native credential store (GNOME Keyring / Windows Credential Manager)
 * is unreachable, both backends route to the AES-256-GCM file store. The routing
 * is "sticky": once any item is on disk, every op stays on the file store. That
 * is correct for perf, but on its own it would silently *shadow* secrets that
 * still live in the native store — reads for them would return empty with no
 * hint. This module centralizes the two pieces that keep that from being silent:
 *
 *   1. `noteNativeShadow()` — a one-time stderr notice, emitted when a read
 *      falls through to the native store (found something shadowed, or hit a
 *      locked/unreachable store), pointing at `agents secrets import-keyring`.
 *   2. The result types for that import command.
 *
 * macOS has no file fallback (see ./index.ts) and uses `migrate-acl` /
 * `migrate-orphans` for its own invisible-item classes, so none of this runs
 * there.
 */

export type NativeImportStatus = 'imported' | 'would-import' | 'exists' | 'failed';

export interface NativeImportResult {
  item: string;
  status: NativeImportStatus;
  detail?: string;
}

/**
 * Outcome of an `import-keyring` run. `available` is false when no native
 * tooling exists (no `secret-tool` / no `powershell.exe`); `locked` is true when
 * the native store exists but is locked/unreachable, so nothing could be read.
 */
export interface NativeImportReport {
  available: boolean;
  locked: boolean;
  results: NativeImportResult[];
}

let noticeEmitted = false;

/**
 * Emit a one-time stderr notice that the file fallback is masking the native
 * credential store. Both backends share the copy so the guidance is identical.
 *
 *   'shadowed' — a secret was just read from the native store that isn't in the
 *                file store. It works, but each read pays a native lookup and it
 *                won't survive the store locking; suggest migrating it.
 *   'locked'   — the native store is locked/unreachable, so its secrets can't be
 *                read in this session at all; the user must unlock, then migrate.
 */
export function noteNativeShadow(kind: 'shadowed' | 'locked', fileDir: string): void {
  if (noticeEmitted) return;
  noticeEmitted = true;
  if (kind === 'locked') {
    process.stderr.write(
      `[agents] the native credential store is locked/unreachable — secrets stored there are not ` +
      `readable in this session. Unlock it, then run \`agents secrets import-keyring\` to migrate ` +
      `them into the encrypted file store at ${fileDir}.\n`
    );
  } else {
    process.stderr.write(
      `[agents] read a secret from the native credential store that is not in the file store at ` +
      `${fileDir}. Run \`agents secrets import-keyring\` to migrate it so it stays readable headless.\n`
    );
  }
}

/** Test-only: clear the one-time notice guard between cases. */
export function _resetFallbackNoticeForTest(): void {
  noticeEmitted = false;
}
