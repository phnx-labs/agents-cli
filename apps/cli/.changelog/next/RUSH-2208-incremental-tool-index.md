- **`agents sessions backfill tools` reads a growing transcript incrementally, and
  the search index compacts itself (RUSH-2208).** Incremental discovery already
  appended tool calls for a Claude/Codex session that grew; the backfill did not.
  Every `ensureToolIndex` pass re-read the transcript from byte 0 and deleted the
  session's stored evidence to rewrite it, so a session backfilled N times cost N
  full parses of an ever-larger file — measured on a 4.5 MiB, 4000-call transcript
  that grew by 20 calls: 344 ms and 4020 calls re-parsed, now 12 ms and 20 calls.
  Schema v36 adds a resume point to `tool_scan_ledger` (`parsed_offset`, the byte
  just past the last complete record consumed, and `parser_state`, the collector
  snapshot at that offset), so a transcript that only grew is read from where the
  last pass stopped and merged into what is already stored; the batch byte budget
  now counts the bytes a pass actually reads rather than the file's size, so one
  bounded batch covers far more growing sessions. A different extractor version, a
  mismatched ledger path, a file shorter than what was parsed, or an unreadable
  snapshot still re-reads the whole file. Two related fixes ride along:
  `tool_call_text` rows are addressed by the `rowid` of the call they describe
  instead of the UNINDEXED `call_key`, which made every delete a full scan of the
  FTS index, and the scan path now runs a bounded, threshold-gated FTS `'merge'`
  after each batch of writes, so index health no longer depends on someone running
  `agents sessions optimize` by hand. Source: `apps/cli/src/lib/session/tool-index.ts`,
  `apps/cli/src/lib/session/tool-store.ts`, `apps/cli/src/lib/session/db.ts`.
