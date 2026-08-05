// Pure logic for the agent status bar's version/account fields. Kept vscode-free
// so it is unit-tested directly (src/core convention). The VS Code layer
// (src/vscode/extension.ts) passes an EditorTerminal, which structurally provides
// these fields.

/** The subset of a terminal registry entry the status bar reads for identity. */
export interface StatusIdentitySource {
  /** Session id the version/account below were APPLIED for (the display gate).
   * Distinct from the entry's retry gate (`identitySessionId`, which requires both
   * fields present): a version-only harness (Grok/Cursor/Droid) has this set with
   * a null account, so its version still shows. */
  identityAppliedSessionId?: string;
  version?: string;
  statusVersion?: string;
  account?: string;
  statusAccount?: string;
}

/** Strip angle brackets/whitespace from an account email; empty -> undefined. */
export function normalizeStatusEmail(email: string | null | undefined): string | undefined {
  const trimmed = email?.replace(/[<>]/g, '').trim();
  return trimmed || undefined;
}

/**
 * The version + account to DISPLAY for the session id currently shown. Only an
 * identity resolved FOR that exact session is returned; a value cached from a
 * prior binding in the same terminal (a rerun, /clear, or shell-adoption that
 * changed the session) is withheld until the current session's identity resolves.
 *
 * This is the guard against the reported bug: a Kimi tab showed a Claude `2.1.218`
 * and a stranger session id because the leftover identity of a previous binding
 * was rendered. Blank-until-resolved beats wrong.
 */
export function displayIdentity(
  entry: StatusIdentitySource | undefined,
  sessionId: string | undefined,
): { version?: string; account?: string } {
  const fresh = !!sessionId && entry?.identityAppliedSessionId === sessionId;
  if (!fresh) return {};
  return {
    version: entry?.version || entry?.statusVersion || undefined,
    account: normalizeStatusEmail(entry?.account || entry?.statusAccount),
  };
}
