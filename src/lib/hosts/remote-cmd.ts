/**
 * Pure argv helpers for `--host` passthrough — build the remote `agents …`
 * invocation and strip the local-only routing flags before forwarding.
 *
 * Kept free of any SSH/process side effects so the two-layer quoting and the
 * flag-stripping edge cases (glued short forms, `=value`, variadic) are unit
 * testable without a live host. The transport itself lives in `ssh-exec.ts`
 * (`sshExec`/`sshStream`); orchestration lives in `passthrough.ts`.
 */

import { shellQuote } from '../ssh-exec.js';

/** A flag to strip from a forwarded argv, with whether it consumes a value. */
export interface StripSpec {
  /** Long form without leading dashes, e.g. `host`, `remote-cwd`. */
  long: string;
  /** Optional single-letter short form without the dash, e.g. `H`. */
  short?: string;
  /** True when the flag takes a following value token (`--host <name>`). */
  takesValue: boolean;
}

/**
 * Remove routing flags (and their values) from a command's args, leaving the
 * rest untouched and in order so they forward verbatim to the remote binary.
 * Handles every form commander accepts: `--host h`, `--host=h`, `-H h`, `-H=h`,
 * and the glued short form `-Hh`.
 *
 * @param args the command's args (already past the command name).
 */
export function stripRoutingFlags(args: string[], specs: StripSpec[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const spec = specs.find((s) => {
      if (a === `--${s.long}` || a.startsWith(`--${s.long}=`)) return true;
      if (s.short && (a === `-${s.short}` || a.startsWith(`-${s.short}=`) || new RegExp(`^-${s.short}.+`).test(a)))
        return true;
      return false;
    });
    if (!spec) {
      out.push(a);
      continue;
    }
    // Consume a separate value token only for the exact-match (space-separated) forms.
    const isExact = a === `--${spec.long}` || (spec.short && a === `-${spec.short}`);
    if (spec.takesValue && isExact && i + 1 < args.length) i++;
  }
  return out;
}

/** The routing flags every `--host`-capable command shares. */
export const HOST_ROUTING_SPECS: StripSpec[] = [
  { long: 'host', short: 'H', takesValue: true },
  { long: 'remote-cwd', takesValue: true },
];

/**
 * Build the single command string for `ssh <target> <cmd>`. The forwarded args
 * are quoted for the inner login shell, then the whole `agents …` invocation is
 * quoted again so it survives `bash -lc <...>` — `bash -lc` so the remote login
 * PATH resolves `agents`. An optional `cd` runs first for `--remote-cwd`.
 */
export function buildRemoteAgentsInvocation(forwardedArgs: string[], remoteCwd?: string): string {
  const inner = ['agents', ...forwardedArgs].map(shellQuote).join(' ');
  const withCwd = remoteCwd ? `cd ${shellQuote(remoteCwd)} && ${inner}` : inner;
  return `bash -lc ${shellQuote(withCwd)}`;
}
