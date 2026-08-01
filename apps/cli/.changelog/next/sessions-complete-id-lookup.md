- **`agents sessions <full-session-id>` no longer answers with an unrelated
  session.** A complete id that was not in the local index fell through to the
  FTS content search, which tokenizes the UUID and matches every transcript that
  merely *mentions* it. The miss surfaced as up to ten unrelated sessions under
  `Multiple sessions match "<id>"` plus the advice `Pass a longer ID to narrow it
  down` — impossible to follow, since a full id is already the longest form. The
  same fallthrough made `--preview` render a different session's transcript, and
  an 8-char short id could lose to a content hit. A query that is a whole session
  id (a 36-char UUID, optionally carrying a `session_` / `ses_` / `api-` prefix)
  now resolves by id alone: it reports `No session with id <id> on this machine.`
  and points at `--device <host>` for the fleet. Short-id prefixes and text
  searches are unchanged. Source: `apps/cli/src/lib/session/discover.ts`
  (`isCompleteSessionId`) and `apps/cli/src/commands/sessions.ts`
  (`resolveSessionQuery`).
