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
 */
import { spawnSync } from 'child_process';

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
   * post text can never become shell syntax.
   */
  command: string[];
  /** Lowest post level that reaches this sink. Defaults to `milestone` (all posts). */
  minLevel?: FeedPostLevel;
}

/** `feed.broadcast` in agents.yaml — sink name → what to run. */
export type FeedBroadcastConfig = Record<string, FeedSinkConfig>;

/** Everything a template may interpolate. Absent values skip templates that need them. */
export interface FeedBroadcastContext {
  /** The post text, verbatim. */
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
  extras: { project?: string; agent?: string } = {},
): FeedBroadcastContext {
  const ask = block.questions?.[0]?.text?.trim() || 'agent is blocked';
  const links = [block.pr].filter((l): l is string => !!l && /^https?:\/\//i.test(l));
  return {
    text: ask,
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

export interface PlannedSink {
  name: string;
  argv: string[];
}

export interface SinkOutcome {
  name: string;
  ok: boolean;
  /** stderr tail when the sink failed, for the warning line. */
  error?: string;
}

const PLACEHOLDER = /\{([a-z]+)\}/g;

/**
 * A human-facing one-liner for a messaging sink: what project, what happened,
 * and the link to go read more. Leading with the project is deliberate — a
 * message that opens with an agent name tells the reader nothing about which of
 * their projects just moved.
 */
export function composeBroadcastMessage(ctx: FeedBroadcastContext): string {
  const head = ctx.project ? `${ctx.project} · ${ctx.text}` : ctx.text;
  const link = ctx.links?.find((l) => /^https?:\/\//i.test(l));
  // A block's second line is the command that unblocks it. The operator reading
  // this on a phone should not have to go find the session — the one action they
  // must take travels with the ask. A status post has no such action, so it keeps
  // the link there instead.
  const tail = [ctx.focus, link].filter(Boolean);
  return tail.length ? `${head}\n${tail.join('\n')}` : head;
}

/** The values a template may reference, resolved once per post. */
function templateVars(ctx: FeedBroadcastContext): Record<string, string | undefined> {
  return {
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
 */
export function planFeedBroadcast(
  config: FeedBroadcastConfig | undefined,
  ctx: FeedBroadcastContext,
): PlannedSink[] {
  if (!config) return [];
  const planned: PlannedSink[] = [];
  for (const [name, sink] of Object.entries(config)) {
    if (!Array.isArray(sink?.command) || sink.command.length === 0) continue;
    const min = sink.minLevel ?? 'milestone';
    if (LEVEL_RANK[ctx.level] < LEVEL_RANK[min]) continue;
    const argv = renderSinkArgv(sink.command, ctx);
    if (!argv) continue;
    planned.push({ name, argv });
  }
  return planned;
}

/**
 * Run the planned sinks. Each is a direct spawn with a bounded lifetime; a sink
 * that fails or is not installed is reported, never thrown — the post is already
 * written and must not be undone by a mirror that could not be reached.
 */
export function runFeedBroadcast(planned: PlannedSink[], timeoutMs = 20_000): SinkOutcome[] {
  return planned.map(({ name, argv }) => {
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
  });
}
