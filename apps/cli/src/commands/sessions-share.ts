/**
 * `agents sessions share <id>` — publish one session transcript as a link.
 *
 * Composes three pieces that already existed but were never wired together:
 * `renderSessionMarkdownDocument()` (redacted transcript),
 * `renderSessionHtmlDocument()` (self-contained branded page), and
 * `publishFile()` (the R2-backed share Worker). Before this, sharing a session
 * meant three commands and a detour through the external artifacts-cli.
 *
 * Unlisted by default, unlike `agents artifacts share`. A transcript carries file
 * paths, command output, error text, and whatever a tool printed — strictly more
 * than a plan does — so it does not belong in the public `/<user>` gallery unless
 * the operator asks for it with `--public`. The URL itself stays world-readable:
 * unlisted is a capability URL, not a secret.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { knownSecretValuesFromEnv } from '../lib/redact.js';
import { discoverSessions } from '../lib/session/discover.js';
import { renderSessionHtmlDocument } from '../lib/session/share-html.js';
import type { SessionMeta } from '../lib/session/types.js';
import { publishFile } from '../lib/share/publish.js';
import { renderSessionMarkdownDocument, type ReasoningMode } from './sessions-render.js';
import { selectSessions } from './sessions-export.js';
import { parseAgentFilter } from './sessions.js';

interface ShareGlobals {
  all?: boolean;
  since?: string;
  limit?: string;
  agent?: string;
  redact?: boolean;
  json?: boolean;
}

interface ShareOptions {
  public?: boolean;
  slug?: string;
  label?: string;
  expire?: string;
  reasoning: string;
  force?: boolean;
  cover?: boolean;
}

function parseReasoning(value: string): ReasoningMode {
  if (value === 'omit' || value === 'fold' || value === 'include') return value;
  throw new Error(`Unknown reasoning mode "${value}". Expected omit, fold, or include.`);
}

/** `session-<shortId>` — stable per session, so re-sharing updates the same URL. */
export function defaultSessionSlug(session: SessionMeta): string {
  return `session-${session.shortId || session.id}`;
}

export function registerSessionsShareCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('share <session>')
    .description('Publish one session as a redacted, self-contained web page and print the link.')
    .option('--public', 'List the page in your public share gallery (default: unlisted capability URL)')
    .option('--slug <slug>', 'URL slug under your namespace (default: session-<shortId>)')
    .option('--label <text>', 'Display title in the gallery and `agents artifacts share list`')
    .option('--expire <spec>', 'Auto-expire window: 30d, 12h, a date, or never (default: 30d)')
    .option('--reasoning <mode>', 'Reasoning visibility: omit, fold, or include', 'omit')
    .option('--force', 'Publish despite the sensitive-content scan flagging the transcript')
    .option('--no-cover', 'Skip generating the Open Graph preview image');

  setHelpSections(cmd, {
    examples: `# Share a session — prints an unlisted, redacted link
agents sessions share a1b2c3d4

# Put it in your public gallery at share.agents-cli.sh/<you>
agents sessions share a1b2c3d4 --public --label "How the retry bug got fixed"

# Keep the model's reasoning in collapsible sections
agents sessions share a1b2c3d4 --reasoning fold

# A link that does not decay
agents sessions share a1b2c3d4 --expire never`,
    notes: `Requires a share endpoint: 'agents artifacts share status' shows it, 'agents artifacts setup'
provisions one, 'agents artifacts share join <baseUrl>' uses an existing one.

Unlisted by default — the URL is world-readable but the page stays out of your public
gallery and out of 'agents artifacts share list'. Pass --public to list it.

Secrets are redacted and the same pre-publish scan as 'agents artifacts share' runs on the
page, so a transcript carrying emails or credential-shaped strings is refused
unless you pass --force. --no-redact (the sessions-level flag) disables redaction
and is a bad idea for anything you publish.

Re-running with the same session updates the same URL and keeps the prior version
as a revision ('agents artifacts share revisions <slug>').

Manage published sessions with 'agents artifacts share list' and
'agents artifacts share delete <slug>'.`,
  });

  cmd.action(async (selector: string, options: ShareOptions, command: Command) => {
    const globals = command.optsWithGlobals() as ShareGlobals;
    const reasoning = parseReasoning(options.reasoning);
    const limit = Math.max(1, Number.parseInt(globals.limit || '100', 10) || 100);
    const agent = parseAgentFilter(globals.agent).agent;
    const sessions = selectSessions(await discoverSessions({
      all: globals.all !== false,
      since: globals.since,
      limit,
      agent: agent ?? undefined,
    }), [selector]);

    if (sessions.length === 0) {
      process.stderr.write(chalk.yellow(`No session matched "${selector}".\n`));
      process.exitCode = 1;
      return;
    }
    // One link per share: several sessions in one page would give the reader no
    // way to reference just the one that matters, and the slug could only name one.
    if (sessions.length > 1) {
      process.stderr.write(chalk.yellow(
        `"${selector}" matched ${sessions.length} sessions. Share one at a time — pass a full or unique session id.\n`,
      ));
      process.exitCode = 1;
      return;
    }

    const session = sessions[0];
    const redact = globals.redact !== false;
    const markdown = renderSessionMarkdownDocument(session, {
      redact,
      reasoning,
      knownSecrets: redact ? knownSecretValuesFromEnv() : undefined,
    });
    const html = renderSessionHtmlDocument(session, markdown, { redacted: redact });

    // A real file on disk is what publishFile() takes, and the OG capturer opens
    // it in a browser. 0600 + a per-run directory keeps the intermediate off a
    // world-readable /tmp path while it exists.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-session-share-'));
    const file = path.join(dir, `${defaultSessionSlug(session)}.html`);
    try {
      fs.writeFileSync(file, html, { mode: 0o600 });
      const result = await publishFile(file, {
        slug: options.slug ?? defaultSessionSlug(session),
        unlisted: options.public !== true,
        expire: options.expire,
        force: options.force === true,
        cover: options.cover !== false,
        label: options.label,
        meta: { kind: 'session' },
      });

      if (globals.json) {
        process.stdout.write(JSON.stringify({
          session: session.id,
          agent: session.agent,
          redacted: redact,
          ...result,
        }, null, 2) + '\n');
        return;
      }
      process.stdout.write(`${result.url}\n`);
      const bits = [result.unlisted ? 'unlisted' : 'public', redact ? 'redacted' : chalk.red('NOT redacted')];
      if (result.expiresAt) bits.push(`expires ${result.expiresAt.slice(0, 10)}`);
      process.stderr.write(chalk.dim(`${bits.join(' · ')}\n`));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
