/**
 * Fan an `agents feed post` out to the systems the operator actually watches.
 *
 * A post is already durable — it lands in the append-only activity log and shows
 * up in `agents feed --filter updates`. But an operator who is away from every
 * terminal never sees it, and the tracker that owns the work (a Linear ticket,
 * a GitHub issue) hears nothing at all. So a post can also be mirrored outward.
 *
 * Sinks are **argv templates from config**, never hardcoded integrations. This
 * CLI ships Apache-2.0 and must not depend on one person's tracker or messaging
 * stack; declaring `[linear, update, "{ticket}", --comment, "{text}"]` in
 * `agents.yaml` keeps the coupling in the operator's config where it belongs,
 * and lets someone else point the same mechanism at `jira`, `gh issue comment`,
 * or a webhook script.
 *
 * Two rules decide whether a sink runs, both derived from the post itself:
 *
 *   - **Level.** `minLevel: important` keeps a sink for the posts worth
 *     interrupting someone over, so a routine "CI green" does not buzz a phone.
 *   - **Placeholders.** A template that references `{ticket}` is skipped when no
 *     ticket is known. The template declares what it needs; nothing has to
 *     restate it as a flag, and a sink can never fire with a hole in its argv.
 *
 * Delivery is best-effort and reported: a sink that fails prints a warning and
 * the post still stands. Losing a mirror must never cost the operator the post.
 *
 * A second sink shape (RUSH-2123) delivers **in-process** through the same
 * channel-provider registry `agents send` uses (`channel:` instead of
 * `command:`) — no spawn, no argv templating. `channel: owner` is the address
 * alias that expands to `notify.owner.{channel,to}`, matching `agents notify`.
 * When the operator has never written a `feed.broadcast` block at all, an
 * important-level post falls back to that owner address implicitly
 * ({@link effectiveBroadcastConfig}) rather than reaching nobody — see that
 * function's doc for why this was a silent failure before.
 */
import { spawnSync } from 'child_process';
import type { Meta } from './types.js';
import { isOwnerAlias, readOwnerDest, resolveSendEnvelope, deliverEnvelope } from './channels/send.js';
import { lookupTransport } from './channels/resolve.js';

/** How loudly a post asks to be heard. Ordered — `important` implies milestone. */
export type FeedPostLevel = 'milestone' | 'important';

const LEVEL_RANK: Record<FeedPostLevel, number> = { milestone: 0, important: 1 };

/** Parse a `--level` value; anything unrecognized is a usage error, not a default. */
export function parseFeedPostLevel(raw: string | undefined): FeedPostLevel {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v || v === 'milestone') return 'milestone';
  if (v === 'important') return 'important';
  throw new Error(`Unknown --level '${raw}'. Use milestone or important.`);
}

export interface FeedSinkConfig {
  /**
   * argv to run, with `{placeholder}` tokens substituted. First element is the
   * program; it is spawned directly (no shell), so quoting is not a concern and
   * post text can never become shell syntax. Mutually exclusive with `channel`
   * — a sink is one shape or the other.
   */
  command?: string[];
  /**
   * In-process delivery through the same channel-provider registry `agents
   * send`/`agents notify` use — the composed `{message}` body, no argv, no
   * spawn. `'owner'` is the address alias (expands to `notify.owner.{channel,to}`
   * in agents.yaml, same as `agents notify`); any other value is a registered
   * channel name (or a `notify.transports` mapping) and requires `to`.
   */
  channel?: string;
  /** Recipient for a `channel` sink. Required unless `channel` is the `owner` alias. */
  to?: string;
  /** Lowest post level that reaches this sink. Defaults to `milestone` (all posts). */
  minLevel?: FeedPostLevel;
}

/** `feed.broadcast` in agents.yaml — sink name → what to run. */
export type FeedBroadcastConfig = Record<string, FeedSinkConfig>;

/** Everything a template may interpolate. Absent values skip templates that need them. */
export interface FeedBroadcastContext {
  /** Short subject line (~4–5 words). Phone line 1. */
  title?: string;
  /** The post body, verbatim. Phone line after the blank line. */
  text: string;
  level: FeedPostLevel;
  /** Tracker id for the work, e.g. `RUSH-2081`. */
  ticket?: string;
  /** Repo/project the post came from. */
  project?: string;
  agent?: string;
  host?: string;
  session?: string;
  /** URLs attached to the post — the PR, the ticket, a shared plan. */
  links?: string[];
  /** Block-only: the block's stable id. Absent on a status post. */
  blockId?: string;
  /** Block-only: `approval` (has a safe default) or `decision` (needs a human). */
  class?: string;
  /** Block-only: cost-of-delay tag used by the urgency filter. */
  cost?: string;
  /** Block-only: the literal `agents focus <id>` command that unblocks it. */
  focus?: string;
}

/**
 * Map an open block onto the broadcast context, so a block reaches the same sinks
 * a post does instead of dying in the ledger.
 *
 * The `text` is the ask itself, front-loaded — a notification banner shows roughly
 * two lines, and a phone message is scanned, not read. `focus` carries the literal
 * command that unblocks it, so the message the operator receives contains the one
 * action they have to take rather than making them go find the session.
 *
 * Level is always `important`: a block is by definition an agent that has stopped
 * making progress, so there is no per-block level flag to get wrong.
 */
export function blockBroadcastContext(
  block: {
    blockId: string;
    sessionId: string;
    host?: string;
    questions?: Array<{ text?: string }>;
    blockClass?: string;
    costOfDelay?: string;
    ticket?: string;
    pr?: string;
  },
  extras: { project?: string; agent?: string; title?: string; body?: string } = {},
): FeedBroadcastContext {
  const ask = block.questions?.[0]?.text?.trim() || 'agent is blocked';
  const links = [block.pr].filter((l): l is string => !!l && /^https?:\/\//i.test(l));
  // Prefer explicit title/body from the feed post; fall back to the ask as body.
  const title = extras.title?.trim() || undefined;
  const text = extras.body?.trim() || ask;
  return {
    ...(title ? { title } : {}),
    text,
    level: 'important',
    ticket: block.ticket,
    project: extras.project,
    agent: extras.agent,
    host: block.host,
    session: block.sessionId,
    blockId: block.blockId,
    class: block.blockClass,
    cost: block.costOfDelay,
    // Short id: `agents focus` matches on a prefix, and a full uuid in a phone
    // message is noise the operator has to skip past to reach the verb.
    focus: `agents focus ${block.sessionId.slice(0, 8)}`,
    ...(links.length ? { links } : {}),
  };
}

/**
 * Why a declared block reached nobody, or undefined when it got through.
 *
 * Pure so the fail-loud contract is testable without driving the CLI — the
 * original version lived inline in the command action and was consequently
 * never covered, which is how a `--json` early-return quietly bypassed it.
 *
 * Only a TOTAL failure counts. One sink failing among several is a warning, not
 * an error: the channels are redundant by design, and a dead `rush` login must
 * not mask a delivered desktop notification.
 */
export function blockDeliveryFailure(
  blocked: boolean,
  outcomes: SinkOutcome[],
): string | undefined {
  if (!blocked) return undefined;
  if (outcomes.length === 0) {
    return 'Block recorded but NOT delivered — no feed.broadcast sink configured.';
  }
  if (outcomes.every((o) => !o.ok)) {
    const why = outcomes.map((o) => `${o.name}: ${o.error ?? 'failed'}`).join('; ');
    return `Block recorded but NOT delivered — every feed.broadcast sink failed (${why}).`;
  }
  return undefined;
}

export interface PlannedSink {
  name: string;
  /** Command sink: argv to spawn (mutually exclusive with `channel`). */
  argv?: string[];
  /** Channel sink: provider channel name, or the `owner` alias. */
  channel?: string;
  /** Channel sink recipient. Unset for the `owner` alias — resolved at delivery. */
  to?: string;
  /** Channel sink body — the composed `{message}` for this post. */
  text?: string;
}

export interface SinkOutcome {
  name: string;
  ok: boolean;
  /** stderr tail when the sink failed, for the warning line. */
  error?: string;
}

const PLACEHOLDER = /\{([a-z]+)\}/g;

/**
 * Short host label for a phone line — strip user@ and domain so
 * `muqsit@mac-mini.tailnet.ts.net` reads as `mac-mini`.
 */
export function shortHost(host: string | undefined): string | undefined {
  if (!host?.trim()) return undefined;
  let h = host.trim();
  const at = h.lastIndexOf('@');
  if (at !== -1) h = h.slice(at + 1);
  const dot = h.indexOf('.');
  if (dot > 0) h = h.slice(0, dot);
  return h || undefined;
}

/** First 8 hex chars of a session id for the footer (readable, not a full uuid). */
export function shortSessionChunk(session: string | undefined): string | undefined {
  if (!session?.trim()) return undefined;
  const hex = session.replace(/-/g, '').toLowerCase();
  const chunk = hex.replace(/[^a-f0-9]/g, '').slice(0, 8);
  return chunk || undefined;
}

/**
 * Scrub em/en dashes from outbound phone copy (house rule + iMessage readability).
 * Collapses whitespace; does not invent meaning.
 */
export function scrubOutboundDashes(text: string): string {
  return text
    .replace(/\u2014/g, ' - ')
    .replace(/\u2013/g, ' - ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Footer like "Sent from my iPhone" — who posted, a session crumb, which box.
 *
 *   Sent from grok/a02da0e2 on mac-mini
 *
 * Agent name first; session chunk for disambiguation when many groks run;
 * host last. Skip the uninformative default label `agent`.
 */
export function composeBroadcastFooter(ctx: FeedBroadcastContext): string | undefined {
  const agent = ctx.agent?.trim();
  const agentLabel = agent && agent !== 'agent' ? agent : undefined;
  const session = shortSessionChunk(ctx.session);
  const host = shortHost(ctx.host);

  let who: string | undefined;
  if (agentLabel && session) who = `${agentLabel}/${session}`;
  else if (agentLabel) who = agentLabel;
  else if (session) who = session;

  if (who && host) return `Sent from ${who} on ${host}`;
  if (who) return `Sent from ${who}`;
  if (host) return `Sent from host ${host}`;
  return undefined;
}

/**
 * Human-facing body for a messaging sink (`{message}`).
 *
 * ```
 * Title in a few words
 *
 * Body of what happened or the ask.
 *
 * Sent from grok/a02da0e2 on mac-mini
 * agents focus a02da0e2          (blocks only)
 * https://…                      (optional attach URL)
 * ```
 *
 * Title first (scannable subject). Blank line. Body. Footer provenance so a
 * fleet of agents is attributable without crowding the ask. Prefer `{message}`
 * over bare `{text}` in messaging sinks.
 */
export function composeBroadcastMessage(ctx: FeedBroadcastContext): string {
  const title = scrubOutboundDashes(ctx.title ?? '');
  const body = scrubOutboundDashes(ctx.text ?? '');
  // Title preferred; if an older post has no title, body alone still sends.
  const head = title || body;
  const mid = title && body && title !== body ? body : undefined;
  const footer = composeBroadcastFooter(ctx);
  const link = ctx.links?.find((l) => /^https?:\/\//i.test(l));
  // Block focus and link trail after the "Sent from" footer so the human
  // sentence stays at the top and the action/link are still one glance away.
  const trail = [footer, ctx.focus, link].filter(Boolean) as string[];

  const parts: string[] = [];
  if (head) parts.push(head);
  if (mid) {
    // Blank line between subject and body (title, then space, then message).
    parts.push('');
    parts.push(mid);
  }
  if (trail.length) {
    // Blank line before the footer block (iPhone "Sent from my iPhone" spacing).
    if (parts.length) parts.push('');
    parts.push(trail.join('\n'));
  }
  return parts.join('\n').trim();
}

/** The values a template may reference, resolved once per post. */
function templateVars(ctx: FeedBroadcastContext): Record<string, string | undefined> {
  return {
    title: ctx.title,
    text: ctx.text,
    ticket: ctx.ticket,
    project: ctx.project,
    agent: ctx.agent,
    host: ctx.host,
    session: ctx.session,
    level: ctx.level,
    links: ctx.links?.length ? ctx.links.join(' ') : undefined,
    message: composeBroadcastMessage(ctx),
    block: ctx.blockId,
    class: ctx.class,
    cost: ctx.cost,
    focus: ctx.focus,
  };
}

/**
 * Substitute `{placeholder}` tokens in an argv template. Returns undefined when
 * the template needs a value this post does not have — the sink is then skipped
 * rather than run with an empty argument, which is how a `linear update --comment`
 * would otherwise comment on nothing.
 */
export function renderSinkArgv(
  template: string[],
  ctx: FeedBroadcastContext,
): string[] | undefined {
  const vars = templateVars(ctx);
  const argv: string[] = [];
  for (const token of template) {
    let missing = false;
    const rendered = token.replace(PLACEHOLDER, (whole, key: string) => {
      const value = vars[key];
      if (value === undefined || value === '') {
        missing = true;
        return whole;
      }
      return value;
    });
    if (missing) return undefined;
    argv.push(rendered);
  }
  return argv.length > 0 ? argv : undefined;
}

/**
 * Which sinks this post reaches, in config order. Pure — the dry-run listing and
 * the real fan-out plan through here, so what `--dry-run` shows is what runs.
 *
 * A `channel:` sink is gated by the same `minLevel` rule as a `command:` sink —
 * one level check for both shapes, so a dry-run plan is truthful regardless of
 * which shape an operator's sink uses.
 */
export function planFeedBroadcast(
  config: FeedBroadcastConfig | undefined,
  ctx: FeedBroadcastContext,
): PlannedSink[] {
  if (!config) return [];
  const planned: PlannedSink[] = [];
  for (const [name, sink] of Object.entries(config)) {
    if (!sink) continue;
    const min = sink.minLevel ?? 'milestone';
    if (LEVEL_RANK[ctx.level] < LEVEL_RANK[min]) continue;

    const channel = sink.channel?.trim();
    if (channel) {
      // The owner alias resolves its recipient from notify.owner at delivery
      // time; any other channel name needs an explicit recipient now, or the
      // sink can never fire with a hole in it (same contract as a missing argv
      // placeholder below).
      if (!isOwnerAlias(channel) && !sink.to?.trim()) continue;
      planned.push({
        name,
        channel,
        to: isOwnerAlias(channel) ? undefined : sink.to!.trim(),
        text: composeBroadcastMessage(ctx),
      });
      continue;
    }

    if (!Array.isArray(sink.command) || sink.command.length === 0) continue;
    const argv = renderSinkArgv(sink.command, ctx);
    if (!argv) continue;
    planned.push({ name, argv });
  }
  return planned;
}

/**
 * The effective sink config for a post: the operator's `feed.broadcast`, or —
 * when that is unset or empty — an implicit fallback straight to
 * `notify.owner`, for a post worth interrupting someone over.
 *
 * Before this, `broadcastPostedEvent`/`broadcastBlock` returned early the
 * moment `feed.broadcast` was empty, even when `notify.owner` was fully
 * configured — so the common case (an operator who set up owner notifications
 * but never wrote a `feed.broadcast` block) produced a `--blocked` post that
 * looked recorded and reached nobody. `agents notify` already treats
 * `notify.owner` as the default human destination; this makes an important
 * feed post/block use that same default instead of requiring a second,
 * redundant config block that says the same thing.
 *
 * The fallback only fires for `important` — a routine `milestone` post stays
 * record-only, matching the `minLevel` contract every declared sink already
 * follows. An operator-declared `feed.broadcast` (any non-empty config)
 * always wins outright; the fallback never layers on top of it.
 */
export function effectiveBroadcastConfig(
  config: FeedBroadcastConfig | undefined,
  level: FeedPostLevel,
  meta: Meta,
): FeedBroadcastConfig | undefined {
  if (config && Object.keys(config).length > 0) return config;
  if (level !== 'important') return undefined;
  if (!readOwnerDest(meta)) return undefined;
  return { owner: { channel: 'owner' } };
}

function runCommandSink(name: string, argv: string[], timeoutMs: number): SinkOutcome {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    return { name, ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    const tail = (result.stderr || result.stdout || '').trim().split('\n').slice(-1)[0];
    return { name, ok: false, error: tail || `exited ${result.status}` };
  }
  return { name, ok: true };
}

/**
 * Deliver one `channel:` sink through the real provider registry —
 * `resolveSendEnvelope` reuses `agents notify`'s owner-alias expansion, and
 * `deliverEnvelope` is the same seam `agents send` calls. A bad channel name
 * is checked with `lookupTransport` (the non-throwing lookup) BEFORE handing
 * off to `deliverEnvelope`: that function's own resolution `die()`s on an
 * unregistered provider, which is the right answer for an interactive `agents
 * send` typo but would take the whole broadcast fan-out down with it here —
 * one misconfigured sink must report a failure, not kill the process running
 * every other sink.
 */
async function runChannelSink(sink: PlannedSink, meta: Meta): Promise<SinkOutcome> {
  const name = sink.name;
  const owner = isOwnerAlias(sink.channel);
  const resolved = resolveSendEnvelope(
    {
      text: sink.text ?? '',
      channel: owner ? undefined : sink.channel,
      to: owner ? 'owner' : sink.to,
      ownerMode: owner,
    },
    meta,
  );
  if (!resolved.ok) return { name, ok: false, error: resolved.error };

  const { provider, error } = lookupTransport(resolved.envelope.channel, meta);
  if (!provider) return { name, ok: false, error };

  const result = await deliverEnvelope(resolved.envelope, meta);
  return result.ok ? { name, ok: true } : { name, ok: false, error: result.error };
}

/**
 * Run the planned sinks. A `command:` sink is a direct spawn with a bounded
 * lifetime; a `channel:` sink delivers in-process. Either way a sink that
 * fails or is not installed/registered is reported, never thrown — the post
 * is already written and must not be undone by a mirror that could not be
 * reached.
 */
export async function runFeedBroadcast(
  planned: PlannedSink[],
  meta: Meta,
  timeoutMs = 20_000,
): Promise<SinkOutcome[]> {
  const outcomes: SinkOutcome[] = [];
  for (const sink of planned) {
    if (sink.channel) {
      outcomes.push(await runChannelSink(sink, meta));
    } else {
      outcomes.push(runCommandSink(sink.name, sink.argv ?? [], timeoutMs));
    }
  }
  return outcomes;
}
