import matter from 'gray-matter';

export interface ParsedDoc {
  data: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

export function parseFrontmatter(raw: string): ParsedDoc {
  if (!raw.startsWith('---')) {
    return { data: {}, body: raw, hasFrontmatter: false };
  }
  try {
    const result = matter(raw);
    const hasFrontmatter = result.matter.length > 0;
    return {
      data: (result.data as Record<string, unknown>) ?? {},
      body: result.content,
      hasFrontmatter,
    };
  } catch {
    return { data: {}, body: raw, hasFrontmatter: false };
  }
}

export function reattachFrontmatter(
  data: Record<string, unknown>,
  body: string,
  hasFrontmatter: boolean,
): string {
  if (!hasFrontmatter || Object.keys(data).length === 0) return body;
  const stringified = matter.stringify(body, data);
  return stringified.endsWith('\n') ? stringified : stringified + '\n';
}
