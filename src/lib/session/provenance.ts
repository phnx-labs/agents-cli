/**
 * Session provenance — where an active agent process actually lives.
 *
 * `detectHost()` in active.ts walks the ppid chain to name the *terminal app*
 * (iterm / code / tmux). That answers "what UI is above it" but not the three
 * things the Agent Feed needs to group and route:
 *
 *   1. Which machine    — os.hostname(), for the HOSTS sidebar.
 *   2. Local vs SSH     — is SSH_CONNECTION in the process env?
 *   3. Exact tmux pane  — TMUX_PANE ('%3'), the send-keys target.
 *
 * All three are inherited env vars, so we read them straight off the running
 * process (no cooperation from the agent needed): `/proc/<pid>/environ` on
 * Linux, `ps eww` on macOS. The read is best-effort — a process we can't stat
 * (gone, or owned by another uid) yields `undefined`, never a guess.
 *
 * `reply` is a read-only hint, not a send channel: it reports whether a rail
 * that can type back into this session exists today and, if so, the exact
 * address to type into. Two env-derived rails, in precedence order:
 *
 *   - tmux  — `$TMUX_PANE` (+ `$TMUX` socket): `tmux send-keys -t <pane>`. Works
 *             inside ANY host app (a tmux pane can live under iTerm/Ghostty/VS
 *             Code), so it wins whenever present.
 *   - iterm — `$ITERM_SESSION_ID` (`w<n>t<n>p<n>:<UUID>`): the exact iTerm2
 *             split, addressable by its session UUID via `tell session id …`
 *             (focus-safe, no `activate`). Used when there's no tmux above it.
 *
 * Both are inherited env vars, so the split the agent lives in is recovered with
 * zero cooperation from the agent. Inherited/ignored stdin with neither rail =>
 * null (not env-addressable — resolution may still find an IDE rail off disk,
 * see src/lib/terminal/resolve.ts). The feed uses `reply` to decide whether to
 * show a Send box; the resolver turns it into a concrete inject target (Gap 2,
 * src/lib/terminal/inject.ts).
 */
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';

const execFileAsync = promisify(execFile);

export interface SshOrigin {
  clientIp: string;
  clientPort: number;
  serverIp: string;
  serverPort: number;
}

export interface MuxLocation {
  kind: 'tmux' | 'screen';
  /** tmux server socket path (first comma-field of $TMUX). Undefined for screen. */
  socket?: string;
  /** Exact pane id from $TMUX_PANE, e.g. '%3' — the send-keys target. */
  pane?: string;
  /** screen session name from $STY, e.g. '12345.pts-0.host'. */
  session?: string;
}

/** How the feed can type back into a session, derived from env rails that exist today. */
export type ReplyRail =
  | { rail: 'tmux'; target: string; socket?: string }
  /** iTerm2 split addressed by its session UUID (the part of $ITERM_SESSION_ID after ':'). */
  | { rail: 'iterm'; session: string }
  | null;

export interface SessionProvenance {
  /** Machine the process runs on — os.hostname(). Drives HOSTS grouping. */
  host: string;
  /** 'ssh' when SSH_CONNECTION is present in the process env, else 'local'. */
  transport: 'local' | 'ssh';
  /** Populated when transport === 'ssh'. */
  ssh?: SshOrigin;
  /** TERM_PROGRAM: 'iTerm.app', 'vscode', 'WezTerm', 'tmux', 'Apple_Terminal', … */
  term?: string;
  /** Multiplexer the process sits inside, from $TMUX / $STY. */
  mux?: MuxLocation;
  /** Whether an existing rail can type back into this session (see module doc). */
  reply: ReplyRail;
}

/** Env vars that carry provenance. Kept small so the macOS `ps` scan stays cheap. */
export const PROVENANCE_ENV_KEYS = [
  'SSH_CONNECTION',
  'SSH_TTY',
  'TMUX',
  'TMUX_PANE',
  'TERM_PROGRAM',
  'STY',
  'ITERM_SESSION_ID',
] as const;

/**
 * Extract the iTerm2 session UUID from `$ITERM_SESSION_ID`, whose value is
 * `w<window>t<tab>p<pane>:<UUID>` — the `:`-suffix is exactly what iTerm2's
 * `id of session` returns, so it's the address for `tell session id …`. Returns
 * undefined for an empty/absent value; tolerates a bare value with no `:`.
 */
export function parseItermSession(value?: string): string | undefined {
  if (!value) return undefined;
  const uuid = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value;
  return uuid.trim() || undefined;
}

/** Parse the NUL-separated body of /proc/<pid>/environ into a plain object. */
export function parseProcEnviron(buf: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of buf.split('\0')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

/**
 * How many whitespace-separated tokens each key's value spans. macOS
 * `ps eww -o command=` space-joins the env after the command, so a value that
 * itself contains spaces (SSH_CONNECTION is four fields) can't be recovered by
 * boundary-guessing when the next token is an *unknown* var. Every provenance
 * key except SSH_CONNECTION is a single token, so we read exactly its arity.
 */
const ENV_VALUE_TOKENS: Record<string, number> = { SSH_CONNECTION: 4 };

/**
 * Pull known env vars out of a macOS `ps eww` command+env line. For each
 * `KEY=` match we consume the declared number of tokens (default 1), so
 * SSH_CONNECTION's internal spaces survive while a following unknown var
 * (e.g. `PWD=…`) is not swallowed into the previous value.
 */
export function extractKnownEnv(text: string, keys: readonly string[]): Record<string, string> {
  const alt = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const boundary = new RegExp(`(?:^|\\s)(${alt})=`, 'g');
  const env: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(text)) !== null) {
    const key = m[1];
    const rest = text.slice(m.index + m[0].length);
    const tokens = rest.split(/\s+/);
    const want = ENV_VALUE_TOKENS[key] ?? 1;
    env[key] = tokens.slice(0, want).join(' ');
  }
  return env;
}

/** `<client_ip> <client_port> <server_ip> <server_port>` → structured origin. */
export function parseSshConnection(value: string): SshOrigin | undefined {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 4) return undefined;
  const clientPort = parseInt(parts[1], 10);
  const serverPort = parseInt(parts[3], 10);
  if (!Number.isFinite(clientPort) || !Number.isFinite(serverPort)) return undefined;
  return { clientIp: parts[0], clientPort, serverIp: parts[2], serverPort };
}

/** Build a SessionProvenance from a raw env map + the local hostname. Pure. */
export function deriveProvenance(env: Record<string, string>, hostname: string): SessionProvenance {
  const ssh = env.SSH_CONNECTION ? parseSshConnection(env.SSH_CONNECTION) : undefined;

  let mux: MuxLocation | undefined;
  if (env.TMUX) {
    mux = {
      kind: 'tmux',
      socket: env.TMUX.split(',')[0] || undefined,
      pane: env.TMUX_PANE || undefined,
    };
  } else if (env.STY) {
    mux = { kind: 'screen', session: env.STY };
  }

  // Env-addressable rails, in precedence order. A tmux pane wins because it can
  // live inside any host app (`tmux send-keys -t <pane>` reaches it regardless of
  // whether iTerm/Ghostty/VS Code is above it). Absent tmux, an iTerm2 split is
  // addressable by its session UUID. Everything else (inherited stdin from
  // `agents run`, ignored stdin from teams, a plain VS Code integrated terminal)
  // is not env-addressable — the resolver may still find an IDE rail off disk.
  const itermSession = parseItermSession(env.ITERM_SESSION_ID);
  const reply: ReplyRail =
    mux?.kind === 'tmux' && mux.pane
      ? { rail: 'tmux', target: mux.pane, socket: mux.socket }
      : itermSession
        ? { rail: 'iterm', session: itermSession }
        : null;

  return {
    host: hostname,
    transport: ssh ? 'ssh' : 'local',
    ssh,
    term: env.TERM_PROGRAM || undefined,
    mux,
    reply,
  };
}

/** Read a process's environment. Linux: /proc. macOS: `ps eww`. Best-effort. */
async function readProcEnv(pid: number): Promise<Record<string, string> | undefined> {
  if (process.platform === 'linux') {
    try {
      const buf = await readFile(`/proc/${pid}/environ`, 'utf8');
      return parseProcEnviron(buf);
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('ps', ['eww', '-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      if (!stdout.trim()) return undefined;
      return extractKnownEnv(stdout, PROVENANCE_ENV_KEYS);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Resolve provenance for a live pid. Returns undefined when the process env
 * can't be read (process gone, foreign uid, unsupported platform) — we never
 * fabricate a 'local' answer we can't back with the env.
 */
export async function detectProvenance(pid: number): Promise<SessionProvenance | undefined> {
  if (!pid || pid < 1) return undefined;
  const env = await readProcEnv(pid);
  if (!env) return undefined;
  return deriveProvenance(env, os.hostname());
}
