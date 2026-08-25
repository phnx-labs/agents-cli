/**
 * Leaf argv helpers for host/device routing flags.
 *
 * Zero imports on purpose. `bootstrap.ts` gates the dynamic
 * `import('./lib/hosts/passthrough.js')` on {@link hasHostRoutingFlag} so the
 * ~187 ms passthrough module graph is never loaded when no routing flag is
 * present (the majority of CLI invocations). That gate must not itself drag
 * in passthrough, remote-cmd, ssh-exec, or the device registry (RUSH-2374).
 *
 * `flagValue` lives here (not in passthrough.ts) for the same reason: the gate
 * and the function body that later reads flag values share one implementation.
 */

/** Pull the value of `--device`/`-D`/`--remote-cwd` (any form) out of an argv. */
export function flagValue(args: string[], long: string, short?: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === `--${long}` || (short && a === `-${short}`)) return args[i + 1];
    if (a.startsWith(`--${long}=`)) return a.slice(long.length + 3);
    if (short && a.startsWith(`-${short}=`)) return a.slice(short.length + 2);
    if (short && new RegExp(`^-${short}(.+)`).test(a)) return a.slice(2);
  }
  return undefined;
}

/**
 * True when argv carries any device routing flag that {@link maybeRunOnHost}
 * inspects: `--device`/`-D`, `--hosts`, `--devices` (space, `=`, or
 * glued short form).
 *
 * Presence-only — does not validate values. Used by bootstrap before loading
 * passthrough, and by `maybeRunStandaloneOnHost` before strip/route work.
 */
export function hasHostRoutingFlag(args: string[]): boolean {
  return (
    flagValue(args, 'device', 'D') !== undefined ||
    flagValue(args, 'hosts') !== undefined ||
    flagValue(args, 'devices') !== undefined
  );
}
