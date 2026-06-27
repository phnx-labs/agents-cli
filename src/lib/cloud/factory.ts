/**
 * Factory (Droid) cloud provider.
 *
 * Dispatches to a Factory **Droid Computer** — a persistent cloud VM (managed
 * by Factory, or bring-your-own via `droid computer register`). There is no
 * `droid cloud run`; remote execution = reach the computer over the Droid relay
 * (`droid computer ssh <name>`) and run a headless `droid exec` there.
 *
 * `droid exec` is synchronous (it runs to completion and exits, unlike Codex
 * Cloud which is async server-side). So `dispatch()` runs the remote exec to
 * completion with `--output-format stream-json`, buffers the NDJSON events, and
 * `stream()` replays them. The task id is droid's own `session_id` (captured
 * from the run output), so it lines up with `droid exec -s <id>` for future
 * resume support.
 *
 * Transport note: the exact relay SSH composition (user + ProxyCommand) is
 * built in `buildSshArgs()` and must be confirmed against a live provisioned
 * Droid Computer (Factory auth required). `capabilities().available` gates on
 * the droid binary + a configured computer so the provider fails with a clear
 * message rather than misfiring when unconfigured.
 */

import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  CloudProvider,
  CloudTask,
  CloudTaskStatus,
  CloudEvent,
  DispatchOptions,
  ProviderCapabilities,
  DroidAutonomy,
} from './types.js';
import { getShimsDir } from '../state.js';

const SHIMS_DIR = getShimsDir();

const DEFAULT_AUTONOMY: DroidAutonomy = 'high';
const VALID_AUTONOMY = new Set<DroidAutonomy>(['low', 'medium', 'high']);

/** Locate the droid binary, checking agents-cli shims first then PATH. */
export function findDroidBinary(): string | null {
  const shim = path.join(SHIMS_DIR, 'droid');
  if (fs.existsSync(shim)) return shim;
  try {
    return execFileSync('which', ['droid'], { stdio: 'pipe' }).toString().trim() || null;
  } catch {
    return null;
  }
}

/** Normalize an autonomy value, falling back to the safe cloud default (`high`). */
export function resolveAutonomy(value: unknown, fallback: DroidAutonomy = DEFAULT_AUTONOMY): DroidAutonomy {
  return typeof value === 'string' && VALID_AUTONOMY.has(value as DroidAutonomy)
    ? (value as DroidAutonomy)
    : fallback;
}

/**
 * Build the remote `droid exec` argv. Headless, stream-json output, given
 * autonomy. `sessionId` (when resuming) maps to `-s`.
 */
export function buildExecArgs(
  prompt: string,
  opts: { autonomy: DroidAutonomy; sessionId?: string },
): string[] {
  const args = ['exec', '--auto', opts.autonomy, '--output-format', 'stream-json'];
  if (opts.sessionId) args.push('-s', opts.sessionId);
  args.push(prompt);
  return args;
}

/**
 * Build the `ssh` argv that runs a remote command on a Droid Computer through
 * the Droid relay. The relay is used as an OpenSSH ProxyCommand
 * (`droid computer ssh <name> --proxy`), so the connection rides Factory's
 * brokered tunnel rather than a directly reachable host.
 *
 * `remoteArgv` is the already-built remote command (e.g. droid exec argv); it is
 * shell-quoted into a single remote command string.
 */
export function buildSshArgs(
  computer: string,
  remoteBin: string,
  remoteArgv: string[],
  opts: { droidBin: string; user: string; port?: string },
): string[] {
  const remoteCmd = [remoteBin, ...remoteArgv].map(shellQuote).join(' ');
  const proxy = `ProxyCommand=${opts.droidBin} computer ssh ${computer} --proxy --port %p`;
  return [
    '-o', proxy,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', opts.port ?? '22',
    `${opts.user}@${computer}`,
    remoteCmd,
  ];
}

/** POSIX single-quote a shell argument. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Map a droid stream-json `result.subtype` / `is_error` to a CloudTaskStatus. */
export function mapResultStatus(line: { is_error?: boolean; subtype?: string }): CloudTaskStatus {
  if (line.is_error) return 'failed';
  if (line.subtype && /cancel/i.test(line.subtype)) return 'cancelled';
  return 'completed';
}

/**
 * Map one parsed droid stream-json event to a CloudEvent. The stream-json
 * schema is only partially documented, so this is defensive: known shapes map
 * to typed events, everything else surfaces as `unknown` rather than being
 * dropped (mirrors the rest of the cloud event pipeline).
 */
export function mapDroidEvent(obj: Record<string, unknown>): CloudEvent {
  const ts = new Date().toISOString();
  const type = String(obj.type ?? '');

  switch (type) {
    case 'result': {
      return {
        type: 'done',
        status: mapResultStatus(obj as { is_error?: boolean; subtype?: string }),
        summary: typeof obj.result === 'string' ? obj.result : undefined,
        timestamp: ts,
      };
    }
    case 'assistant':
    case 'message':
    case 'text': {
      const content = extractText(obj);
      if (content) return { type: 'text', content, timestamp: ts };
      break;
    }
    case 'thinking':
    case 'reasoning': {
      const content = extractText(obj);
      if (content) return { type: 'thinking', content, timestamp: ts };
      break;
    }
    case 'tool_call':
    case 'tool_use': {
      return { type: 'tool_use', tool: String(obj.name ?? obj.tool ?? 'tool'), input: obj.input ?? obj.arguments ?? {}, timestamp: ts };
    }
    case 'tool_result': {
      return { type: 'tool_result', tool: String(obj.name ?? obj.tool ?? 'tool'), output: obj.output ?? obj.result ?? '', timestamp: ts };
    }
    case 'error': {
      return { type: 'error', message: String(obj.message ?? obj.error ?? 'unknown error'), timestamp: ts };
    }
  }
  return { type: 'unknown', name: type || 'unknown', data: JSON.stringify(obj), timestamp: ts };
}

/** Pull a text string out of the varied droid message shapes. */
function extractText(obj: Record<string, unknown>): string {
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.content === 'string') return obj.content;
  if (Array.isArray(obj.content)) {
    return obj.content
      .map((c) => (c && typeof c === 'object' && typeof (c as Record<string, unknown>).text === 'string' ? (c as Record<string, unknown>).text as string : ''))
      .join('');
  }
  const msg = obj.message;
  if (msg && typeof msg === 'object') return extractText(msg as Record<string, unknown>);
  return '';
}

/** A completed droid run, buffered in-process for `stream()` to replay. */
interface BufferedRun {
  events: CloudEvent[];
  task: CloudTask;
}

export class FactoryCloudProvider implements CloudProvider {
  id = 'factory' as const;
  name = 'Factory (Droid)';

  private defaultComputer?: string;
  private defaultAutonomy: DroidAutonomy;
  /** session_id → buffered run, populated by dispatch, drained by stream. */
  private runs = new Map<string, BufferedRun>();

  constructor(config?: { computer?: string; autonomy?: DroidAutonomy }) {
    this.defaultComputer = config?.computer;
    this.defaultAutonomy = resolveAutonomy(config?.autonomy);
  }

  capabilities(): ProviderCapabilities {
    const droid = findDroidBinary() !== null;
    const computer = Boolean(this.defaultComputer);
    return {
      // Reachable only when the droid binary exists AND a computer is set.
      // (A per-dispatch --computer can still override the missing default.)
      available: droid && computer,
      dispatch: droid,
      status: droid,
      list: droid,
      stream: droid,
      cancel: false,
      message: false,
      multiRepo: false,
      skills: false,
      images: false,
    };
  }

  async dispatch(options: DispatchOptions): Promise<CloudTask> {
    const droidBin = findDroidBinary();
    if (!droidBin) {
      throw new Error('droid CLI not found. Install it: curl -fsSL https://app.factory.ai/cli | sh');
    }

    const computer = (options.providerOptions?.computer as string | undefined) ?? this.defaultComputer;
    if (!computer) {
      throw new Error(
        'Factory cloud requires a Droid Computer. Pass --computer <name>, or set ' +
          'cloud.providers.factory.computer in ~/.agents/agents.yaml. Create one in ' +
          'Factory (Settings → Droid Computers), or register a machine with `droid computer register`.',
      );
    }

    const autonomy = resolveAutonomy(options.providerOptions?.autonomy ?? options.providerOptions?.mode, this.defaultAutonomy);
    const user = (options.providerOptions?.user as string | undefined) ?? 'droid';

    const execArgs = buildExecArgs(options.prompt, { autonomy });
    const sshArgs = buildSshArgs(computer, 'droid', execArgs, { droidBin, user });

    const { events, status, summary, sessionId } = await this.runRemote(sshArgs);

    const now = new Date().toISOString();
    const id = sessionId ?? `droid-${Date.now()}`;
    const task: CloudTask = {
      id,
      provider: 'factory',
      status,
      agent: 'droid',
      prompt: options.prompt,
      summary,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(id, { events, task });
    return task;
  }

  /** Run the remote droid exec to completion, collecting events + final result. */
  private runRemote(sshArgs: string[]): Promise<{ events: CloudEvent[]; status: CloudTaskStatus; summary?: string; sessionId?: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      const events: CloudEvent[] = [];
      let status: CloudTaskStatus = 'failed';
      let summary: string | undefined;
      let sessionId: string | undefined;
      let stdoutBuf = '';
      let stderr = '';

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          // Non-JSON line (banner, ssh notice) — surface it, don't drop it.
          events.push({ type: 'unknown', name: 'stdout', data: trimmed, timestamp: new Date().toISOString() });
          return;
        }
        if (typeof obj.session_id === 'string') sessionId = obj.session_id;
        const event = mapDroidEvent(obj);
        if (event.type === 'done') {
          status = event.status ?? 'completed';
          summary = event.summary ?? summary;
        }
        events.push(event);
      };

      proc.stdout.on('data', (d: Buffer) => {
        stdoutBuf += d.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (stdoutBuf) handleLine(stdoutBuf);
        if (code !== 0 && events.every((e) => e.type !== 'done')) {
          // Surface the auth error verbatim — it's the common first-run failure.
          const detail = stderr.trim() || `ssh exited ${code}`;
          reject(new Error(`Factory dispatch failed: ${detail}`));
          return;
        }
        resolve({ events, status, summary, sessionId });
      });
    });
  }

  async status(taskId: string): Promise<CloudTask> {
    const run = this.runs.get(taskId);
    if (run) return run.task;
    // No remote task registry — the command layer falls back to the local store.
    throw new Error(`No live status for Factory task ${taskId} (synchronous run; see local cache).`);
  }

  async list(): Promise<CloudTask[]> {
    // Factory has no remote task list; `agents cloud list` reads the local store.
    return [...this.runs.values()].map((r) => r.task);
  }

  async *stream(taskId: string): AsyncIterable<CloudEvent> {
    const run = this.runs.get(taskId);
    if (!run) {
      yield {
        type: 'error',
        message: `Factory run ${taskId} is not buffered in this process. droid exec is synchronous — its output is not retained after the run completes. See 'agents cloud status ${taskId}' for the summary.`,
        timestamp: new Date().toISOString(),
      };
      return;
    }
    for (const event of run.events) yield event;
  }

  async cancel(_taskId: string): Promise<void> {
    throw new Error('Cancel is not supported for Factory (Droid) — droid exec runs synchronously to completion.');
  }

  async message(_taskId: string, _content: string): Promise<void> {
    throw new Error('Follow-up messages are not yet supported for Factory (Droid) cloud tasks.');
  }
}
