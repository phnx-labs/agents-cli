/**
 * Domain-skill discovery for `agents browser start`.
 *
 * When a browser task opens a URL, look up a site-specific SKILL.md from
 * `~/.agents/skills/browser/domain-skills/<dir>/SKILL.md` and surface its
 * contents so the calling agent gets per-site operating instructions
 * (selectors, gotchas, sign-in quirks) before it starts driving the page.
 *
 * Matching is intentionally simple: derive the hostname's second-level
 * label (e.g. `perplexity` from `perplexity.ai`, `slack` from `app.slack.com`)
 * and look for a directory of the same name. If the user wants a different
 * mapping (e.g. `mail.google.com` -> `gmail/`), they can pin it via a
 * `domains: [...]` array in the SKILL.md frontmatter; that override beats
 * the directory-name match.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Result of resolving a URL to a domain-skill. */
export interface ResolvedDomainSkill {
  /** Skill identifier — the directory name under domain-skills/. */
  name: string;
  /** Absolute path to the SKILL.md that was matched. */
  path: string;
  /** Full SKILL.md contents (frontmatter included). */
  content: string;
  /** Hostname the match was made against (post-www strip). */
  hostname: string;
}

/** Where domain-skills live. Override via $AGENTS_BROWSER_DOMAIN_SKILLS_DIR for tests. */
export function domainSkillsRoot(): string {
  const override = process.env.AGENTS_BROWSER_DOMAIN_SKILLS_DIR;
  if (override) return override;
  return path.join(os.homedir(), '.agents', 'skills', 'browser', 'domain-skills');
}

/**
 * Derive match candidates from a hostname. Order matters — earlier candidates
 * are tried first.
 *
 * Examples:
 *   perplexity.ai      -> ['perplexity.ai', 'perplexity']
 *   app.slack.com      -> ['app.slack.com', 'slack.com', 'slack']
 *   mail.google.com    -> ['mail.google.com', 'google.com', 'google', 'mail']
 *   higgsfield.ai      -> ['higgsfield.ai', 'higgsfield']
 */
export function hostnameMatchCandidates(hostname: string): string[] {
  const cleaned = hostname.toLowerCase().replace(/^www\./, '');
  if (!cleaned) return [];
  const parts = cleaned.split('.').filter(Boolean);
  const out = new Set<string>();
  out.add(cleaned);
  // Progressive label-stripping from the left: app.slack.com -> slack.com.
  for (let i = 1; i < parts.length; i++) {
    out.add(parts.slice(i).join('.'));
  }
  // Second-level label without TLD: app.slack.com -> slack, perplexity.ai -> perplexity.
  if (parts.length >= 2) {
    out.add(parts[parts.length - 2]);
  }
  // First label too, so mail.google.com can resolve a `mail` dir if that's how
  // the user organized their skills. Last so explicit second-level wins.
  if (parts.length >= 2) {
    out.add(parts[0]);
  }
  return Array.from(out);
}

/** Parse a SKILL.md's frontmatter `domains:` list, if any. Best-effort, no schema. */
function parseDomainsFrontmatter(content: string): string[] {
  // Frontmatter must be at file start: ---\n...\n---\n
  if (!content.startsWith('---')) return [];
  const end = content.indexOf('\n---', 3);
  if (end < 0) return [];
  const fm = content.slice(3, end);
  // Inline array form: domains: [a, b, c]
  const inline = fm.match(/^domains:\s*\[([^\]]*)\]/m);
  if (inline) {
    return inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, '').toLowerCase())
      .filter(Boolean);
  }
  // Block list form:
  //   domains:
  //     - a
  //     - b
  const block = fm.match(/^domains:\s*\n((?:\s+-\s+\S+\n?)+)/m);
  if (block) {
    return block[1]
      .split('\n')
      .map((line) => line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '').toLowerCase())
      .filter(Boolean);
  }
  return [];
}

/**
 * Resolve a URL to its matching domain-skill, or null if none.
 *
 * Two-pass strategy:
 *   1. Index every SKILL.md in the root and read its `domains:` frontmatter.
 *      If any pinned domain matches a candidate, return that skill.
 *   2. Fall back to directory-name match against the candidate list.
 *
 * Errors (missing root, unreadable file, invalid URL) are swallowed and
 * yield null — domain-skill discovery must never break browser start.
 */
export function resolveDomainSkill(url: string): ResolvedDomainSkill | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!hostname) return null;

  const root = domainSkillsRoot();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = hostnameMatchCandidates(hostname);
  if (candidates.length === 0) return null;
  const candidateSet = new Set(candidates);

  type Indexed = { name: string; skillPath: string; content: string; pinned: string[] };
  const indexed: Indexed[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillPath = path.join(root, e.name, 'SKILL.md');
    let content: string;
    try {
      content = fs.readFileSync(skillPath, 'utf-8');
    } catch {
      continue;
    }
    indexed.push({
      name: e.name,
      skillPath,
      content,
      pinned: parseDomainsFrontmatter(content),
    });
  }

  // Pass 1: explicit `domains:` overrides.
  for (const s of indexed) {
    for (const d of s.pinned) {
      if (candidateSet.has(d)) {
        return { name: s.name, path: s.skillPath, content: s.content, hostname };
      }
    }
  }

  // Pass 2: directory-name match, walking candidates in priority order.
  const byName = new Map(indexed.map((s) => [s.name.toLowerCase(), s]));
  for (const c of candidates) {
    const hit = byName.get(c);
    if (hit) {
      return { name: hit.name, path: hit.skillPath, content: hit.content, hostname };
    }
  }

  return null;
}
