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
 * linked. This keeps the OSS CLI free of any Rush/workspace-specific string.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A Linear tracker key: `TEAM-N`, e.g. `RUSH-1234`. Mirrors the detector's shape. */
const LINEAR_KEY_RE = /^[A-Z]{2,6}-\d{1,6}$/;

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
