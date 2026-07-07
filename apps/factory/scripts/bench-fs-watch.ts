/**
 * Benchmark: does the proposed session tracker's fs.watch design scale to
 * 3 windows * 15 agent tabs without slowing the machine?
 *
 * What this mimics from the proposed production design:
 *  - One fs.watch (non-recursive) per (workspace, agent-type, version-shim).
 *  - On 'rename' event: 300ms debounce, then readline first 100 lines of
 *    the new file, JSON.parse each, look for forkedFrom.sessionId.
 *  - On 'change' event: no disk read, just bump an in-memory lastWriteMs map.
 *
 * Knobs:
 *   SIM_WINDOWS  number of VS Code windows to simulate (default 3)
 *   WORKSPACE    absolute path to a workspace whose session dirs exist
 *                (default: this repo)
 *   DURATION_S   how long to run (default 120)
 *   STRESS       if set, also hammer the watched dir with fake file creations
 *
 * Output: prints stats every 5s — event rate, CPU time delta, RSS delta,
 * readline latency percentiles, open-fd count.
 *
 * Throwaway: delete after we commit to (or reject) the design.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { execSync } from 'child_process';

const SIM_WINDOWS = Number(process.env.SIM_WINDOWS ?? 3);
const WORKSPACE = process.env.WORKSPACE ?? '/Users/muqsit/src/github.com/muqsitnawaz/swarmify';
const DURATION_S = Number(process.env.DURATION_S ?? 120);
const STRESS = process.env.STRESS === '1';
const READ_ON_RENAME = process.env.READ_ON_RENAME !== '0'; // default on
const DEBOUNCE_MS = 300;
const LINE_CAP = 100;

const HOME = os.homedir();

function workspaceToClaudeFolder(p: string): string {
  return p.replace(/[/.]/g, '-');
}

function claudeRootsFor(workspace: string): string[] {
  const folder = workspaceToClaudeFolder(workspace);
  const roots: string[] = [];

  const canonical = path.join(HOME, '.claude', 'projects', folder);
  if (fs.existsSync(canonical)) roots.push(canonical);

  const versionsDir = path.join(HOME, '.agents', 'versions', 'claude');
  if (fs.existsSync(versionsDir)) {
    for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const shim = path.join(versionsDir, entry.name, 'home', '.claude', 'projects', folder);
      if (fs.existsSync(shim)) roots.push(shim);
    }
  }
  return roots;
}

function codexRootToday(): string {
  const now = new Date();
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return path.join(HOME, '.codex', 'sessions', y, m, d);
}

// --- State ---
interface Stats {
  renameEvents: number;
  changeEvents: number;
  readlineRuns: number;
  readlineTotalMs: number;
  readlineMaxMs: number;
  readlineLatencies: number[]; // last 1000 for p50/p95/p99
  forkedFromHits: number;
  lastWriteMs: Map<string, number>;
  debounceTimers: Map<string, NodeJS.Timeout>;
}

const stats: Stats = {
  renameEvents: 0,
  changeEvents: 0,
  readlineRuns: 0,
  readlineTotalMs: 0,
  readlineMaxMs: 0,
  readlineLatencies: [],
  forkedFromHits: 0,
  lastWriteMs: new Map(),
  debounceTimers: new Map(),
};

// --- Simulated production logic ---
async function readFirstLines(filePath: string): Promise<void> {
  const start = performance.now();
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineCount = 0;
  try {
    for await (const line of rl) {
      if (++lineCount > LINE_CAP) break;
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed?.forkedFrom?.sessionId) {
          stats.forkedFromHits++;
          break;
        }
      } catch { /* skip */ }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  const elapsed = performance.now() - start;
  stats.readlineRuns++;
  stats.readlineTotalMs += elapsed;
  if (elapsed > stats.readlineMaxMs) stats.readlineMaxMs = elapsed;
  stats.readlineLatencies.push(elapsed);
  if (stats.readlineLatencies.length > 1000) stats.readlineLatencies.shift();
}

function handleRename(dir: string, filename: string | null): void {
  if (!filename || !filename.endsWith('.jsonl')) return;
  stats.renameEvents++;
  if (!READ_ON_RENAME) return;
  const full = path.join(dir, filename);
  const key = full;
  const existing = stats.debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  stats.debounceTimers.set(key, setTimeout(() => {
    stats.debounceTimers.delete(key);
    if (!fs.existsSync(full)) return;
    void readFirstLines(full).catch(() => {});
  }, DEBOUNCE_MS));
}

function handleChange(dir: string, filename: string | null): void {
  if (!filename) return;
  stats.changeEvents++;
  stats.lastWriteMs.set(path.join(dir, filename), Date.now());
}

// --- Mount watchers ---
const watchers: fs.FSWatcher[] = [];

function watchDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    console.warn(`[skip] missing: ${dir}`);
    return;
  }
  const w = fs.watch(dir, { recursive: false }, (event, filename) => {
    if (event === 'rename') handleRename(dir, filename);
    else if (event === 'change') handleChange(dir, filename);
  });
  watchers.push(w);
}

function mountWatchersFor(windowIdx: number): { claude: number; codex: number } {
  const claudeRoots = claudeRootsFor(WORKSPACE);
  const codexRoot = codexRootToday();
  for (const r of claudeRoots) watchDir(r);
  if (fs.existsSync(codexRoot)) watchDir(codexRoot);
  else console.warn(`[skip] missing codex dir: ${codexRoot}`);
  return { claude: claudeRoots.length, codex: fs.existsSync(codexRoot) ? 1 : 0 };
}

// --- Stress generator (optional) ---
let stressInterval: NodeJS.Timeout | null = null;
function startStress(dir: string): void {
  if (!fs.existsSync(dir)) return;
  stressInterval = setInterval(() => {
    const fake = path.join(dir, `bench-${process.pid}-${Date.now()}.jsonl`);
    fs.writeFile(fake, '{"type":"permission-mode","sessionId":"bench"}\n', () => {
      setTimeout(() => fs.unlink(fake, () => {}), 1000);
    });
  }, 200); // 5 new files/sec — far above real human rate
}

// --- Metrics ---
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function openFdCount(pid: number): number {
  try {
    const out = execSync(`lsof -p ${pid} 2>/dev/null | wc -l`, { encoding: 'utf-8' });
    return Number(out.trim()) - 1;
  } catch {
    return -1;
  }
}

function report(startCpu: NodeJS.CpuUsage, startMem: number, elapsedS: number): void {
  const cpu = process.cpuUsage(startCpu);
  const userS = cpu.user / 1e6;
  const sysS = cpu.system / 1e6;
  const totalCpuS = userS + sysS;
  const cpuPct = (totalCpuS / elapsedS) * 100;
  const mem = process.memoryUsage();
  const rssDeltaMb = (mem.rss - startMem) / 1024 / 1024;
  const rssMb = mem.rss / 1024 / 1024;
  const fds = openFdCount(process.pid);
  const p50 = percentile(stats.readlineLatencies, 0.5);
  const p95 = percentile(stats.readlineLatencies, 0.95);
  const p99 = percentile(stats.readlineLatencies, 0.99);

  console.log(
    `[t+${elapsedS.toFixed(0)}s] ` +
    `events: rename=${stats.renameEvents} change=${stats.changeEvents} | ` +
    `reads: ${stats.readlineRuns} (forkHits=${stats.forkedFromHits}) ` +
    `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms max=${stats.readlineMaxMs.toFixed(1)}ms | ` +
    `cpu: user=${userS.toFixed(2)}s sys=${sysS.toFixed(2)}s (${cpuPct.toFixed(2)}% of wall) | ` +
    `mem: rss=${rssMb.toFixed(1)}MB (+${rssDeltaMb.toFixed(1)}MB) | ` +
    `fds=${fds}`
  );
}

// --- Main ---
async function main(): Promise<void> {
  console.log(`[bench] simulating ${SIM_WINDOWS} VS Code window(s) for workspace=${WORKSPACE}`);
  let totalClaude = 0, totalCodex = 0;
  for (let i = 0; i < SIM_WINDOWS; i++) {
    const counts = mountWatchersFor(i);
    totalClaude += counts.claude;
    totalCodex += counts.codex;
  }
  console.log(`[bench] mounted ${watchers.length} fs.watch handles (${totalClaude} claude dirs + ${totalCodex} codex dirs across ${SIM_WINDOWS} windows)`);
  console.log(`[bench] knobs: DURATION_S=${DURATION_S} STRESS=${STRESS} READ_ON_RENAME=${READ_ON_RENAME} DEBOUNCE_MS=${DEBOUNCE_MS}`);

  if (STRESS) {
    const first = claudeRootsFor(WORKSPACE)[0];
    if (first) {
      console.log(`[bench] STRESS mode — creating fake jsonl files in ${first} at 5/sec`);
      startStress(first);
    }
  }

  const startCpu = process.cpuUsage();
  const startMem = process.memoryUsage().rss;
  const startWall = Date.now();
  console.log(`[bench] baseline: pid=${process.pid} rss=${(startMem / 1024 / 1024).toFixed(1)}MB fds=${openFdCount(process.pid)}`);
  console.log('');

  const interval = setInterval(() => {
    const elapsed = (Date.now() - startWall) / 1000;
    report(startCpu, startMem, elapsed);
    if (elapsed >= DURATION_S) {
      clearInterval(interval);
      if (stressInterval) clearInterval(stressInterval);
      for (const w of watchers) w.close();
      console.log('\n[bench] done. summary:');
      report(startCpu, startMem, elapsed);
      process.exit(0);
    }
  }, 5000);

  process.on('SIGINT', () => {
    if (stressInterval) clearInterval(stressInterval);
    for (const w of watchers) w.close();
    const elapsed = (Date.now() - startWall) / 1000;
    console.log('\n[bench] SIGINT. summary:');
    report(startCpu, startMem, elapsed);
    process.exit(0);
  });
}

void main();
