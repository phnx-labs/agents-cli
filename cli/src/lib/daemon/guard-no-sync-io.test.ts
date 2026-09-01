import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Structural guard (PHNX-3695): no synchronous system call may sit on a daemon
 * SERVICE tick/start path.
 *
 * The daemon drives every background service on ONE Node event loop
 * (`ServiceSupervisor`, supervisor.ts). A synchronous `execFileSync` /
 * `readFileSync` / … inside a `DaemonService`'s `onStart`/`onTick` body freezes
 * that loop for the whole duration of the call — and while it is frozen the
 * supervisor's per-tick deadline timer CANNOT fire and the browser IPC server
 * CANNOT answer, which is the "accept but never reply" wedge (browser/ipc.ts,
 * PHNX-3411). Async equivalents (`fs/promises`, `execFileBounded`) keep the loop
 * live.
 *
 * This scans the `DaemonService` implementation files — the tick/start SURFACE,
 * the entry points the supervisor calls directly — and fails with `file:line`
 * if any banned synchronous call survives in their code (comments and string
 * literals are stripped so a doc mention like "async existsSync" is not a hit).
 * It deliberately does NOT try to follow the call graph transitively: that is
 * not a fast static scan. Startup/lifecycle code in daemon.ts (pid/lock,
 * install-time launchctl/systemctl) legitimately stays synchronous and is out
 * of scope by construction — it runs before the loop serves clients.
 */

// Synchronous fs / child_process calls that block the event loop.
const BANNED = /\b(execFileSync|execSync|spawnSync|readFileSync|writeFileSync|appendFileSync|statSync|lstatSync|existsSync|readdirSync|mkdirSync|rmSync|unlinkSync|renameSync|openSync|readSync|writeSync)\b/;

/** Blank out block comments, line comments and string/template literals, preserving line count so reported line numbers stay accurate. */
function stripNonCode(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    let line = '';
    let i = 0;
    let inStr: string | null = null;
    while (i < raw.length) {
      const two = raw.slice(i, i + 2);
      if (inBlock) {
        if (two === '*/') { inBlock = false; i += 2; } else { i += 1; }
        continue;
      }
      if (inStr) {
        if (raw[i] === '\\') { i += 2; continue; }
        if (raw[i] === inStr) inStr = null;
        i += 1;
        continue;
      }
      if (two === '/*') { inBlock = true; i += 2; continue; }
      if (two === '//') break; // rest of line is a comment
      if (raw[i] === '"' || raw[i] === "'" || raw[i] === '`') { inStr = raw[i]; i += 1; continue; }
      line += raw[i];
      i += 1;
    }
    out.push(line);
  }
  return out;
}

function serviceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('-service.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(dir, f));
}

describe('daemon service tick paths are free of synchronous IO', () => {
  const daemonDir = __dirname;

  it('finds at least the known service files (guard is actually scanning something)', () => {
    const files = serviceFiles(daemonDir).map((f) => path.basename(f));
    expect(files).toContain('heartbeat-service.ts');
    expect(files).toContain('self-heal-service.ts');
    expect(files).toContain('state-dir-check-service.ts');
    expect(files.length).toBeGreaterThan(10);
  });

  it('has no synchronous fs/exec call in any DaemonService onStart/onTick body', () => {
    const offenders: string[] = [];
    for (const file of serviceFiles(daemonDir)) {
      const codeLines = stripNonCode(fs.readFileSync(file, 'utf-8'));
      codeLines.forEach((line, idx) => {
        const m = line.match(BANNED);
        if (m) offenders.push(`${path.relative(process.cwd(), file)}:${idx + 1} — ${m[1]}`);
      });
    }
    expect(offenders, `synchronous IO on a daemon tick surface freezes the event loop (PHNX-3695):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the scanner actually flags a synthetic synchronous call (guard is not vacuous)', () => {
    const sample = [
      '// readFileSync in a comment must NOT count',
      'const x = "spawnSync in a string must NOT count";',
      'const y = fs.readFileSync(p); // this real call MUST count',
    ].join('\n');
    const hits = stripNonCode(sample)
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => BANNED.test(line));
    expect(hits.length).toBe(1);
    expect(hits[0].idx).toBe(2);
  });
});
