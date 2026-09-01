/**
 * Compose an owner-bound phone ping through the SAME shaper `agents feed post`
 * uses, so `agents notify` / `agents send --to owner` stop shipping a raw body
 * dump (PHNX-3698).
 *
 * Before this, an owner send delivered the body verbatim: a long wall of prose,
 * a `TEAM-N` key iMessage renders as dead text, and no way back to the session.
 * Routing the body through {@link composeBroadcastMessage} makes an owner ping
 * identical to an important feed post of the same event — short-shaped body,
 * every ticket key linkified to its Linear URL, and the current session's
 * `…/console/sessions/<id>` page as a tappable crumb.
 *
 * The session/agent/host are resolved the same way a feed post resolves them
 * ({@link resolvePostIdentity} — the pid-registry / env walk), so a `notify`
 * run inside an agent session inherits that session with no flag. Outside a
 * session (a human at a shell) identity is undefined: the ping still gets
 * short-shaping and ticket linkification, just no session crumb.
 */
import { composeBroadcastMessage, type FeedBroadcastContext } from './feed-broadcast.js';
import { resolvePostIdentity } from './feed-post.js';
import { getSessionById, resolveFullSessionId } from './session/db.js';
import { linearIssueUrl } from './session/linear.js';

export interface OwnerMessageOptions {
  /** Scannable subject line, when the caller has one (feed post does; notify does not). */
  title?: string;
  /** Explicit session id (`--session`); otherwise resolved from the run environment. */
  sessionId?: string;
}

/**
 * Shape a raw owner-send body into the composed broadcast message. Pure except
 * for the identity/index reads that {@link resolvePostIdentity} /
 * {@link getSessionById} already perform for feed posts.
 */
export function composeOwnerMessage(rawText: string, opts: OwnerMessageOptions = {}): string {
  const identity = resolvePostIdentity({ sessionId: opts.sessionId });
  // A footer crumb that would 404 (an 8-char short id) is upgraded to the full
  // indexed id so the console URL resolves; a full/native id passes through.
  const session = resolveFullSessionId(identity?.sessionId);
  const ticket = session ? getSessionById(session)?.ticketId : undefined;
  const ctx: FeedBroadcastContext = {
    ...(opts.title?.trim() ? { title: opts.title.trim() } : {}),
    text: rawText,
    level: 'important',
    ...(ticket ? { ticket, ticketUrl: linearIssueUrl(ticket) } : {}),
    ...(identity?.agent ? { agent: identity.agent } : {}),
    ...(identity?.host ? { host: identity.host } : {}),
    ...(session ? { session } : {}),
  };
  return composeBroadcastMessage(ctx);
}
