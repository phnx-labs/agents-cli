/**
 * Codex Cloud provider -- wraps the `codex` CLI for cloud dispatch.
 *
 * Delegates to `codex cloud exec/status/list` subcommands, parsing their
 * JSON or text output into the unified CloudTask format. Streaming is
 * emulated via polling since Codex Cloud lacks an SSE endpoint.
 */

import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  CloudProvider,
  CloudTask,
  CloudTaskStatus,
  CloudEvent,
  DispatchOptions,
  ProviderCapabilities,
} from './types.js';
import { resolveDispatchRepos, MissingTargetError } from './types.js';
import { getShimsDir } from '../state.js';

const SHIMS_DIR = getShimsDir();

/** Map a Codex Cloud status string to the canonical CloudTaskStatus enum. */
function mapStatus(s: string): CloudTaskStatus {
  const lower = s.toLowerCase();
  if (lower.includes('queued') || lower.includes('pending')) return 'queued';
  if (lower.includes('running') || lower.includes('in_progress')) return 'running';
  if (lower.includes('completed') || lower.includes('succeeded') || lower.includes('success')) return 'completed';
  if (lower.includes('failed') || lower.includes('error')) return 'failed';
  if (lower.includes('cancelled') || lower.includes('canceled')) return 'cancelled';
  return 'running';
}

/** Locate the codex binary, checking agents-cli shims first then PATH. */
function findCodexBinary(): string | null {
  // Check agents-cli shims first
  const shim = path.join(SHIMS_DIR, 'codex');
  if (fs.existsSync(shim)) return shim;

  // Check PATH via which
  try {
    return execFileSync('which', ['codex'], { stdio: 'pipe' }).toString().trim() || null;
  } catch {
    return null;
  }
}

/** Check whether the codex CLI is installed and reachable. */
function codexAvailable(): boolean {
  return findCodexBinary() !== null;
}

/** Spawn the codex CLI with the given arguments and capture its output. */
function runCodex(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const bin = findCodexBinary();
  if (!bin) return Promise.resolve({ stdout: '', stderr: 'codex not found', code: 127 });

  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

/** Best-effort parse of codex CLI output into task fields (tries JSON, then key:value lines). */
function parseTaskFromText(text: string): Partial<CloudTask> {
  // Codex cloud list/status output varies. Try JSON first, then parse text.
  try {
    return JSON.parse(text);
  } catch {
    // Parse text output line by line for key: value patterns
    const result: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*(\w[\w\s]*\w)\s*[:=]\s*(.+)\s*$/);
      if (match) {
        result[match[1].toLowerCase().replace(/\s+/g, '_')] = match[2].trim();
      }
    }
    return {
      id: result.id || result.task_id,
      status: result.status ? mapStatus(result.status) : undefined,
      summary: result.summary || result.output,
    };
  }
}

export class CodexCloudProvider implements CloudProvider {
  id = 'codex' as const;
  name = 'Codex Cloud';
  targetKind = 'env' as const;
  // No listTargets: OpenAI ships no non-interactive "list environments"
  // command. `codex cloud exec` requires --env and the help points at the
  // interactive `codex cloud` TUI to browse. So discovery is guidance-only.

  private defaultEnv?: string;

  constructor(config?: { env?: string }) {
    this.defaultEnv = config?.env;
  }

  capabilities(): ProviderCapabilities {
    const available = codexAvailable();
    return {
      available,
      dispatch: available,
      status: available,
      list: available,
      stream: available,
      cancel: false,
      message: false,
      multiRepo: false,
      // `codex cloud exec --env <id> <prompt>` is the only dispatch surface the
      // codex CLI exposes — it has no flag to attach images or ride-along skills,
      // and the env bundles its own context at creation time. Both stay false
      // until the upstream CLI grows an attachment surface.
      skills: false,
      images: false,
    };
  }

  async dispatch(options: DispatchOptions): Promise<CloudTask> {
    const env = (options.providerOptions?.env as string | undefined) ?? this.defaultEnv;
    if (!env) {
      throw new MissingTargetError(
        'env',
        'Codex Cloud requires --env <id>.',
        'Codex environments are created in the Codex web UI and bundle a repo + setup. ' +
          'Browse yours with `codex cloud` (interactive), then re-run with --env <id> ' +
          'or set a default in ~/.agents/agents.yaml under cloud.providers.codex.env.',
      );
    }

    // Codex envs bundle their own repo list — the repos a task can touch are
    // fixed at env-creation time, not per-dispatch. Passing 2+ repos here is
    // almost always a misconfiguration: either the user meant to dispatch to
    // Rush (which does support multi-repo), or they need to create/pick a
    // Codex env that already contains those repos. Fail loudly rather than
    // silently ignore the extras.
    const repos = resolveDispatchRepos(options);
    if (repos.length > 1) {
      throw new Error(
        `Codex Cloud does not support multi-repo dispatch. Got ${repos.length} repos (${repos.join(', ')}). ` +
          `Codex envs bundle repos at the env layer — either configure a Codex env that includes all of these repos, ` +
          `or switch to --provider rush (which clones each repo into /workspace/<owner>/<name>/).`,
      );
    }

    const args = ['cloud', 'exec', '--env', env];
    if (options.branch) args.push('--branch', options.branch);
    args.push(options.prompt);

    const { stdout, stderr, code } = await runCodex(args);
    if (code !== 0) {
      throw new Error(`codex cloud exec failed: ${stderr || stdout}`);
    }

    // Parse task ID from output. Codex typically prints the task ID.
    const taskId = extractTaskId(stdout) ?? `codex-${Date.now()}`;
    const now = new Date().toISOString();

    return {
      id: taskId,
      provider: 'codex',
      status: 'queued',
      agent: 'codex',
      prompt: options.prompt,
      repo: repos[0],
      repos: repos.length > 0 ? repos : undefined,
      branch: options.branch,
      createdAt: now,
      updatedAt: now,
    };
  }

  async status(taskId: string): Promise<CloudTask> {
    const { stdout, stderr, code } = await runCodex(['cloud', 'status', taskId]);
    if (code !== 0) {
      throw new Error(`codex cloud status failed: ${stderr || stdout}`);
    }

    const parsed = parseTaskFromText(stdout);
    const now = new Date().toISOString();

    return {
      id: taskId,
      provider: 'codex',
      status: parsed.status ?? 'running',
      agent: 'codex',
      prompt: parsed.prompt ?? '',
      summary: parsed.summary,
      createdAt: parsed.createdAt ?? now,
      updatedAt: now,
    };
  }

  async list(filter?: { status?: CloudTaskStatus }): Promise<CloudTask[]> {
    const args = ['cloud', 'list', '--json', '--limit', '20'];
    if (this.defaultEnv) args.push('--env', this.defaultEnv);

    const { stdout, stderr, code } = await runCodex(args);
    if (code !== 0) {
      throw new Error(`codex cloud list failed: ${stderr || stdout}`);
    }

    try {
      const data = JSON.parse(stdout);
      const tasks: CloudTask[] = (data.tasks ?? data ?? []).map((t: Record<string, unknown>) => ({
        id: (t.id || t.task_id) as string,
        provider: 'codex' as const,
        status: mapStatus((t.status as string) ?? ''),
        agent: 'codex',
        prompt: (t.prompt || t.query || '') as string,
        branch: (t.branch as string) || undefined,
        summary: (t.summary as string) || undefined,
        createdAt: (t.created_at as string) || '',
        updatedAt: (t.updated_at as string) || '',
      }));

      if (filter?.status) {
        return tasks.filter((t) => t.status === filter.status);
      }
      return tasks;
    } catch {
      return [];
    }
  }

  async *stream(taskId: string): AsyncIterable<CloudEvent> {
    // Codex Cloud doesn't have SSE streaming. Poll status until terminal.
    const terminalStatuses = new Set<CloudTaskStatus>(['completed', 'failed', 'cancelled']);
    let lastStatus = '';

    while (true) {
      try {
        const task = await this.status(taskId);
        if (task.status !== lastStatus) {
          lastStatus = task.status;
          const ts = new Date().toISOString();
          if (terminalStatuses.has(task.status)) {
            yield { type: 'done', status: task.status, summary: task.summary, timestamp: ts };
          } else {
            yield { type: 'status', status: task.status, timestamp: ts };
          }
        }
        if (terminalStatuses.has(task.status)) break;
      } catch (err) {
        yield {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        };
        break;
      }

      // Poll every 5 seconds
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  async cancel(_taskId: string): Promise<void> {
    // Codex Cloud doesn't expose a cancel command via CLI.
    throw new Error('Cancel is not supported for Codex Cloud tasks via CLI.');
  }

  async message(_taskId: string, _content: string): Promise<void> {
    throw new Error('Follow-up messages are not supported for Codex Cloud tasks.');
  }
}

/** Extract a task ID from codex CLI output (JSON field, key:value line, or UUID pattern). */
function extractTaskId(output: string): string | undefined {
  // Try JSON first
  try {
    const data = JSON.parse(output);
    return data.id || data.task_id;
  } catch {
    // Look for UUID-like patterns or task IDs in the text
    const match = output.match(/(?:task[_\s]?id|id)\s*[:=]\s*["']?([a-zA-Z0-9_-]+)/i)
      || output.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
      || output.match(/(task_[a-zA-Z0-9]+)/i);
    return match?.[1];
  }
}
