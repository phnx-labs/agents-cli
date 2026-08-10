// Pure resolver for Foreman's message_agent tool: given the live agent
// terminals and a spoken "who" ("the codex agent", "auth", a session prefix),
// pick the single terminal to message - or report that the match was empty or
// ambiguous so the voice flow can ask which one. No VS Code dependencies so the
// tier logic is unit-testable under `bun test`.

// Minimal shape of a live terminal this resolver needs. EditorTerminal (from
// terminals.vscode.ts) is structurally compatible; we only read identity fields.
export interface ForemanTargetCandidate {
  id: string;
  label?: string;
  autoLabel?: string;
  agentType?: string;
  sessionId?: string;
  prefix?: string;
}

export type ForemanTargetResolution<T extends ForemanTargetCandidate> =
  | { kind: 'match'; terminal: T }
  | { kind: 'none'; candidates: string[] }
  | { kind: 'ambiguous'; candidates: string[] };

// Human-friendly name for a candidate, best field first.
export function candidateName(t: ForemanTargetCandidate): string {
  return t.label || t.autoLabel || t.agentType || t.prefix || t.id;
}

// Resolve "who" against the candidates. Specific matches (label/autoLabel
// substring, or id prefix) outrank a bare kind match, so "the auth agent" beats
// "any claude". A kind match ("codex") only resolves when exactly one of that
// kind is running; two of a kind returns ambiguous with the candidate names.
export function resolveForemanTarget<T extends ForemanTargetCandidate>(
  candidates: T[],
  who: string,
): ForemanTargetResolution<T> {
  const q = (who ?? '').trim().toLowerCase();
  if (!q) return { kind: 'none', candidates: candidates.map(candidateName) };

  const specific = candidates.filter((t) =>
    (t.label && t.label.toLowerCase().includes(q)) ||
    (t.autoLabel && t.autoLabel.toLowerCase().includes(q)) ||
    (t.sessionId && t.sessionId.toLowerCase().startsWith(q)) ||
    (t.id && t.id.toLowerCase().includes(q)));
  const byKind = candidates.filter((t) => (t.agentType ?? '').toLowerCase() === q);
  const matches = specific.length > 0 ? specific : byKind;

  if (matches.length === 0) return { kind: 'none', candidates: candidates.map(candidateName) };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches.map(candidateName) };
  return { kind: 'match', terminal: matches[0] };
}
