import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import type { ComputerClient, RPCResponse } from '../computer-rpc.js';
import { resolvePolicyPath } from '../computer-rpc.js';
import { COMPUTER_INPUT_GATED_VERBS, formatComputerPermissionGrantHint } from '../permissions.js';
import { emit as emitEvent } from '../feed/events.js';
import { recordComputerSession } from '../session/db.js';
import { resolveActor } from '../actor.js';

export interface AppInfo {
  pid: number;
  name: string;
  bundle_id: string;
  active: boolean;
}

type ComputerInputVerb = typeof COMPUTER_INPUT_GATED_VERBS[number];

interface TargetAdmission {
  sessionId: string;
  selector: string;
  gateClass: 'input';
  pid: number;
  bundle_id: string;
  name: string;
  admittedAtMs: number;
  admittedByVerb: ComputerInputVerb;
}

interface AdmissionCacheFile {
  admissions?: TargetAdmission[];
}

function isComputerInputVerb(verb: string | undefined): verb is ComputerInputVerb {
  return typeof verb === 'string' && (COMPUTER_INPUT_GATED_VERBS as readonly string[]).includes(verb);
}

function computerSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.CODEX_THREAD_ID
    || env.CLAUDE_CODE_SESSION_ID
    || env.CLAUDE_SESSION_ID
    || env.AGENTS_SESSION_ID
    || env.AGENTS_RUN_ID
    || null;
}

function admissionCachePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENTS_COMPUTER_ADMISSION_CACHE) return env.AGENTS_COMPUTER_ADMISSION_CACHE;
  return path.join(path.dirname(resolvePolicyPath()), 'computer-target-admissions.json');
}

function targetSelector(opts: { bundle?: string }): string {
  return opts.bundle ? `bundle:${opts.bundle}` : 'frontmost';
}

function readAdmissionCache(filePath: string): TargetAdmission[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AdmissionCacheFile;
    return Array.isArray(parsed.admissions) ? parsed.admissions.filter(isAdmission) : [];
  } catch {
    return [];
  }
}

function isAdmission(v: unknown): v is TargetAdmission {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r.sessionId !== undefined
    && typeof r.sessionId === 'string'
    && typeof r.selector === 'string'
    && r.gateClass === 'input'
    && typeof r.pid === 'number'
    && typeof r.bundle_id === 'string'
    && typeof r.name === 'string'
    && typeof r.admittedAtMs === 'number'
    && isComputerInputVerb(r.admittedByVerb as string | undefined);
}

function rememberAdmission(app: AppInfo, opts: {
  selector: string;
  verb: ComputerInputVerb;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): void {
  const sessionId = computerSessionId(opts.env);
  if (!sessionId) return;

  const filePath = admissionCachePath(opts.env);
  const admissions = readAdmissionCache(filePath);
  const next: TargetAdmission = {
    sessionId,
    selector: opts.selector,
    gateClass: 'input',
    pid: app.pid,
    bundle_id: app.bundle_id,
    name: app.name,
    admittedAtMs: opts.nowMs ?? Date.now(),
    admittedByVerb: opts.verb,
  };
  const filtered = admissions.filter((a) =>
    !(a.sessionId === sessionId && a.selector === opts.selector && a.gateClass === 'input')
  );
  filtered.push(next);

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ admissions: filtered }, null, 2), { mode: 0o600 });
  } catch {
    // Cache persistence is best-effort; the daemon remains the final gate.
  }
}

function findAdmission(opts: { selector: string; env?: NodeJS.ProcessEnv }): TargetAdmission | null {
  const sessionId = computerSessionId(opts.env);
  if (!sessionId) return null;
  const admissions = readAdmissionCache(admissionCachePath(opts.env));
  const matches = admissions
    .filter((a) => a.sessionId === sessionId && a.selector === opts.selector && a.gateClass === 'input')
    .sort((a, b) => b.admittedAtMs - a.admittedAtMs);
  return matches[0] ?? null;
}

export function pickTarget(
  list: AppInfo[],
  opts: { pid?: number; bundle?: string },
): { ok: true; app: AppInfo } | { ok: false; error: string } {
  if (opts.pid != null) {
    const app = list.find((a) => a.pid === opts.pid);
    return { ok: true, app: app ?? { pid: opts.pid, name: '', bundle_id: '', active: false } };
  }
  if (opts.bundle) {
    const app = list.find((a) => a.bundle_id === opts.bundle);
    if (!app) {
      return {
        ok: false,
        error: `bundle not in allow list (or not running): ${opts.bundle}\n${formatComputerPermissionGrantHint(opts.bundle)}`,
      };
    }
    return { ok: true, app };
  }
  const active = list.find((a) => a.active);
  if (!active) {
    return {
      ok: false,
      error: `no active app found in allow list\n${formatComputerPermissionGrantHint()}`,
    };
  }
  return { ok: true, app: active };
}

function unwrap(r: RPCResponse): Record<string, unknown> {
  if (r.error) {
    console.error(`error: ${r.error.code}: ${r.error.message}`);
    process.exit(1);
  }
  return r.result ?? {};
}

export async function resolveTargetPidDecision(
  client: ComputerClient,
  opts: { pid?: number; bundle?: string },
  gate?: { verb?: string; env?: NodeJS.ProcessEnv; nowMs?: number },
): Promise<{ ok: true; pid: number; source: 'pid' | 'list_apps' | 'session_admission' } | { ok: false; error: string }> {
  if (opts.pid != null) return { ok: true, pid: opts.pid, source: 'pid' };
  const apps = unwrap(await client.call('list_apps'));
  const list = (apps.apps as AppInfo[]) || [];
  const picked = pickTarget(list, opts);
  const verb = gate?.verb;
  const selector = targetSelector(opts);
  if (picked.ok && isComputerInputVerb(verb)) {
    rememberAdmission(picked.app, { selector, verb, env: gate?.env, nowMs: gate?.nowMs });
  }
  if (!picked.ok) {
    if (isComputerInputVerb(verb)) {
      const admitted = findAdmission({ selector, env: gate?.env });
      if (admitted) return { ok: true, pid: admitted.pid, source: 'session_admission' };
    }
    return { ok: false, error: picked.error };
  }
  return { ok: true, pid: picked.app.pid, source: 'list_apps' };
}

const COMPUTER_INVOCATION_ID = randomUUID();

export function emitComputerAction(
  verb: string,
  targetPid: number | undefined,
  opts: { bundle?: string; device?: string },
  extra: Record<string, unknown> = {},
): void {
  emitEvent('computer.action', {
    command: verb,
    invocationId: COMPUTER_INVOCATION_ID,
    targetPid,
    bundle: opts.bundle,
    device: opts.device,
    ...extra,
  });
  try {
    recordComputerSession({
      invocationId: COMPUTER_INVOCATION_ID,
      sessionId: process.env.AGENT_SESSION_ID || process.env.AGENTS_SESSION_ID,
      launchId: process.env.AGENT_LAUNCH_ID,
      actor: resolveActor().id,
      actionCount: 1,
      taskPreview: typeof extra.task === 'string' ? extra.task : undefined,
    });
  } catch {
    // Recording is best-effort; the action and its event are already done.
  }
}
