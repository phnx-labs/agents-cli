// The curated project store.
//
// Both the floor sidebar and the dispatch dropdown read this ONE list instead of
// deriving "projects" from whichever agents happen to be running. Detection only
// SEEDS it (first run); after that the user curates. Persisted as readable JSON at
// ~/.agents/factory/projects.json (own file, not folded into config.json — so it
// can be hand-edited/synced without the config sanitizer dropping unknown keys).

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { inferProjectCandidates, repoSlugFromPath, type ProjectCandidate } from './projectIndex';

/**
 * A curated project. The webview mirrors this shape field-for-field in
 * ui/settings/components/mission-control/floorModel.ts — keep them in sync.
 */
export interface ManagedProject {
  id: string;                                 // stable local id
  name: string;                               // label in sidebar + dispatch
  path: string;                               // absolute local folder
  repoSlug?: string;                          // "owner/repo"
  linearProjectId?: string;
  linearProjectName?: string;                 // for the Linear pill
  confidence: 'high' | 'medium' | 'low';
  source: 'detected' | 'manual';
}

/** How many detected candidates to seed on first run. */
const SEED_LIMIT = 12;

export function managedProjectsFilePath(): string {
  return path.join(homedir(), '.agents', 'factory', 'projects.json');
}

/** Basename of a path, with any trailing slash ignored. */
export function projectNameFromPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Bucket a detection frequency into a confidence band. */
export function bucketConfidence(freq: number): ManagedProject['confidence'] {
  if (freq >= 10) return 'high';
  if (freq >= 3) return 'medium';
  return 'low';
}

/** Map a detected candidate to a seeded managed project (pure — unit-tested). */
export function candidateToManaged(c: ProjectCandidate): ManagedProject {
  const repoSlug = c.repo ?? repoSlugFromPath(c.path);
  const name = projectNameFromPath(c.path);
  return {
    id: repoSlug ?? c.path,
    name,
    path: c.path,
    repoSlug,
    confidence: bucketConfidence(c.freq),
    source: 'detected',
  };
}

/** Coerce arbitrary JSON into a valid ManagedProject[] (drops malformed rows). */
export function sanitizeManagedProjects(raw: unknown): ManagedProject[] {
  if (!Array.isArray(raw)) return [];
  const out: ManagedProject[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.path !== 'string') continue;
    const confidence = o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low' ? o.confidence : 'low';
    const source = o.source === 'manual' ? 'manual' : 'detected';
    out.push({
      id: o.id,
      name: o.name,
      path: o.path,
      repoSlug: typeof o.repoSlug === 'string' ? o.repoSlug : undefined,
      linearProjectId: typeof o.linearProjectId === 'string' ? o.linearProjectId : undefined,
      linearProjectName: typeof o.linearProjectName === 'string' ? o.linearProjectName : undefined,
      confidence,
      source,
    });
  }
  return out;
}

async function writeManagedProjects(list: ManagedProject[]): Promise<void> {
  const p = managedProjectsFilePath();
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, JSON.stringify(list, null, 2));
}

/** Build the seed list from detection (top SEED_LIMIT candidates). */
export async function seedManagedProjects(): Promise<ManagedProject[]> {
  const candidates = await inferProjectCandidates();
  return candidates.slice(0, SEED_LIMIT).map(candidateToManaged);
}

/**
 * Read the curated list. On first run (no file yet) seed it from detection and
 * persist, so the sidebar/dispatch have real projects immediately — then the user
 * curates.
 */
export async function readManagedProjects(): Promise<ManagedProject[]> {
  try {
    const raw = await fs.promises.readFile(managedProjectsFilePath(), 'utf-8');
    return sanitizeManagedProjects(JSON.parse(raw));
  } catch {
    const seeded = await seedManagedProjects();
    try {
      await writeManagedProjects(seeded);
    } catch {
      // Non-fatal: return the seed even if persistence fails.
    }
    return seeded;
  }
}

/** Add a new project or replace an existing one (matched by id). Returns the new list. */
export async function upsertManagedProject(project: ManagedProject): Promise<ManagedProject[]> {
  const list = await readManagedProjects();
  const idx = list.findIndex((p) => p.id === project.id);
  if (idx >= 0) list[idx] = project;
  else list.push(project);
  await writeManagedProjects(list);
  return list;
}

/** Remove a project by id. Returns the new list. */
export async function deleteManagedProject(id: string): Promise<ManagedProject[]> {
  const list = (await readManagedProjects()).filter((p) => p.id !== id);
  await writeManagedProjects(list);
  return list;
}
