import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface ProjectCandidate {
  path: string;
  repo?: string;
  freq: number;
  lastUsed: number;
}

function dashEncode(p: string): string {
  return p.replace(/[\/\.]/g, '-');
}

// Derive an "owner/repo" slug from a path shaped like .../<owner>/<repo>.
export function repoSlugFromPath(p: string): string | undefined {
  const parts = p.split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  if (!owner || !repo) return undefined;
  return `${owner}/${repo}`;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// Enumerate ~/src/github.com/<owner>/<repo> convention dirs.
async function conventionRepoDirs(): Promise<string[]> {
  const base = join(homedir(), 'src', 'github.com');
  const out: string[] = [];
  for (const owner of await safeReaddir(base)) {
    const ownerDir = join(base, owner);
    if (!(await isDir(ownerDir))) continue;
    for (const repo of await safeReaddir(ownerDir)) {
      const repoDir = join(ownerDir, repo);
      if (await isDir(repoDir)) out.push(repoDir);
    }
  }
  return out;
}

async function claudeCandidates(realRepoDirs: string[]): Promise<ProjectCandidate[]> {
  const projectsDir = join(homedir(), '.claude', 'projects');
  const subdirs = await safeReaddir(projectsDir);
  if (subdirs.length === 0) return [];

  // Build a reverse map from dash-encoded real path -> real path (lossy match).
  const encodedToReal = new Map<string, string>();
  for (const real of realRepoDirs) {
    encodedToReal.set(dashEncode(real), real);
  }

  const out: ProjectCandidate[] = [];
  for (const name of subdirs) {
    const subdir = join(projectsDir, name);
    if (!(await isDir(subdir))) continue;

    const files = (await safeReaddir(subdir)).filter((f) => f.endsWith('.jsonl'));
    if (files.length === 0) continue;

    let lastUsed = 0;
    for (const f of files) {
      try {
        const m = await stat(join(subdir, f));
        if (m.mtimeMs > lastUsed) lastUsed = m.mtimeMs;
      } catch {
        // skip unreadable file
      }
    }

    const real = encodedToReal.get(name);
    if (!real) continue; // could not recover a real path; skip rather than guess
    out.push({
      path: real,
      repo: repoSlugFromPath(real),
      freq: files.length,
      lastUsed,
    });
  }
  return out;
}

async function codexCandidates(): Promise<ProjectCandidate[]> {
  const sessionsRoot = join(homedir(), '.codex', 'sessions');
  const files: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 5 || files.length >= 500) return;
    for (const name of await safeReaddir(dir)) {
      if (files.length >= 500) return;
      const full = join(dir, name);
      if (name.endsWith('.jsonl')) {
        files.push(full);
      } else if (await isDir(full)) {
        await walk(full, depth + 1);
      }
    }
  }
  await walk(sessionsRoot, 0);
  if (files.length === 0) return [];

  const byPath = new Map<string, { freq: number; lastUsed: number }>();
  for (const file of files) {
    const cwd = await extractCodexCwd(file);
    if (!cwd) continue;
    let lastUsed = 0;
    try {
      lastUsed = (await stat(file)).mtimeMs;
    } catch {
      // ignore
    }
    const prev = byPath.get(cwd);
    if (prev) {
      prev.freq += 1;
      if (lastUsed > prev.lastUsed) prev.lastUsed = lastUsed;
    } else {
      byPath.set(cwd, { freq: 1, lastUsed });
    }
  }

  const out: ProjectCandidate[] = [];
  for (const [path, v] of byPath) {
    out.push({ path, repo: repoSlugFromPath(path), freq: v.freq, lastUsed: v.lastUsed });
  }
  return out;
}

// Read only the head of a codex session file to find session_meta.payload.cwd.
async function extractCodexCwd(file: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let stream: ReturnType<typeof createReadStream> | undefined;
    let rl: ReturnType<typeof createInterface> | undefined;
    let read = 0;
    let done = false;
    const finish = (val?: string) => {
      if (done) return;
      done = true;
      rl?.close();
      stream?.destroy();
      resolve(val);
    };
    try {
      stream = createReadStream(file, { encoding: 'utf8' });
      stream.on('error', () => finish(undefined));
      rl = createInterface({ input: stream });
      rl.on('line', (line) => {
        read += 1;
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          if (read > 20) finish(undefined);
          return;
        }
        const cwd = parsed?.payload?.cwd;
        if (parsed?.type === 'session_meta' && typeof cwd === 'string') {
          finish(cwd);
          return;
        }
        if (typeof cwd === 'string') {
          finish(cwd);
          return;
        }
        if (read > 20) finish(undefined);
      });
      rl.on('close', () => finish(undefined));
    } catch {
      finish(undefined);
    }
  });
}

async function conventionCandidates(realRepoDirs: string[]): Promise<ProjectCandidate[]> {
  const out: ProjectCandidate[] = [];
  for (const dir of realRepoDirs) {
    if (await isDir(join(dir, '.git'))) {
      out.push({ path: dir, repo: repoSlugFromPath(dir), freq: 1, lastUsed: 0 });
    }
  }
  return out;
}

export async function inferProjectCandidates(): Promise<ProjectCandidate[]> {
  const realRepoDirs = await conventionRepoDirs();

  const [claude, codex, convention] = await Promise.all([
    claudeCandidates(realRepoDirs),
    codexCandidates(),
    conventionCandidates(realRepoDirs),
  ]);

  const merged = new Map<string, ProjectCandidate>();
  for (const c of [...claude, ...codex, ...convention]) {
    const prev = merged.get(c.path);
    if (prev) {
      prev.freq += c.freq;
      if (c.lastUsed > prev.lastUsed) prev.lastUsed = c.lastUsed;
      if (!prev.repo && c.repo) prev.repo = c.repo;
    } else {
      merged.set(c.path, { ...c });
    }
  }

  return [...merged.values()].sort(
    (a, b) => b.freq - a.freq || b.lastUsed - a.lastUsed
  );
}
