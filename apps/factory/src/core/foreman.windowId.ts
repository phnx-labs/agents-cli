/**
 * Build a windowId string used as the per-window slice key in
 * `~/.agents/.cache/terminals/live-terminals.json`.
 *
 * Lives in /core (no vscode dep) so it can be unit-tested with real inputs —
 * notably the `"someValue.sessionId"` placeholder VSCodium ships when
 * telemetry is stripped, which collapses every window onto the same key.
 *
 * Mixing in process.pid unconditionally guarantees per-window uniqueness:
 * each VS Code / Cursor / Codium window runs its own extension-host process.
 */
export function computeWindowId(sessionId: string | undefined, pid: number): string {
  return `${sessionId ?? 'no-session'}-${pid}`;
}
