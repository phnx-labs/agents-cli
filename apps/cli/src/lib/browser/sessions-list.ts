/**
 * Read-only listing of a browser profile's on-disk captures — screenshots, PDFs,
 * recordings (`<profile>/sessions/<task>/`) and downloads (`<profile>/downloads/`).
 * Reads straight from `.cache/browser/<profile>/`, so it works whether or not the
 * browser daemon is running. Backs both `agents browser sessions` and the
 * `agents sessions --browser` alias.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getBrowserRuntimeDir, getProfileRuntimeDir } from './profiles.js';
import { formatRelativeTime } from '../session/relative-time.js';

export type ArtifactKind = 'screenshot' | 'pdf' | 'recording' | 'download';

export interface BrowserArtifact {
  kind: ArtifactKind;
  /** Owning task for session captures; undefined for downloads. */
  task?: string;
  name: string;
  path: string;
  bytes: number;
  mtimeMs: number;
}

export interface ProfileArtifacts {
  profile: string;
  artifacts: BrowserArtifact[];
}

const EXT_KIND: Record<string, ArtifactKind> = {
  '.png': 'screenshot',
  '.jpg': 'screenshot',
  '.jpeg': 'screenshot',
  '.webp': 'screenshot',
  '.pdf': 'pdf',
  '.webm': 'recording',
};

function statSafe(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

function walkFiles(dir: string): string[] {
  let out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/** Every capture for one profile, newest first. */
export function listProfileArtifacts(profile: string): BrowserArtifact[] {
  const root = getProfileRuntimeDir(profile);
  const artifacts: BrowserArtifact[] = [];

  const sessionsRoot = path.join(root, 'sessions');
  let taskDirs: fs.Dirent[] = [];
  try { taskDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { /* none */ }
  for (const t of taskDirs) {
    if (!t.isDirectory()) continue;
    for (const file of walkFiles(path.join(sessionsRoot, t.name))) {
      const kind = EXT_KIND[path.extname(file).toLowerCase()];
      if (!kind) continue;
      const st = statSafe(file);
      if (!st) continue;
      artifacts.push({ kind, task: t.name, name: path.basename(file), path: file, bytes: st.size, mtimeMs: st.mtimeMs });
    }
  }

  for (const file of walkFiles(path.join(root, 'downloads'))) {
    const st = statSafe(file);
    if (!st) continue;
    artifacts.push({ kind: 'download', name: path.basename(file), path: file, bytes: st.size, mtimeMs: st.mtimeMs });
  }

  artifacts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return artifacts;
}

/**
 * Captures grouped by profile. With `only` set, returns just that profile (even
 * when empty); otherwise every profile dir on disk that has at least one capture.
 */
export function listBrowserSessions(only?: string): ProfileArtifacts[] {
  let profiles: string[];
  if (only) {
    profiles = [only];
  } else {
    try {
      profiles = fs.readdirSync(getBrowserRuntimeDir(), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'sessions')
        .map((e) => e.name)
        .sort();
    } catch {
      profiles = [];
    }
  }
  return profiles
    .map((p) => ({ profile: p, artifacts: listProfileArtifacts(p) }))
    .filter((r) => !!only || r.artifacts.length > 0);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

/** Human table for the CLI. Returns lines (no trailing newline). */
export function renderBrowserSessions(groups: ProfileArtifacts[]): string {
  if (groups.length === 0) return 'No browser profiles found.';
  const lines: string[] = [];
  for (const g of groups) {
    const counts = { screenshot: 0, pdf: 0, recording: 0, download: 0 } as Record<ArtifactKind, number>;
    for (const a of g.artifacts) counts[a.kind]++;
    lines.push(
      `${g.profile}  ` +
      `screenshots ${counts.screenshot}  pdfs ${counts.pdf}  recordings ${counts.recording}  downloads ${counts.download}`
    );
    if (g.artifacts.length === 0) {
      lines.push('  (no captures yet)');
      continue;
    }
    for (const a of g.artifacts) {
      const when = formatRelativeTime(new Date(a.mtimeMs).toISOString());
      const where = a.kind === 'download' ? 'downloads/' : `sessions/${a.task}/`;
      lines.push(`  ${when.padEnd(12)}  ${a.name.padEnd(28)}  ${formatBytes(a.bytes).padStart(8)}  ${where}`);
    }
  }
  return lines.join('\n');
}

/**
 * Resolve `--open <sel>`: `latest` (newest across the groups) or a filename
 * substring match. Returns the absolute path, or null if nothing matched.
 */
export function resolveArtifact(groups: ProfileArtifacts[], selector: string): string | null {
  const all = groups.flatMap((g) => g.artifacts).sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (all.length === 0) return null;
  if (selector === 'latest') return all[0].path;
  const hit = all.find((a) => a.name === selector) ?? all.find((a) => a.name.includes(selector));
  return hit ? hit.path : null;
}

/** Open a file in the OS default app. Returns true on success. */
export function openArtifact(filePath: string): boolean {
  const openers: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['open', [filePath]]]
      : process.platform === 'win32'
        ? [['cmd', ['/c', 'start', '""', filePath]]]
        : [['xdg-open', [filePath]], ['gnome-open', [filePath]]];
  for (const [cmd, args] of openers) {
    if (spawnSync(cmd, args, { stdio: 'ignore' }).status === 0) return true;
  }
  return false;
}

/**
 * Shared CLI action for `agents browser sessions` and `agents sessions --browser`.
 * `open` is the Commander value for `--open [selector]`: undefined when the flag
 * is absent, `true` when passed bare (defaults to 'latest'), or the selector string.
 */
export function runBrowserSessions(opts: { profile?: string; open?: string | boolean; json?: boolean }): void {
  const groups = listBrowserSessions(opts.profile);

  if (opts.open !== undefined && opts.open !== false) {
    const selector = opts.open === true ? 'latest' : opts.open;
    const target = resolveArtifact(groups, selector);
    if (!target) {
      console.error(`No capture matching "${selector}".`);
      process.exit(1);
    }
    console.log(target);
    if (!openArtifact(target)) {
      console.error(`Could not open ${target}`);
      process.exit(1);
    }
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(groups, null, 2));
    return;
  }

  console.log(renderBrowserSessions(groups));
}
