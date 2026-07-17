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

import { sshExec, sshStream, assertValidSshTarget, type SshExecResult } from '../ssh-exec.js';
import { resolveHost } from '../hosts/registry.js';
import { emit } from '../events.js';
import { sshTargetFor } from '../hosts/types.js';
import { buildRemoteAgentsInvocation } from '../hosts/remote-cmd.js';
import { resolveRemoteOsSync } from '../hosts/remote-os.js';
import { isLoaderOrInterpreterEnv } from './bundles.js';

const REMOTE_TIMEOUT_MS = 30_000;

/**
 * Trust boundary for a remote-resolved env map. A peer's `secrets export` output
 * is untrusted input: a compromised or misconfigured host could return keys that
 * silently reshape THIS process's behavior once merged into the agent env
 * (bundles.ts:251 `sanitizeProcessEnv` only strips loader vars from process.env,
 * never the remote bundle). Block the dangerous-override classes here — at the
 * source — so every consumer (`run --secrets b@host`, `secrets exec --host`) is
 * protected, not just one call site:
 *   - LD_* / DYLD_* / NODE_OPTIONS and the other loader/interpreter injections
 *     (reuses the canonical bundles.ts predicate);
 *   - GIT_*        — GIT_SSH_COMMAND et al. hijack every git subprocess;
 *   - *_PROXY      — HTTP(S)_PROXY / ALL_PROXY reroute outbound traffic (MITM);
 *   - *_BASE_URL   — ANTHROPIC_BASE_URL / OPENAI_BASE_URL redirect the model API.
 * These keys are already rejected on the ADD side (validateEnvKey for loaders),
 * so a legitimate bundle never carries them — only a hostile peer would.
 */
export function isDangerousRemoteEnvKey(name: string): boolean {
  const upper = name.toUpperCase();
  if (isLoaderOrInterpreterEnv(upper)) return true;
  if (upper.startsWith('GIT_')) return true;
  if (upper.endsWith('_PROXY')) return true;
  if (upper.endsWith('_BASE_URL')) return true;
  return false;
}

/** Remote OS for a host name or target string. Prefer the original host name
 * because enrolled inline hosts resolve to `user@address`, while the OS
 * registry is keyed by the host name. */
function osForTarget(target: string, lookupName?: string): string | undefined {
  const byName = lookupName ? resolveRemoteOsSync(lookupName) : undefined;
  return byName ?? resolveRemoteOsSync(target.split('@').pop() ?? target);
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
  opts: { tty?: boolean; input?: string; osLookupName?: string } = {},
): SshExecResult {
  const remoteCmd = buildRemoteAgentsInvocation(['secrets', ...args], undefined, osForTarget(target, opts.osLookupName));
  return sshExec(target, remoteCmd, {
    timeoutMs: REMOTE_TIMEOUT_MS,
    input: opts.input,
    extraSshArgs: opts.tty ? ['-tt'] : undefined,
    multiplex: opts.tty ? false : undefined,
  });
}

/**
 * Run a remote `agents secrets <args>` FOREGROUND, with the local stdio wired
 * straight through (`stdio: 'inherit'` + `-tt`), and return its exit code.
 *
 * Unlike `remoteSecretsRaw` — which pipes stdin, so even with `-tt` the remote
 * process's `process.stdin.isTTY` is false and a passphrase prompt refuses to
 * appear (the macOS file-store guard then hard-errors "needs
 * AGENTS_SECRETS_PASSPHRASE") — this inherits the caller's real terminal, so the
 * remote sees a genuine TTY and its hidden passphrase prompt surfaces and reads
 * the keystrokes. This is the transport for `unlock --host`: you type the remote
 * bundle's passphrase at your own terminal. Output is NOT captured (it streams
 * to the terminal); only the exit code is returned.
 */
export function remoteSecretsStream(target: string, args: string[], opts: { osLookupName?: string } = {}): number {
  const remoteCmd = buildRemoteAgentsInvocation(['secrets', ...args], undefined, osForTarget(target, opts.osLookupName));
  return sshStream(target, remoteCmd, { tty: true });
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
export async function remoteResolveEnv(
  target: string,
  bundle: string,
  opts: { osLookupName?: string } = {},
): Promise<Record<string, string>> {
  assertValidSshTarget(target);
  const remoteCmd = buildRemoteAgentsInvocation(
    ['secrets', 'export', bundle, '--plaintext', '--format', 'json'],
    undefined,
    osForTarget(target, opts.osLookupName),
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
  const blocked: string[] = [];
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    // Drop dangerous-override keys returned by the (untrusted) peer before they
    // can reshape this process — see isDangerousRemoteEnvKey.
    if (isDangerousRemoteEnvKey(k)) {
      blocked.push(k);
      continue;
    }
    env[k] = typeof v === 'string' ? v : String(v);
  }
  if (blocked.length > 0) {
    process.stderr.write(
      `[secrets] Dropped ${blocked.length} dangerous key(s) from '${bundle}'@${target} ` +
        `(remote override blocked): ${blocked.join(', ')}\n`,
    );
  }
  // The remote host audits its own `secrets export` read; this emit records the
  // event on the INITIATING host too (values were pulled into this process and
  // injected locally). Covers `secrets exec --host` and `run --secrets b@host`.
  // Values never enter the payload — only the bundle, target host, and count.
  emit('secrets.get', {
    module: 'secrets',
    bundle,
    operation: 'remote resolve',
    source: 'remote',
    host: target,
    status: 'success',
    keyCount: Object.keys(env).length,
  });
  return env;
}
