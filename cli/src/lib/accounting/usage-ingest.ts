/**
 * The `agents __usage-ingest` receiver (PHNX-3392 usage-sync).
 *
 * A headed peer's daemon pipes a {@link UsageSyncPayload} JSON envelope to our
 * stdin; we merge its identity-keyed rows into the local usage cache newest-wins
 * ({@link ingestPeerClaudeUsageRows}). Hidden internal verb — intercepted in
 * index.ts before bootstrap, so it never triggers an update check or a detached
 * sync, and it writes NOTHING to stdout (the caller only reads the exit code).
 *
 * Exit codes: 0 = merged (or nothing to merge — an empty payload is not an error),
 * 2 = malformed input. It fails loud on a bad envelope rather than silently
 * accepting a wrong shape, but a busy cache lock degrades to best-effort inside
 * `ingestPeerClaudeUsageRows` like every other cache writer.
 */
import { ingestPeerClaudeUsageRows } from './usage.js';
import type { UsageSyncPayload } from './usage-sync.js';

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

export async function runUsageIngest(): Promise<number> {
  const raw = (await readStdin()).trim();
  if (!raw) return 0; // nothing piped — a no-op tick, not a failure.

  let payload: UsageSyncPayload;
  try {
    payload = JSON.parse(raw) as UsageSyncPayload;
  } catch {
    process.stderr.write('[agents] __usage-ingest: malformed JSON payload\n');
    return 2;
  }

  if (!payload || payload.v !== 1 || typeof payload.rows !== 'object' || payload.rows === null) {
    process.stderr.write('[agents] __usage-ingest: unrecognized usage-sync payload shape\n');
    return 2;
  }

  ingestPeerClaudeUsageRows(payload.rows);
  return 0;
}
