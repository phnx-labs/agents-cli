/**
 * Runtime detection + picker + credential-script builder for `agents run --lease`.
 *
 * The picker asks which coding-agent runtime(s) to provision on a leased box.
 * The default selection is whatever the user is currently signed into locally
 * (via `getAccountInfo`, the same source `agents view` uses). The chosen runtimes
 * drive both what gets installed on the box and which auth token file is copied
 * over — the token contents ride the uploaded `--script-stdin` body, never argv.
 *
 * SECURITY: copying a runtime's auth token to an ephemeral cloud box is a
 * credential transfer. It is strictly opt-in (a confirm prompt in the command
 * layer), the token never appears in argv/`ps`, and `--lease` one-shot runs tear
 * the box down afterward so the credential's lifetime is bounded by the run.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { AgentId } from '../types.js';
import { getAccountInfo } from '../agents.js';
import { getKeychainToken } from '../secrets/index.js';
import { getClaudeKeychainService } from '../usage.js';
import { listInstalledVersions, getVersionHomePath } from '../versions.js';
import { readClaudeCredentialsBlob } from '../cloud/rush.js';

/**
 * Credential file locations per runtime. `localCandidates` are read in order
 * (first existing wins); `remote` is where the box's CLI reads it by default
 * (home-level — no per-version shim). Source of truth for these paths is
 * `getAccountInfo` in src/lib/agents.ts; keep them in sync.
 */
interface RuntimeCred {
  id: AgentId;
  label: string;
  localCandidates: string[];
  remote: string;
}

export const LEASE_RUNTIMES: RuntimeCred[] = [
  { id: 'claude', label: 'Claude Code', localCandidates: ['.claude/.claude.json', '.claude.json'], remote: '.claude.json' },
  { id: 'codex', label: 'Codex CLI', localCandidates: ['.codex/auth.json'], remote: '.codex/auth.json' },
  { id: 'gemini', label: 'Gemini CLI', localCandidates: ['.gemini/google_accounts.json'], remote: '.gemini/google_accounts.json' },
  { id: 'grok', label: 'Grok CLI', localCandidates: ['.grok/auth.json'], remote: '.grok/auth.json' },
];

export interface DetectedRuntime {
  id: AgentId;
  label: string;
  email: string | null;
  signedIn: boolean;
  /** Absolute local path of the credential file, if found. */
  credPath: string | null;
}

/** First existing candidate path under the real home, or null. */
function findLocalCred(cred: RuntimeCred): string | null {
  const home = process.env.AGENTS_REAL_HOME || os.homedir();
  for (const rel of cred.localCandidates) {
    const p = path.join(home, rel);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* unreadable — skip */
    }
  }
  return null;
}

/** Which lease-capable runtimes the user is signed into on this machine. */
export async function detectSignedInRuntimes(): Promise<DetectedRuntime[]> {
  const out: DetectedRuntime[] = [];
  for (const cred of LEASE_RUNTIMES) {
    let info;
    try {
      info = await getAccountInfo(cred.id);
    } catch {
      info = null;
    }
    out.push({
      id: cred.id,
      label: cred.label,
      email: info?.email ?? null,
      signedIn: !!info?.signedIn,
      credPath: findLocalCred(cred),
    });
  }
  return out;
}

/**
 * Interactive checkbox: which runtimes to provision on the box. Defaults to the
 * signed-in ones. Runtimes with no local credential are shown disabled.
 * `prompt` is injected so tests don't require a TTY.
 */
export async function pickRuntimes(
  detected: DetectedRuntime[],
  prompt?: (choices: { name: string; value: AgentId; checked: boolean; disabled: boolean | string }[]) => Promise<AgentId[]>,
): Promise<AgentId[]> {
  const choices = detected.map((d) => ({
    name: `${d.label}${d.email ? ` (${d.email})` : d.signedIn ? ' (signed in)' : ''}`,
    value: d.id,
    checked: d.signedIn && !!d.credPath,
    disabled: d.credPath ? false : 'no local credential — sign in first',
  }));
  if (prompt) return prompt(choices);
  const { checkbox } = await import('@inquirer/prompts');
  return checkbox({ message: 'Provision which runtime(s) on the leased box?', choices });
}

/**
 * The lease runtime to provision for a headless run of `agentName`.
 *
 * When the agent is itself a lease-capable runtime (claude/codex/gemini/grok)
 * that IS the runtime to install. Otherwise fall back to the single signed-in
 * lease runtime (preferring claude), or null when none is signed in. This is the
 * non-interactive replacement for the runtime checkbox picker: `--lease` requires
 * a prompt, so it is headless by contract and must never block on a TTY.
 *
 * Profile-dispatch agents (kimi/deepseek) and custom workflow agents that run
 * under a non-obvious runtime are resolved separately — see RUSH-1725.
 */
export function inferLeaseRuntime(agentName: string, detected: DetectedRuntime[]): AgentId | null {
  const signedIn = detected.filter((d) => d.signedIn && d.credPath);
  // The agent names a lease runtime directly: require that runtime to be signed
  // in — never silently substitute a different one for an explicit `run <runtime>`
  // (that would lease a billable box only to boot it "Not logged in"). Not signed
  // in → null, so the caller exits with "sign into it locally first".
  if (LEASE_RUNTIMES.some((c) => c.id === agentName)) {
    return signedIn.find((d) => d.id === agentName)?.id ?? null;
  }
  // Custom/workflow agent: fall back to the signed-in runtime (preferring claude).
  return signedIn.find((d) => d.id === 'claude')?.id ?? signedIn[0]?.id ?? null;
}

// A long random sentinel makes an accidental (or malicious) collision with a
// token's contents effectively impossible, so the quoted heredoc can never be
// closed early by the credential body.
const CRED_EOF = 'AGENTS_LEASE_CRED_EOF_9f3c1a7b5e2d4068';

/**
 * Where Claude Code reads its OAuth token on the box. `.claude.json` (the file
 * LEASE_RUNTIMES copies) is config/account-metadata ONLY — the actual token
 * lives here, so without it the box boots "Not logged in".
 */
export const CLAUDE_TOKEN_REMOTE = '.claude/.credentials.json';

/** True when `s` parses to a Claude keychain payload with an OAuth access token. */
function isClaudeCredentialsBlob(s: string): boolean {
  try {
    const p = JSON.parse(s) as { claudeAiOauth?: { accessToken?: unknown } };
    return typeof p?.claudeAiOauth?.accessToken === 'string';
  } catch {
    return false;
  }
}

/**
 * The RAW wrapped Claude credential payload (`{"claudeAiOauth":{…}}`) to write to
 * the box's `~/.claude/.credentials.json`, or null if no signed-in token is found.
 *
 * On macOS the token is in the login Keychain, read SILENTLY via
 * `getKeychainToken` (the `/usr/bin/security … -w` path — Claude's item trusts it,
 * no Touch ID). A default native install uses the bare `Claude Code-credentials`
 * service; an agents-cli managed install (where `~/.claude` symlinks into a
 * versioned home) uses a hash-suffixed service, so we try the bare service first,
 * then enumerate installed version homes (preferring the account whose email
 * matches `preferEmail`, so the token matches the `.claude.json` config we copy).
 * Off macOS the local Claude CLI stores the token in `.credentials.json` already —
 * reuse the rush.ts Linux branch verbatim.
 *
 * The reader/service/version helpers are injected so unit tests never touch the
 * real Keychain.
 */
export async function resolveClaudeCredentialsBlob(opts?: {
  preferEmail?: string | null;
  readItem?: (service: string) => string;
  service?: (home?: string) => string;
  listVersions?: () => string[];
  versionHome?: (version: string) => string;
  accountEmail?: (home: string) => Promise<string | null>;
}): Promise<string | null> {
  const readItem = opts?.readItem ?? getKeychainToken;
  const service = opts?.service ?? getClaudeKeychainService;
  const listVersions = opts?.listVersions ?? (() => listInstalledVersions('claude'));
  const versionHome = opts?.versionHome ?? ((v: string) => getVersionHomePath('claude', v));
  const accountEmail = opts?.accountEmail ?? (async (home: string) => (await getAccountInfo('claude', home)).email);

  const tryRead = (svc: string): string | null => {
    try {
      const raw = readItem(svc).trim();
      return isClaudeCredentialsBlob(raw) ? raw : null;
    } catch {
      return null;
    }
  };

  if (process.platform === 'darwin') {
    // 1) Bare service — the default native (non-managed) install.
    const bare = tryRead(service(undefined));
    if (bare) return bare;

    // 2) Managed installs — hash-suffixed service keyed to each version home.
    //    Prefer the version whose account email matches the copied config.
    let homes: string[];
    try {
      homes = listVersions().map(versionHome);
    } catch {
      homes = [];
    }
    if (opts?.preferEmail) {
      const scored = await Promise.all(
        homes.map(async (home) => ({ home, match: (await accountEmail(home).catch(() => null)) === opts.preferEmail })),
      );
      homes = [...scored.filter((s) => s.match), ...scored.filter((s) => !s.match)].map((s) => s.home);
    }
    for (const home of homes) {
      const hit = tryRead(service(home));
      if (hit) return hit;
    }
    return null;
  }

  // Off darwin: the local Claude CLI already stores the wrapped blob on disk.
  const home = process.env.AGENTS_REAL_HOME || os.homedir();
  return readClaudeCredentialsBlob(home);
}

/**
 * Build a bash snippet that writes each picked runtime's token file to the box's
 * home-level config path (0600), from the token contents read locally. Returns
 * `''` when no runtimes were selected. The snippet is meant to be embedded in
 * the `--script-stdin` body (never argv).
 *
 * `extras.claudeCredentialsJson` (the raw wrapped payload from
 * `resolveClaudeCredentialsBlob`) is written to `~/.claude/.credentials.json` in
 * ADDITION to claude's `.claude.json` config — without it the box is "Not logged in".
 */
export function buildCredentialScript(
  picked: AgentId[],
  detected: DetectedRuntime[],
  extras?: { claudeCredentialsJson?: string | null },
): string {
  const byId = new Map(detected.map((d) => [d.id, d]));
  const parts: string[] = [];
  const writeFile = (remote: string, contents: string): string => {
    const dir = path.posix.dirname(remote);
    const mkdir = dir && dir !== '.' ? `mkdir -p "$HOME/${dir}"\n` : '';
    return (
      `${mkdir}cat > "$HOME/${remote}" <<'${CRED_EOF}'\n${contents}${contents.endsWith('\n') ? '' : '\n'}${CRED_EOF}\n` +
      `chmod 600 "$HOME/${remote}"`
    );
  };
  for (const id of picked) {
    const d = byId.get(id);
    const cred = LEASE_RUNTIMES.find((c) => c.id === id);
    if (!d?.credPath || !cred) continue;
    let contents: string;
    try {
      contents = fs.readFileSync(d.credPath, 'utf-8');
    } catch {
      continue;
    }
    parts.push(writeFile(cred.remote, contents));
    // For claude the file above is config/state only; the OAuth token is a
    // second artifact — without it the box comes up "Not logged in".
    if (id === 'claude' && extras?.claudeCredentialsJson) {
      parts.push(writeFile(CLAUDE_TOKEN_REMOTE, extras.claudeCredentialsJson));
    }
  }
  return parts.join('\n');
}
