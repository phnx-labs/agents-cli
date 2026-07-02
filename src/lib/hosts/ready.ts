/**
 * Host readiness + bootstrap.
 *
 * Before a dispatch we ensure the box is reachable and has agents-cli. Enrollment
 * can additionally install/upgrade agents-cli to match the local version (version
 * parity) using the same shape as scripts/sandbox.sh. We never copy `.history`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { sshExec, shellQuote } from '../ssh-exec.js';
import type { Host } from './types.js';
import { sshTargetFor } from './types.js';
import { remoteShellFor, buildWindowsAgentsCommand, encodePowershell, powershellQuote } from './remote-cmd.js';
import { resolveRemoteOsSync } from './remote-os.js';

/** Resolve this CLI's own version by walking up to the nearest package.json. */
export function localCliVersion(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, 'package.json');
    try {
      const data = JSON.parse(fs.readFileSync(pkg, 'utf-8')) as { name?: string; version?: string };
      if (data.name && data.version) return data.version;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Reachability + OS probe over ssh. POSIX boxes answer `uname -s`; a Windows
 * target has no `uname` and ssh lands in cmd.exe/PowerShell, so we run a tiny
 * PowerShell probe instead and report the already-known platform. `os` is the
 * caller's hint (device-registry platform / enrolled `HostEntry.os`); when it
 * marks the host Windows we take the PowerShell path, otherwise POSIX.
 */
export function probeHost(target: string, os?: string): { reachable: boolean; os?: string } {
  if (remoteShellFor(os) === 'powershell') {
    const probe = encodePowershell('[System.Environment]::OSVersion.Platform.ToString()');
    const r = sshExec(target, `powershell -NoProfile -EncodedCommand ${probe}`, { timeoutMs: 12000 });
    if (r.code !== 0) return { reachable: false };
    return { reachable: true, os };
  }
  const r = sshExec(target, 'uname -s 2>/dev/null || echo unknown', { timeoutMs: 12000 });
  if (r.code !== 0) return { reachable: false };
  const uname = r.stdout.trim();
  return { reachable: true, os: uname && uname !== 'unknown' ? uname : undefined };
}

/** Remote agents-cli version (PATH-resolved on the remote), or null if not installed. */
export function remoteAgentsVersion(target: string, os?: string): string | null {
  const cmd =
    remoteShellFor(os) === 'powershell'
      ? buildWindowsAgentsCommand({ args: ['--version'] })
      : 'bash -lc "agents --version 2>/dev/null"';
  const r = sshExec(target, cmd, { timeoutMs: 20000 });
  if (r.code !== 0) return null;
  const v = r.stdout.trim();
  return v || null;
}

/** Install (or upgrade to) a specific agents-cli version on the remote, then `agents setup`. */
export function bootstrapAgentsCli(target: string, version: string | null, os?: string): { ok: boolean; output: string } {
  const spec = version ? `@phnx-labs/agents-cli@${version}` : '@phnx-labs/agents-cli';
  let cmd: string;
  if (remoteShellFor(os) === 'powershell') {
    // PowerShell has no `tail`/`[ -d ]`/`||`; use its native equivalents.
    const script =
      `npm install -g ${powershellQuote(spec)} 2>&1 | Select-Object -Last 3; ` +
      `if (-not (Test-Path "$HOME/.agents/.system")) { agents setup 2>&1 | Select-Object -Last 3 }; ` +
      `agents --version`;
    cmd = `powershell -NoProfile -EncodedCommand ${encodePowershell(script)}`;
  } else {
    const script =
      `npm install -g ${shellQuote(spec)} 2>&1 | tail -3; ` +
      `if [ ! -d ~/.agents/.system ]; then agents setup 2>&1 | tail -3 || true; fi; ` +
      `agents --version`;
    cmd = `bash -lc ${shellQuote(script)}`;
  }
  const r = sshExec(target, cmd, { timeoutMs: 300000 });
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
}

/** Sentinel splitting the version output from the agent listing in one probe. */
const READY_MARKER = '@@AGENTS_READY@@';

export interface ReadyProbe {
  /** ssh connected and the remote login shell ran (our sentinel came back). */
  reachable: boolean;
  /** Remote agents-cli version (no leading `v`), or null if not installed. */
  version: string | null;
  /** Raw `agents view`/`list` output, for installed-agent checks. */
  view: string;
}

/**
 * Answer every readiness question in ONE ssh round-trip: reachable? (the login
 * shell ran and echoed our sentinel), agents-cli version, and the installed-agent
 * listing. This replaces three sequential probes (`true` + `agents --version` +
 * `agents view`) — 3 handshakes collapse to 1. Reachability keys off the sentinel
 * rather than the exit code, so a command that ran-but-failed is never mistaken
 * for a dead connection (only ssh's own failure drops the sentinel).
 */
export function readyProbe(target: string, os?: string): ReadyProbe {
  let cmd: string;
  if (remoteShellFor(os) === 'powershell') {
    // No `printf`/`||`; emit the sentinel with Write-Output and branch on
    // $LASTEXITCODE. Reachability still keys off the sentinel, not the code.
    const script =
      `agents --version 2>$null; Write-Output "${READY_MARKER}"; ` +
      `agents view 2>$null; if ($LASTEXITCODE -ne 0) { agents list 2>$null }`;
    cmd = `powershell -NoProfile -EncodedCommand ${encodePowershell(script)}`;
  } else {
    const script =
      `agents --version 2>/dev/null; printf '\\n${READY_MARKER}\\n'; ` +
      `agents view 2>/dev/null || agents list 2>/dev/null`;
    cmd = `bash -lc ${shellQuote(script)}`;
  }
  const r = sshExec(target, cmd, { timeoutMs: 20000 });
  return parseReadyProbe(r.stdout);
}

/** Pure parser for `readyProbe` output (unit-tested without ssh). */
export function parseReadyProbe(stdout: string): ReadyProbe {
  const idx = stdout.indexOf(READY_MARKER);
  if (idx === -1) return { reachable: false, version: null, view: '' };
  const version = stdout.slice(0, idx).trim().replace(/^v/, '') || null;
  return { reachable: true, version, view: stdout.slice(idx + READY_MARKER.length) };
}

/** True if `view` output lists the named agent (word-boundary, case-insensitive). */
export function viewHasAgent(view: string, agent: string): boolean {
  return new RegExp(`\\b${agent}\\b`, 'i').test(view);
}

export interface EnsureReadyOptions {
  agent: string;
  /** Throw instead of warn when the agent isn't installed remotely. */
  requireAgent?: boolean;
}

/**
 * Verify a host can run the agent: reachable + agents-cli present. Throws with an
 * actionable message otherwise. Agent-not-installed is a warning by default (the
 * remote `agents run` will surface it); pass requireAgent to make it fatal.
 *
 * One ssh round-trip (`readyProbe`) covers all three checks.
 */
export function ensureHostReady(host: Host, opts: EnsureReadyOptions): { warnings: string[] } {
  const target = sshTargetFor(host);
  const probe = readyProbe(target, host.os ?? resolveRemoteOsSync(host.name));
  if (!probe.reachable) {
    throw new Error(`Host "${host.name}" (${target}) is not reachable over SSH. Check it's online and key auth works.`);
  }
  if (!probe.version) {
    throw new Error(
      `agents-cli is not installed on "${host.name}". Enroll it first: agents hosts add ${host.name} (bootstraps agents-cli).`,
    );
  }
  const warnings: string[] = [];
  if (!viewHasAgent(probe.view, opts.agent)) {
    const msg = `Agent "${opts.agent}" may not be installed on "${host.name}" (remote \`agents add ${opts.agent}\` to install).`;
    if (opts.requireAgent) throw new Error(msg);
    warnings.push(msg);
  }
  return { warnings };
}
