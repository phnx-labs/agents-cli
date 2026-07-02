/**
 * Remote secrets — read and use `agents secrets` bundles that live on another
 * host, over the same hardened SSH path that `agents secrets export --host`
 * (the write inverse) already uses.
 *
 * This is the READ / USE direction:
 *   - browse:  drive the remote `agents secrets list|view` and stream its
 *              stdout back verbatim (lossless, no parsing).
 *   - use:     resolve a remote bundle to an env map (JSON over ssh stdout) and
 *              inject it ephemerally — never written to this machine's keychain.
 *
 * Trust model: relies on the operator's existing SSH access to the host (same
 * boundary as `export --host` / `run --host`). Bundle names are shell-quoted
 * into the remote command; resolved VALUES return over ssh stdout; a forwarded
 * file-backend passphrase travels over ssh stdin (first line) so it never lands
 * in argv / `ps` / remote shell history. Nothing is persisted locally.
 */

import { sshExec, assertValidSshTarget, type SshExecResult } from '../ssh-exec.js';
import { resolveHost } from '../hosts/registry.js';
import { sshTargetFor } from '../hosts/types.js';
import { buildRemoteAgentsInvocation } from '../hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../hosts/remote-os.js';

const REMOTE_TIMEOUT_MS = 30_000;

/** Remote OS for a target string (bare alias matches a device entry; a raw
 * `user@host` falls back to POSIX). Threaded into the command builder so a
 * Windows host gets PowerShell instead of `bash -lc`. */
function osForTarget(target: string): string | undefined {
  return resolveRemoteOsSync(target.split('@').pop() ?? target);
}

/**
 * Resolve a `--host` value to an ssh target string. Tries the `agents hosts`
 * registry first (enrolled name → ssh-config alias / `user@host`); on a miss,
 * treats the value as a raw ssh target and validates it against injection.
 */
export async function resolveSshTarget(nameOrAlias: string): Promise<string> {
  const host = await resolveHost(nameOrAlias);
  if (host) return sshTargetFor(host);
  assertValidSshTarget(nameOrAlias);
  return nameOrAlias;
}

/**
 * Merge `--host <single>` and `--hosts <a,b,c>` into an ordered, de-duplicated
 * list. Both flags compose; either alone works. Empty when neither is set.
 */
export function parseHostsOption(opts: { host?: string; hosts?: string }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (h: string) => {
    const t = h.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  if (opts.host) push(opts.host);
  if (opts.hosts) for (const h of opts.hosts.split(',')) push(h);
  return out;
}

/**
 * Split a `bundle@host` reference. No `@` → a local bundle (host undefined).
 * Bundle names can't contain `@` (BUNDLE_NAME_PATTERN), so the FIRST `@`
 * separates the bundle from the ssh target — and the target itself may be a
 * `user@host` (e.g. `r2.backups@muqsit@box` → bundle `r2.backups`, host
 * `muqsit@box`).
 */
export function splitBundleRef(ref: string): { bundle: string; host?: string } {
  const at = ref.indexOf('@');
  if (at === -1) return { bundle: ref };
  const bundle = ref.slice(0, at);
  const host = ref.slice(at + 1);
  if (!bundle || !host) {
    throw new Error(`Invalid remote bundle reference ${JSON.stringify(ref)}. Expected 'bundle@host'.`);
  }
  return { bundle, host };
}

/**
 * Run `agents secrets <args>` on a remote host over ssh and return the raw
 * result. Used by the browse commands — the remote's human-readable stdout is
 * streamed back unchanged. `tty` forces an interactive ssh session (`-tt`) so a
 * remote Touch-ID / passphrase prompt can surface (e.g. `view --reveal`).
 */
export function remoteSecretsRaw(
  target: string,
  args: string[],
  opts: { tty?: boolean; input?: string } = {},
): SshExecResult {
  const remoteCmd = buildRemoteAgentsInvocation(['secrets', ...args], undefined, osForTarget(target));
  return sshExec(target, remoteCmd, {
    timeoutMs: REMOTE_TIMEOUT_MS,
    input: opts.input,
    extraSshArgs: opts.tty ? ['-tt'] : undefined,
  });
}

/**
 * Resolve a remote bundle to a plaintext env map by driving the remote's
 * `agents secrets export <bundle> --plaintext --format json`. Values cross over
 * ssh stdout (encrypted in transit), parsed in memory, never persisted.
 *
 * The remote unlocks the bundle with ITS OWN credentials — the owner host's
 * keychain/secrets-agent, or its own `AGENTS_SECRETS_PASSPHRASE` (in the login
 * env) for a file-backed bundle. We deliberately do NOT forward this machine's
 * passphrase: the remote bundle is encrypted with the remote's passphrase, so
 * overriding it would break the read. (A macOS remote under non-interactive
 * SSH will block on Touch-ID — use `view`/`exec` with a remote `file` bundle,
 * an already-unlocked remote secrets-agent, or an interactive `-tt` session.)
 */
export async function remoteResolveEnv(target: string, bundle: string): Promise<Record<string, string>> {
  assertValidSshTarget(target);
  const remoteCmd = buildRemoteAgentsInvocation(
    ['secrets', 'export', bundle, '--plaintext', '--format', 'json'],
    undefined,
    osForTarget(target),
  );
  const res: SshExecResult = sshExec(target, remoteCmd, {
    timeoutMs: REMOTE_TIMEOUT_MS,
  });

  if (res.code !== 0) {
    const msg = (res.stderr || res.stdout || '').trim();
    const why = res.timedOut ? 'timed out' : res.code === null ? 'ssh failed' : `exit ${res.code}`;
    throw new Error(`Failed to resolve '${bundle}' on ${target} (${why})${msg ? `: ${msg}` : ''}`);
  }

  // Tolerate login-shell banner noise on stdout: take the outer { … } object.
  const raw = res.stdout;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const jsonText = start >= 0 && end >= start ? raw.slice(start, end + 1) : raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(
      `Could not parse secrets JSON from '${bundle}' on ${target}. ` +
        `Is the remote agents-cli new enough for 'secrets export --format json'?`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Unexpected payload resolving '${bundle}' on ${target}.`);
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    env[k] = typeof v === 'string' ? v : String(v);
  }
  return env;
}
