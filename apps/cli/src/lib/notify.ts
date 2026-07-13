/**
 * Urgent-block phone notifier.
 *
 * Reuses the OpenClaw Telegram gateway on the local mac-mini (Jeff/`default` bot)
 * instead of raw bot tokens. Notifies once per block (tracked by `notifiedAt`).
 * Best-effort: any openclaw failure is surfaced as a warning, not a hard error,
 * so a notification hiccup never blocks the agent.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { OpenBlock } from './feed.js';

const execFileAsync = promisify(execFile);

export interface NotifyOptions {
  channel?: string;
  account?: string;
  /** OpenClaw destination (Telegram chat id). Defaults to Muqsit's chat. */
  target?: string;
  dryRun?: boolean;
}

export interface NotifyResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

function formatBlock(block: OpenBlock): string {
  const q = block.questions[0];
  const header = q?.header ? `[${q.header}] ` : '';
  const text = q?.text ?? 'Agent needs input';
  const host = block.host ? ` on ${block.host}` : '';
  const cls = block.blockClass ?? 'approval';
  const cost = block.costOfDelay ?? 'low';
  return `🚨 ${cls.toUpperCase()}${host} — ${header}${text} (cost: ${cost}, id: ${block.blockId})`;
}

/** Build openclaw argv for urgent notify (exported for tests). */
export function buildOpenClawNotifyArgs(
  text: string,
  options: Pick<NotifyOptions, 'channel' | 'account' | 'target'> = {},
): string[] {
  const channel = options.channel ?? 'telegram';
  const account = options.account ?? 'default';
  const target = options.target ?? '6078999250';
  return [
    'message',
    'send',
    '--channel',
    channel,
    '--account',
    account,
    '--target',
    target,
    '--message',
    text,
  ];
}

export async function notifyUrgentBlock(
  block: OpenBlock,
  options: NotifyOptions = {},
): Promise<NotifyResult> {
  if (block.notifiedAt) {
    return { ok: true, skipped: true };
  }

  if (options.dryRun) {
    return { ok: true, skipped: true };
  }

  // Check that openclaw is installed.
  try {
    await execFileAsync('which', ['openclaw']);
  } catch {
    return { ok: false, error: 'openclaw CLI not found on PATH' };
  }

  const text = formatBlock(block);

  try {
    await execFileAsync('openclaw', buildOpenClawNotifyArgs(text, options));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
