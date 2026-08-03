/**
 * Owner notifier — the one seam for "ping the human" messages.
 *
 * Every human-facing owner notification (feed urgent-block dispatch, monitor
 * `notify` action, `agents notify`) funnels through the single channel seam:
 * `lookupTransport(channel, meta).provider.send(text, opts)`. The recipient comes
 * from `notify.owner` in agents.yaml — never a hardcoded chat id — so changing the
 * owner is honoured by every path at once. `notify.transports` picks the actual
 * provider per host (rush telegram on zion, openclaw-telegram on mac-mini).
 * Best-effort: a delivery failure is returned to the caller, never thrown, so a
 * notification hiccup never blocks the agent. That is why this module resolves
 * with `lookupTransport` and not the `die()`-capable `resolveTransport` — the
 * monitor daemon and the feed-dispatch loop call in here, and `process.exit()`
 * would take them down on a typo'd channel name, bypassing their try/catch.
 */
import type { OpenBlock } from './feed.js';
import type { Meta } from './types.js';
import { readMeta } from './state.js';
import { registerBuiltinProviders } from './channels/providers/index.js';
import { lookupTransport } from './channels/resolve.js';
import type { SendResult } from './channels/registry.js';

export interface OwnerNotifyOptions {
  /** Config source (defaults to `readMeta()`); lets callers/tests inject it. */
  meta?: Meta;
  /** Override the owner channel from `notify.owner.channel`. */
  channel?: string;
  /** Override the owner target from `notify.owner.to`. */
  target?: string;
  /** Resolve + build the delivery but do not actually send. */
  dryRun?: boolean;
}

export interface NotifyResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

export function formatUrgentBlockMessage(block: OpenBlock): string {
  const q = block.questions[0];
  const header = q?.header ? `[${q.header}] ` : '';
  const text = q?.text ?? 'Agent needs input';
  const host = block.host ? ` on ${block.host}` : '';
  const cls = block.blockClass ?? 'approval';
  const cost = block.costOfDelay ?? 'low';
  return `URGENT ${cls.toUpperCase()}${host}: ${header}${text} (cost: ${cost}, id: ${block.blockId})`;
}

/**
 * Build openclaw argv for a Telegram send (used by the openclaw-telegram
 * provider and its tests). `target` is required — the recipient is always
 * resolved by the caller, never defaulted to a hardcoded number here.
 */
export function buildOpenClawNotifyArgs(
  text: string,
  opts: { target: string; channel?: string; account?: string },
): string[] {
  const channel = opts.channel ?? 'telegram';
  const account = opts.account ?? 'default';
  return [
    'message',
    'send',
    '--channel',
    channel,
    '--account',
    account,
    '--target',
    opts.target,
    '--message',
    text,
  ];
}

/**
 * Deliver a message to the configured owner through the one channel seam.
 * `channel`/`target` default to `notify.owner.{channel,to}`; `notify.transports`
 * selects the provider per host. A missing owner config or a delivery failure
 * (e.g. openclaw not on PATH) returns a clean `SendResult` error — never a raw
 * ENOENT — so callers surface a consistent, best-effort failure.
 */
export async function sendToOwner(text: string, options: OwnerNotifyOptions = {}): Promise<SendResult> {
  const meta = options.meta ?? readMeta();
  const owner = meta.notify?.owner;
  const channel = options.channel ?? owner?.channel;
  const target = options.target ?? owner?.to;
  if (!channel || !target) {
    return {
      ok: false,
      channel: channel ?? 'unknown',
      id: target ?? '',
      error: 'notify.owner.{channel,to} not set in agents.yaml',
    };
  }
  registerBuiltinProviders();
  const { provider, error } = lookupTransport(channel, meta);
  if (!provider) {
    return { ok: false, channel, id: target, error };
  }
  return provider.send(text, { target, dryRun: options.dryRun });
}

export async function notifyUrgentBlock(
  block: OpenBlock,
  options: OwnerNotifyOptions = {},
): Promise<NotifyResult> {
  if (block.notifiedAt) {
    return { ok: true, skipped: true };
  }

  if (options.dryRun) {
    return { ok: true, skipped: true };
  }

  const result = await sendToOwner(formatUrgentBlockMessage(block), options);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
