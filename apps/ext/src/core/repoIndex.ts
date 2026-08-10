import type { ProjectCandidate } from './projectIndex';
import { repoSlugFromPath } from './projectIndex';

// Shape MUST equal projectDetect's Project.
export interface Project {
  name: string;
  relPath: string;
}

export interface RepoInfo {
  slug: string;
  freq: number;
  perHostPaths: Record<string, string>;
  projects: Project[];
}

const THIS_HOST = 'this-mac';

export async function rankRepos(
  candidates: ProjectCandidate[],
  detectProjects: (root: string) => Promise<Project[]>
): Promise<RepoInfo[]> {
  const bySlug = new Map<string, { freq: number; localPath: string; lastUsed: number }>();

  for (const c of candidates) {
    const slug = c.repo ?? repoSlugFromPath(c.path);
    if (!slug) continue;
    const prev = bySlug.get(slug);
    if (prev) {
      prev.freq += c.freq;
      // Prefer the most-recently-used local path as the canonical one.
      if (c.lastUsed >= prev.lastUsed) {
        prev.lastUsed = c.lastUsed;
        prev.localPath = c.path;
      }
    } else {
      bySlug.set(slug, { freq: c.freq, localPath: c.path, lastUsed: c.lastUsed });
    }
  }

  const infos: RepoInfo[] = [];
  for (const [slug, v] of bySlug) {
    let projects: Project[] = [];
    try {
      projects = await detectProjects(v.localPath);
    } catch {
      projects = [];
    }
    infos.push({
      slug,
      freq: v.freq,
      perHostPaths: { [THIS_HOST]: v.localPath },
      projects,
    });
  }

  return infos.sort((a, b) => b.freq - a.freq);
}
