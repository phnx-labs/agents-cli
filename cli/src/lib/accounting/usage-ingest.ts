/**
 * The `agents __usage-ingest` receiver (PHNX-3392 usage-sync).
 *
 * A legacy headed peer may pipe a {@link UsageSyncPayload} JSON envelope to our
 * stdin; we merge its identity-keyed rows into the local usage cache newest-wins
 * ({@link ingestPeerClaudeUsageRows}). Hidden internal verb — intercepted in
 * index.ts before bootstrap, so it never triggers an update check or a detached
 * sync, and it writes NOTHING to stdout (the caller only reads the exit code).
 *
 * Exit codes: 0 = merged (or nothing to merge — an empty payload is not an error),
 * 2 = malformed input. It fails loud on a bad envelope rather than silently
 * accepting a wrong shape, but a busy cache lock degrades to best-effort inside
 * `ingestPeerClaudeUsageRows` like every other cache writer.
 *
 * New daemon ticks use the fleet-shared store instead. This compatibility
 * receiver remains for older installed versions. The payload arrives on stdin,
 * EXCEPT on a Windows receiver: the `agents.ps1`
 * shim does not forward ssh-piped stdin to the node process, so the pusher writes
 * the payload to a temp file and passes `agents __usage-ingest --from <path>`
 * (the same workaround the secrets push uses — `buildWindowsStdinImportCommand`).
 */
import * as fs from 'fs';
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

/** `--from <path>` reads the payload from a file instead of stdin (Windows path). */
function fromFileArg(argv: string[]): string | null {
  const i = argv.indexOf('--from');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

export async function runUsageIngest(): Promise<number> {
  const fromPath = fromFileArg(process.argv.slice(3));
  let source: string;
  if (fromPath) {
    try {
      source = fs.readFileSync(fromPath, 'utf-8');
    } catch (err) {
      process.stderr.write(`[agents] __usage-ingest: cannot read --from ${fromPath}: ${(err as Error).message}\n`);
      return 2;
    }
  } else {
    source = await readStdin();
  }
  const raw = source.trim();
  if (!raw) return 0; // nothing piped — a no-op tick, not a failure.

  let payload: UsageSyncPayload;
  try {
    payload = JSON.parse(raw) as UsageSyncPayload;
  } catch {
    process.stderr.write('[agents] __usage-ingest: malformed JSON payload\n');
    return 2;
  }

  if (
    !payload ||
    payload.v !== 1 ||
    typeof payload.rows !== 'object' ||
    payload.rows === null ||
    Array.isArray(payload.rows) // `typeof [] === 'object'` — an array is NOT a rows map
  ) {
    process.stderr.write('[agents] __usage-ingest: unrecognized usage-sync payload shape\n');
    return 2;
  }

  ingestPeerClaudeUsageRows(payload.rows);
  return 0;
}
