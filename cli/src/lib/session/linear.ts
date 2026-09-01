/**
 * Resolve a clickable Linear issue URL for a tracker key (e.g. `RUSH-1234`).
 *
 * Linear issue URLs are workspace-scoped — `https://linear.app/<workspace>/issue/<KEY>`
 * — so a bare key can't be linked without knowing the workspace slug (Linear's
 * `organization.urlKey`). That slug is resolved config-first, never hardcoded:
 *
 *   1. `LINEAR_WORKSPACE` env var — explicit override, else
 *   2. `workspaceUrlKey` in the linear-cli config (`~/.linear-cli/config.json`).
 *
 * When neither is set the ticket stays plain text — it's still shown, just not
 * linked. This keeps the published CLI free of any Rush/workspace-specific string.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A Linear tracker key: `TEAM-N`, e.g. `RUSH-1234`. Mirrors the detector's shape. */
const LINEAR_KEY_RE = /^[A-Z]{2,6}-\d{1,6}$/;

/**
 * The same key, matched inside free text on word boundaries. Uppercase-only team
 * key (2–6 letters) so a lowercase `utf-8` can't masquerade as a ticket. Global
 * so {@link linearIssueKeys} can pull every mention out of a body.
 */
const LINEAR_KEY_IN_TEXT_RE = /\b([A-Z]{2,6}-\d{1,6})\b/g;

/**
 * Team prefixes that match the key shape but are not trackers — unit strings and
 * common acronyms. Canonical here (the Linear module) so both the URL linkifier
 * and the session-transcript ticket detector (`detectTicket` in `state.ts`) agree
 * on what is a real key rather than each keeping its own copy.
 */
export const LINEAR_KEY_DENYLIST: ReadonlySet<string> = new Set([
  'UTF',
  'SHA',
  'ISO',
  'RFC',
  'IPV',
  'X86',
  'ARM',
  'MP',
  'H',
]);

/**
 * Every distinct real Linear key mentioned in free text, in first-seen order.
 * Honours {@link LINEAR_KEY_DENYLIST} so `UTF-8` / `X86-64` never count. Used to
 * linkify ticket ids an owner ping only names in prose (no `session.ticketId`).
 */
export function linearIssueKeys(text: string | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const m of text.matchAll(LINEAR_KEY_IN_TEXT_RE)) {
    const key = m[1];
    if (LINEAR_KEY_DENYLIST.has(key.split('-')[0])) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

// `undefined` = not yet resolved; `null` = resolved-but-unknown (skip re-reading).
let workspaceCache: string | null | undefined;

/** The configured Linear workspace slug, or undefined when unknown. Cached per process. */
export function linearWorkspace(): string | undefined {
  if (workspaceCache !== undefined) return workspaceCache ?? undefined;

  const env = process.env.LINEAR_WORKSPACE?.trim();
  if (env) {
    workspaceCache = env;
    return env;
  }

  try {
    const cfgPath = path.join(os.homedir(), '.linear-cli', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { workspaceUrlKey?: string };
    const ws = cfg.workspaceUrlKey?.trim();
    if (ws) {
      workspaceCache = ws;
      return ws;
    }
  } catch {
    // no linear-cli config (or unreadable) — leave tickets unlinked
  }

  workspaceCache = null;
  return undefined;
}

/** Canonical Linear issue URL for a tracker key, or undefined if unresolvable. */
export function linearIssueUrl(ticketId?: string): string | undefined {
  if (!ticketId || !LINEAR_KEY_RE.test(ticketId)) return undefined;
  const ws = linearWorkspace();
  return ws ? `https://linear.app/${ws}/issue/${ticketId}` : undefined;
}

/** Clear the cached workspace lookup. Tests only. */
export function _resetLinearWorkspaceCache(): void {
  workspaceCache = undefined;
}
