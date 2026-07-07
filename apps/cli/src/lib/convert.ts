/**
 * Format conversion between Markdown (Claude/Codex) and TOML (Gemini) command files.
 *
 * Handles frontmatter parsing and bidirectional translation so that slash commands
 * authored in one format can be synced to agents that expect the other.
 */

/** Parsed YAML frontmatter from a Markdown command file. */
export interface MarkdownFrontmatter {
  description?: string;
  [key: string]: unknown;
}

/** Extract YAML frontmatter and body from a Markdown string. Returns empty frontmatter if none found. */
export function parseMarkdownFrontmatter(content: string): {
  frontmatter: MarkdownFrontmatter;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterRaw = match[1];
  const body = match[2];

  const frontmatter: MarkdownFrontmatter = {};
  for (const line of frontmatterRaw.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

/** Convert a Markdown command file to Gemini's TOML format, translating $ARGUMENTS to {{args}}. */
export function markdownToToml(skillName: string, markdown: string): string {
  const { frontmatter, body } = parseMarkdownFrontmatter(markdown);
  const description = frontmatter.description || `Run ${skillName} command`;

  const promptContent = body
    .trim()
    .replace(/\$ARGUMENTS/g, '{{args}}');

  const lines = [
    `name = "${skillName}"`,
    `description = "${description.replace(/"/g, '\\"')}"`,
    "prompt = '''",
    promptContent,
    "'''",
    '',
  ];

  return lines.join('\n');
}

/** Convert a Gemini TOML command file back to Markdown format, translating {{args}} to $ARGUMENTS. */
export function tomlToMarkdown(toml: string): string {
  const nameMatch = toml.match(/name\s*=\s*"([^"]+)"/);
  const descMatch = toml.match(/description\s*=\s*"([^"]+)"/);
  const promptMatch = toml.match(/prompt\s*=\s*(?:'''|""")([\s\S]*?)(?:'''|""")/);

  const description = descMatch?.[1] || '';
  let prompt = promptMatch?.[1]?.trim() || '';

  prompt = prompt.replace(/\{\{args\}\}/g, '$ARGUMENTS');

  const lines = ['---', `description: ${description}`, '---', '', prompt, ''];

  return lines.join('\n');
}
