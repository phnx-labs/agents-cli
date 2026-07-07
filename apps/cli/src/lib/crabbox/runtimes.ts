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

// A long random sentinel makes an accidental (or malicious) collision with a
// token's contents effectively impossible, so the quoted heredoc can never be
// closed early by the credential body.
const CRED_EOF = 'AGENTS_LEASE_CRED_EOF_9f3c1a7b5e2d4068';

/**
 * Build a bash snippet that writes each picked runtime's token file to the box's
 * home-level config path (0600), from the token contents read locally. Returns
 * `''` when no runtimes were selected. The snippet is meant to be embedded in
 * the `--script-stdin` body (never argv).
 */
export function buildCredentialScript(picked: AgentId[], detected: DetectedRuntime[]): string {
  const byId = new Map(detected.map((d) => [d.id, d]));
  const parts: string[] = [];
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
    const dir = path.posix.dirname(cred.remote);
    const mkdir = dir && dir !== '.' ? `mkdir -p "$HOME/${dir}"\n` : '';
    parts.push(
      `${mkdir}cat > "$HOME/${cred.remote}" <<'${CRED_EOF}'\n${contents}${contents.endsWith('\n') ? '' : '\n'}${CRED_EOF}\n` +
        `chmod 600 "$HOME/${cred.remote}"`,
    );
  }
  return parts.join('\n');
}
