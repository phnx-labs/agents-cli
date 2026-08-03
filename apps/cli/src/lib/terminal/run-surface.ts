/**
 * `agents run … --terminal` — re-open this exact run as a tab in a real terminal.
 *
 * A GUI caller (the menu bar's "New Session") cannot host a TUI, so it has to
 * hand the run to a terminal. It used to do that by hardcoding AppleScript at
 * Terminal.app; now it appends `--terminal` and the CLI decides WHICH terminal
 * from the user's own live sessions (preferred.ts) and opens the tab through the
 * launch engine — the same engine `sessions resume` and `sessions focus` use.
 *
 * The re-invocation is the caller's own argv with the `--terminal` flag removed,
 * so every other flag (`--mode`, `--cwd`, a `--` passthrough) rides along
 * untouched and there is no second place that knows how to spell a run.
 */
import type { Backend, EngineContext } from './types.js';
import type { ActiveSession } from '../session/active.js';
import { BACKENDS } from './backends/index.js';
import { openSurface } from './engine.js';
import { getCliLaunch } from '../cli-entry.js';
import { shellQuote } from './quote.js';
import {
  resolveLaunchBackend,
  describeBackendChoice,
  type LaunchBackendChoice,
  type SessionHostSample,
} from './preferred.js';

/** Backends a user may name in `--terminal <backend>`. */
export const TERMINAL_FLAG_BACKENDS: Backend[] = Object.keys(BACKENDS) as Backend[];

/**
 * Validate a `--terminal <value>`. Returns the backend, or an error message
 * naming the valid ids — never a silent fallback to auto-detection, which would
 * open a terminal the user did not ask for.
 */
export function parseTerminalFlag(value: unknown): { backend?: Backend; error?: string } {
  if (value === undefined || value === true || value === '') return {};
  const raw = String(value);
  if ((TERMINAL_FLAG_BACKENDS as string[]).includes(raw)) return { backend: raw as Backend };
  return {
    error: `Unknown --terminal backend '${raw}'. Use one of: ${TERMINAL_FLAG_BACKENDS.join(', ')} (or pass --terminal alone to auto-detect).`,
  };
}

/**
 * The argv to re-invoke, with `--terminal` (and the value commander consumed for
 * it) removed. `consumedValue` is the parsed option value when it is a string —
 * that is the only token after the flag that belongs to it, so a prompt or a
 * following flag is never eaten.
 */
export function stripTerminalFlag(argv: string[], consumedValue?: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--terminal') {
      if (consumedValue !== undefined && argv[i + 1] === consumedValue) i++;
      continue;
    }
    if (tok.startsWith('--terminal=')) continue;
    out.push(tok);
  }
  return out;
}

/** `agents run …` as a shell-safe command line for the surface to exec. */
export function buildRunCommand(argv: string[]): string[] {
  const { command, args } = getCliLaunch(argv);
  return [command, ...args].map(shellQuote);
}

/**
 * Turn live sessions into the samples the resolver reads, filling in the app
 * each tmux-hosted session is currently VIEWED in.
 *
 * This step is what makes detection work for the common case: `agents run`
 * wraps interactive runs in tmux, so a session the user started in Ghostty is
 * attributed `host: 'tmux'` on the discovery path and would otherwise name no
 * terminal at all. `resolveViewingIn` walks the attached tmux client's pid up to
 * its host app — the same resolver `agents sessions` uses to print
 * "viewing in Ghostty tab 2". Sessions that are detached (no client attached)
 * legitimately have no viewer and keep their `tmux` host.
 *
 * Best-effort: any probe failure degrades to the plain host, never throws.
 */
export async function toHostSamples(sessions: ActiveSession[]): Promise<SessionHostSample[]> {
  const samples: SessionHostSample[] = sessions.map((s) => ({
    host: s.host,
    lastActivityMs: s.lastActivityMs,
    startedAtMs: s.startedAtMs,
  }));

  const tmuxIdx = sessions
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.provenance?.mux?.kind === 'tmux' && s.provenance.mux.pane);
  if (tmuxIdx.length === 0) return samples;

  try {
    const { enumerateGhosttyTabs } = await import('../session/ghostty-tabs.js');
    const { mapPanesToTargets, listClients } = await import('../tmux/session.js');
    const { resolveViewingIn } = await import('../session/viewing-in.js');
    // One Ghostty enumeration shared across sockets, as the sessions renderer does.
    const ghosttySurfaces = await enumerateGhosttyTabs();
    const sockets = new Set(tmuxIdx.map(({ s }) => s.provenance!.mux!.socket));
    for (const socket of sockets) {
      const paneToTarget = await mapPanesToTargets(socket);
      if (paneToTarget.size === 0) continue;
      const clients = await listClients(socket);
      for (const { s, i } of tmuxIdx) {
        if (s.provenance!.mux!.socket !== socket) continue;
        const viewing = await resolveViewingIn(s, clients, { paneToTarget, ghosttySurfaces });
        if (viewing) samples[i].viewingApp = viewing.app;
      }
    }
  } catch {
    // tmux/Ghostty probes are best-effort; fall back to the plain host values.
  }
  return samples;
}

export interface OpenRunSurfaceParams {
  /** This process's argv after the program name (i.e. `['run','claude',…]`). */
  argv: string[];
  /** The parsed `--terminal` value, when the user named a backend. */
  forced?: Backend;
  /** The value commander consumed for `--terminal`, so it can be stripped. */
  consumedValue?: string;
  cwd: string;
  /** Live sessions, used to detect the terminal the user actually works in. */
  sessions: SessionHostSample[];
  ctx: EngineContext;
}

export interface OpenRunSurfaceResult {
  ok: boolean;
  choice?: LaunchBackendChoice;
  /** Human line describing the terminal that was chosen. */
  description?: string;
  error?: string;
}

/**
 * Open the run as a tab in the resolved terminal. Never throws — a failure comes
 * back as `ok: false` with the reason, so the caller can tell the user rather
 * than exiting silently.
 */
export async function openRunInTerminal(params: OpenRunSurfaceParams): Promise<OpenRunSurfaceResult> {
  const choice: LaunchBackendChoice | null = params.forced
    ? { backend: params.forced, source: 'forced' }
    : resolveLaunchBackend(params.ctx, params.sessions);

  if (!choice) {
    return {
      ok: false,
      error: 'No terminal this machine can drive (need iTerm, Ghostty, Terminal.app, VSCodium, or a tmux session). Run without --terminal.',
    };
  }
  if (params.forced && !BACKENDS[choice.backend].isAvailable(params.ctx)) {
    return { ok: false, error: `--terminal ${choice.backend} is not available here.` };
  }

  const command = buildRunCommand(stripTerminalFlag(params.argv, params.consumedValue));
  const result = await openSurface({
    backend: choice.backend,
    layout: 'tab',
    cwd: params.cwd,
    command,
  });
  return { ok: result.ok, choice, description: describeBackendChoice(choice), error: result.error };
}
