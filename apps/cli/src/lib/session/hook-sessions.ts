/**
 * Read-only view of the SessionStart hook's live-session state files.
 *
 * The `@agents/session-tracker` hook (installed into each agent's own config)
 * writes `~/.agents/.cache/terminals/sessions/<pid>.json` AFTER an agent boots,
 * carrying the agent's OWN authoritative session id (from its SessionStart
 * payload) plus the join keys `launch_id` / `terminal_id`. It is the only writer
 * that sees agents `ag run` did NOT launch (you typing `claude` in a terminal),
 * and the only source of an exact id for non-Claude agents (whose id we can't
 * know at spawn).
 *
 * This module lets `sessions --active` reconcile a `ps`-discovered pid to that
 * authoritative id. It is deliberately a small hand-rolled reader — the CLI does
 * NOT import the session-tracker package (a separate, workspace-less package;
 * see packages/session-tracker/CLAUDE.md) — mirroring the Factory extension's own
 * hand-copied reader in apps/factory/src/core/liveSession.ts. It only READS the
 * existing dir/schema; it never writes or moves anything, so it is safe across a
 * fleet where old hooks and a new CLI coexist.
 */
import fs from 'fs';
import path from 'path';
import { getTerminalsDir } from '../state.js';

/** The subset of the hook's on-disk record this reader relies on. Extra fields are ignored. */
export interface HookSessionRecord {
  session_id: string;
  agent?: string;
  cwd?: string;
  pid: number;
  launch_id?: string;
  terminal_id?: string;
  ts?: number;
}

function hookSessionsDir(): string {
  // Sibling of the pid-registry's by-pid/ dir. The hook hardcodes this same path
  // (packages/session-tracker/src/hook.sh); we read it, never move it.
  return path.join(getTerminalsDir(), 'sessions');
}

function parseRecord(raw: string): HookSessionRecord | undefined {
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && typeof o.session_id === 'string' && o.session_id) {
      return o as HookSessionRecord;
    }
  } catch {
    /* unparseable — treat as absent */
  }
  return undefined;
}

/** Read the hook record written under a specific pid. Undefined if absent/corrupt. */
export function readHookSessionByPid(pid: number): HookSessionRecord | undefined {
  if (!pid || pid < 1) return undefined;
  try {
    return parseRecord(fs.readFileSync(path.join(hookSessionsDir(), `${pid}.json`), 'utf8'));
  } catch {
    return undefined;
  }
}

function scanAll(): HookSessionRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(hookSessionsDir()).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: HookSessionRecord[] = [];
  for (const f of files) {
    try {
      const r = parseRecord(fs.readFileSync(path.join(hookSessionsDir(), f), 'utf8'));
      if (r) out.push(r);
    } catch {
      /* raced with the hook / pruner — skip */
    }
  }
  return out;
}

function newestMatching(pred: (r: HookSessionRecord) => boolean): HookSessionRecord | undefined {
  let best: HookSessionRecord | undefined;
  for (const r of scanAll()) {
    if (!pred(r)) continue;
    if (!best || (r.ts ?? 0) > (best.ts ?? 0)) best = r;
  }
  return best;
}

/**
 * The join key. Matches the hook record whose `launch_id` equals the launchId
 * `ag run` minted for this launch — reconciles across pid divergence (the hook
 * runs under the agent pid, our pid-registry entry may sit on a tmux pane leaf
 * or a cmd.exe wrapper). Newest-by-`ts` on the rare pid-reuse collision.
 */
export function findHookSessionByLaunchId(launchId: string): HookSessionRecord | undefined {
  if (!launchId) return undefined;
  return newestMatching(r => r.launch_id === launchId);
}

/** Secondary join key: a Factory VS Code tab's `AGENT_TERMINAL_ID`. */
export function findHookSessionByTerminalId(terminalId: string): HookSessionRecord | undefined {
  if (!terminalId) return undefined;
  return newestMatching(r => r.terminal_id === terminalId);
}
