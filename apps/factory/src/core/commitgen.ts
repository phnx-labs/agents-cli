import { spawn } from 'child_process';
import { resolveAgentsBin, bootstrapPath } from './agentsBin';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_MESSAGE_CHARS = 200;

export async function generateCommitMessageWithClaude(
  prompt: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<string | null> {
  // Resolve the absolute `agents` binary + bootstrapped PATH so this works when
  // the editor is launched from Dock/Finder with a minimal PATH (see agentsBin).
  let bin: string;
  let runPath: string;
  try {
    bin = await resolveAgentsBin();
    runPath = `${bootstrapPath(bin)}:${process.env.PATH ?? ''}`;
  } catch {
    return null;
  }

  return new Promise<string | null>((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const child = spawn(
      bin,
      ['run', 'claude', prompt, '--mode', 'plan', '--model', 'haiku', '--quiet'],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: runPath } }
    );

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('exit', (code) => {
      if (code !== 0) {
        if (stderr.trim()) {
          // surface stderr via a sentinel so caller can detect agent failure
          return finish(null);
        }
        return finish(null);
      }
      finish(sanitizeCommitMessage(stdout));
    });
  });
}

export function sanitizeCommitMessage(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Take only the first non-empty line — commit messages are single-line
  const firstLine = trimmed.split('\n').map(l => l.trim()).find(l => l.length > 0);
  if (!firstLine) return null;

  // Strip wrapping quotes/backticks
  const stripped = firstLine.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!stripped) return null;

  // Reject if it looks like an error/refusal rather than a commit message
  if (!/^[a-z]+:/i.test(stripped)) return null;

  return stripped.length > MAX_MESSAGE_CHARS ? stripped.slice(0, MAX_MESSAGE_CHARS).trim() : stripped;
}
