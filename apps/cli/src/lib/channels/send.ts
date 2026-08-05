/**
 * Delivery envelope for `agents send` / `agents notify`.
 *
 * One primitive: resolve a destination (channel + target), compose text + urls +
 * attachments, hand off to a channel provider. `notify` is the same path with
 * destination defaulted to `notify.owner` in agents.yaml — owner is an address
 * alias (`--to owner`), not a separate stack.
 *
 * Agent control (`agents message`, `sessions inject`) stays outside this module.
 */
import type { Meta } from '../types.js';
import { getOwnerNotifyFromHumans } from '../humans.js';
import { registerBuiltinProviders } from './providers/index.js';
import { resolveTransport } from './resolve.js';
import type { SendResult } from './registry.js';

/** Normalized delivery request after CLI/config resolution. */
export interface SendEnvelope {
  text: string;
  channel: string;
  to: string;
  thread?: string;
  attachments?: string[];
  from?: string;
  dryRun?: boolean;
}

export interface ResolveSendInput {
  /**
   * Body text. Prefer `--text`; positional `[text]` is accepted for compat and
   * folded in when `--text` is omitted.
   */
  text?: string;
  /** Positional `[text]` from commander (legacy). */
  positionalText?: string;
  /**
   * Recipient. Channel-specific id, or the alias `owner` which expands to
   * `notify.owner.{channel,to}`.
   */
  to?: string;
  /** Provider/channel name. Required unless `to` is `owner` (or ownerMode). */
  channel?: string;
  thread?: string;
  /** Local file paths. */
  attachments?: string[];
  /** Links / remote media refs — appended to the body so every provider sees them. */
  urls?: string[];
  from?: string;
  dryRun?: boolean;
  /**
   * When true (`agents notify`), missing channel/to default to `notify.owner`.
   * Explicit flags still win.
   */
  ownerMode?: boolean;
}

export type ResolveSendResult =
  | { ok: true; envelope: SendEnvelope }
  | { ok: false; error: string };

const OWNER_ALIAS = 'owner';

/** True when the destination token means “the configured owner”. */
export function isOwnerAlias(to: string | undefined): boolean {
  return (to ?? '').trim().toLowerCase() === OWNER_ALIAS;
}

/** Compose body + optional URL lines (skip urls already present in the body). */
export function composeSendText(text: string, urls?: string[]): string {
  const body = text.trim();
  const extra = (urls ?? [])
    .map((u) => u.trim())
    .filter(Boolean)
    .filter((u) => !body.includes(u));
  if (extra.length === 0) return body;
  return body ? `${body}\n${extra.join('\n')}` : extra.join('\n');
}

/**
 * Read the owner destination; humans.yaml is the primary source, agents.yaml
 * notify.owner is the fallback. Returns null when neither is set.
 */
export function readOwnerDest(meta: Meta): { channel: string; to: string } | null {
  const humansOwner = getOwnerNotifyFromHumans();
  if (humansOwner) return humansOwner;
  const owner = meta.notify?.owner;
  const channel = owner?.channel?.trim();
  const to = owner?.to?.trim();
  if (!channel || !to) return null;
  return { channel, to };
}

/**
 * Resolve CLI/config into a send envelope. Pure except for reading `meta` —
 * no I/O, no provider registration — so unit tests do not need a real PATH.
 */
export function resolveSendEnvelope(input: ResolveSendInput, meta: Meta): ResolveSendResult {
  const positional = (input.positionalText ?? '').trim();
  const flagged = (input.text ?? '').trim();
  if (positional && flagged && positional !== flagged) {
    return {
      ok: false,
      error: 'Pass the message once: use --text, or a positional argument, not both with different values.',
    };
  }
  const rawText = flagged || positional;
  const urls = (input.urls ?? []).map((u) => u.trim()).filter(Boolean);
  const text = composeSendText(rawText, urls);
  if (!text) {
    return {
      ok: false,
      error: 'Message is empty. Pass --text "…", a positional message, and/or --url.',
    };
  }

  // Owner defaults fill only missing fields (and expand the bare "owner" alias).
  // humans.yaml is the primary source; notify.owner in agents.yaml is the
  // fallback for the migration window. Explicit --channel/--to always win.
  let channel = (input.channel ?? '').trim();
  let to = (input.to ?? '').trim();
  const usedOwnerAlias = isOwnerAlias(to);

  if (input.ownerMode || usedOwnerAlias) {
    const humansOwner = getOwnerNotifyFromHumans();
    const fallbackOwner = meta.notify?.owner;
    const ownerChannel = humansOwner?.channel ?? fallbackOwner?.channel?.trim() ?? '';
    const ownerTo = humansOwner?.to ?? fallbackOwner?.to?.trim() ?? '';
    if (!channel) channel = ownerChannel;
    if (!to || usedOwnerAlias) to = ownerTo;
  }

  if (!channel || !to) {
    const hint =
      input.ownerMode || usedOwnerAlias
        ? 'Set notify.{channel,to} in humans.yaml (or notify.owner in agents.yaml), or pass --channel and --to explicitly.'
        : 'Need --channel and --to (or --to owner with notify.owner configured). ' +
          'Example: agents send --channel desktop --to local --text "hi"';
    return { ok: false, error: hint };
  }

  const attachments = [
    ...(input.attachments ?? []),
  ]
    .map((p) => p.trim())
    .filter(Boolean);

  return {
    ok: true,
    envelope: {
      text,
      channel,
      to,
      thread: input.thread?.trim() || undefined,
      attachments: attachments.length ? attachments : undefined,
      from: input.from?.trim() || undefined,
      dryRun: input.dryRun,
    },
  };
}

/**
 * Register providers, resolve transport, deliver. Used by the CLI and by any
 * internal caller that already has a resolved envelope.
 */
export async function deliverEnvelope(envelope: SendEnvelope, meta: Meta): Promise<SendResult> {
  registerBuiltinProviders();
  const provider = resolveTransport(envelope.channel, meta);
  return provider.send(envelope.text, {
    target: envelope.to,
    thread: envelope.thread,
    attachments: envelope.attachments,
    from: envelope.from,
    dryRun: envelope.dryRun,
  });
}

/** Resolve + deliver in one step (CLI happy path). */
export async function sendMessage(
  input: ResolveSendInput,
  meta: Meta,
): Promise<{ result: SendResult; envelope: SendEnvelope } | { error: string }> {
  const resolved = resolveSendEnvelope(input, meta);
  if (!resolved.ok) return { error: resolved.error };
  const result = await deliverEnvelope(resolved.envelope, meta);
  return { result, envelope: resolved.envelope };
}
