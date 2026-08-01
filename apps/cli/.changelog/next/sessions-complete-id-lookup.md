- **`agents sessions <full-session-id>` no longer answers with an unrelated
  session.** A complete id that was not in the local index fell through to the
  FTS content search, which tokenizes the UUID and matches every transcript that
  merely *mentions* it. The miss surfaced as up to ten unrelated sessions under
  `Multiple sessions match "<id>"` plus the advice `Pass a longer ID to narrow it
  down` — impossible to follow, since a full id is already the longest form. The
  same fallthrough made `--preview` render a different session's transcript, let
  an 8-char short id lose to a content hit, and made `agents sessions export
  <id>` bundle every transcript that mentions the id (14 unrelated sessions
  written into an archive meant to be handed to someone else). A query that is a
  whole session id now resolves by id alone: it reports `No session with id <id>
  on this machine.` and points at `--device <host>` for the fleet. Short-id
  prefixes and text searches are unchanged. The recognized shapes are the ones
  the index actually holds — a bare UUID, `session_` + UUID (kimi, rush), and
  `ses_` + 26-char ULID (opencode); routine run ids and cloud execution ids stay
  out of scope and keep today's search behavior. Source:
  `apps/cli/src/lib/session/discover.ts` (`isCompleteSessionId`),
  `apps/cli/src/commands/sessions.ts` (`resolveSessionQuery`), and
  `apps/cli/src/commands/sessions-export.ts` (`selectSessions`).
