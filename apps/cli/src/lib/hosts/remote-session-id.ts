/**
 * Resolve a remote-created session id back to an interactive `--host` launcher.
 *
 * A headless `--host` run captures the remote-coined id from the followed log
 * (the `--emit-session-id` marker — see session-marker.ts). An INTERACTIVE run
 * has no followed log: the local TTY is wired straight through `sshStream`
 * (stdio:'inherit'), so nothing can tap the stream for a marker without breaking
 * the agent's raw-mode TUI. Instead we correlate by AGENT_LAUNCH_ID.
 *
 * The launcher forwards a launch id it controls (`--env AGENT_LAUNCH_ID=<id>`);
 * the remote `agents run` adopts it (exec.ts `resolveLaunchId`), so the remote
 * SessionStart hook records the agent's REAL session id under that exact key in
 * `~/.agents/.cache/terminals/sessions/<pid>.json`. After the stream returns we
 * do ONE ssh read of that dir and pick the record whose `launch_id` matches —
 * the same launch-id join `agents sessions --active` uses locally
 * (session/hook-sessions.ts), just across the SSH hop.
 *
 * This gives the interactive path a real per-agent id to register in the local
 * session index and to reconnect against, for Codex/Kimi/Grok/Gemini — closing
 * the gap RUSH-2033 left for every non-Claude agent (Claude still forces its own
 * id up front and never reaches here).
 */

import { sshExec } from '../ssh-exec.js';

/** The subset of the remote hook record this resolver reads. Extra fields ignored. */
interface RemoteHookRecord {
  session_id?: unknown;
  launch_id?: unknown;
  ts?: unknown;
}

/**
 * Pick the real session id for `launchId` from the remote hook records.
 *
 * `recordsJson` is the newline-delimited JSON the remote read emits — one record
 * per line (a `cat` of every `sessions/*.json`). Scan for the record whose
 * `launch_id` matches and return its `session_id`; when several match (pid reuse,
 * a lingering file) the NEWEST by `ts` wins, mirroring the local reader's
 * keep-newest tie-break (session/hook-sessions.ts). Pure so the correlation is
 * unit-testable from fixtures with no SSH. Returns undefined when no record
 * carries the launch id (the hook hasn't landed yet, or a hookless harness).
 */
export function pickRemoteSessionId(recordsJson: string, launchId: string): string | undefined {
  if (!launchId) return undefined;
  let best: { sid: string; ts: number } | undefined;
  for (const line of recordsJson.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: RemoteHookRecord;
    try {
      rec = JSON.parse(trimmed) as RemoteHookRecord;
    } catch {
      continue; // a partial/garbled line — skip, never throw
    }
    if (rec.launch_id !== launchId) continue;
    if (typeof rec.session_id !== 'string' || !rec.session_id) continue;
    const ts = typeof rec.ts === 'number' ? rec.ts : 0;
    // Strict `>` so the FIRST record wins a tie — matches keepNewest (hook-sessions.ts).
    if (!best || ts > best.ts) best = { sid: rec.session_id, ts };
  }
  return best?.sid;
}

/**
 * Read the remote hook-session dir over ssh and resolve the real session id the
 * remote run recorded under `launchId`. One round-trip, best-effort: any ssh
 * failure, a missing dir, or an absent record yields undefined — the caller then
 * keeps the un-mapped run rather than a fabricated id.
 *
 * `$HOME` expands on the REMOTE login shell (never the local box). The glob is a
 * literal path with no user input, so it is injection-safe; a `2>/dev/null` on a
 * globless dir keeps the command quiet when the dir is empty or absent.
 */
export function resolveRemoteSessionId(target: string, launchId: string, timeoutMs = 6000): string | undefined {
  if (!launchId) return undefined;
  // `cat` every record onto its own line. `head -c` caps a runaway file; the
  // trailing `true` keeps the pipeline's exit 0 even when the glob matches nothing.
  const cmd = 'cat "$HOME"/.agents/.cache/terminals/sessions/*.json 2>/dev/null | head -c 1048576 || true';
  const res = sshExec(target, cmd, { timeoutMs, multiplex: true });
  if (res.code !== 0 && !res.stdout) return undefined;
  // Each record is a single-line JSON object; `cat` may run them together, so
  // normalise `}{` boundaries onto separate lines before scanning.
  const normalised = res.stdout.replace(/\}\s*\{/g, '}\n{');
  return pickRemoteSessionId(normalised, launchId);
}
