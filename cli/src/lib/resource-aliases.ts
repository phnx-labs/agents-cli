/**
 * Normalize a resource's frontmatter `aliases:` value into a clean list.
 *
 * A skill (SKILL.md) or command file may declare `aliases:` — alternate names
 * that {@link resolveResource} matches in addition to the canonical file/dir name
 * (the canonical name always wins a collision). The value is a YAML list or a
 * comma/space-separated string, mirroring the command frontmatter `agents:` field.
 *
 * This lives in its own leaf module so `skills.ts` and `commands.ts` (which parse
 * the frontmatter) and `resources.ts` (which resolves by alias) all share one
 * definition without an import cycle.
 */
export function normalizeAliases(raw: unknown): string[] {
  const tokens = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,\s]+/)
      : [];
  const out: string[] = [];
  for (const token of tokens) {
    const name = String(token).trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
