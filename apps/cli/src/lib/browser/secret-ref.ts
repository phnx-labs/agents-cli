/**
 * Parse a `<bundle>/<KEY>` reference (optionally `secret:<bundle>/<KEY>`) used by
 * `agents browser type --secret` to feed a credential from an `agents secrets`
 * bundle into a page WITHOUT the value ever crossing stdout or the transcript.
 * Returns null on a malformed ref.
 */
export function parseSecretRef(ref: string): { bundle: string; key: string } | null {
  const body = ref.startsWith('secret:') ? ref.slice('secret:'.length) : ref;
  const slash = body.indexOf('/');
  // Need a non-empty bundle before the slash and a non-empty key after it.
  if (slash <= 0 || slash >= body.length - 1) return null;
  return { bundle: body.slice(0, slash), key: body.slice(slash + 1) };
}
