/**
 * `agents feedback` — frictionless, in-CLI feedback. Opens a Discussion
 * pre-filled with version + OS + agent inventory; falls back to printing the
 * URL when no browser is available.
 */

import { spawnSync } from 'node:child_process';
import { arch, platform, release } from 'node:os';
import { createRequire } from 'node:module';
import type { Command } from 'commander';
import chalk from 'chalk';

const REPO = 'phnx-labs/agents-cli';
const DISCUSSION_BASE = `https://github.com/${REPO}/discussions/new`;
const ISSUE_BASE = `https://github.com/${REPO}/issues/new`;

type Kind = 'bug' | 'idea' | 'question';

function readCliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function openInBrowser(url: string): boolean {
  const openers: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['open', [url]]]
      : process.platform === 'win32'
        ? [['cmd', ['/c', 'start', '""', url]]]
        : [
            ['xdg-open', [url]],
            ['gnome-open', [url]]
          ];
  for (const [cmd, args] of openers) {
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    if (r.status === 0) return true;
  }
  return false;
}

function buildPrefill(kind: Kind, summary: string): { url: string; body: string } {
  const version = readCliVersion();
  const os = `${platform()} ${release()} (${arch()})`;
  const node = process.version;

  const body = [
    summary.trim() ? `${summary.trim()}\n` : '<!-- describe what you ran into / what you want -->\n',
    '---',
    '',
    '**Environment**',
    '',
    `- agents-cli: \`${version}\``,
    `- OS: \`${os}\``,
    `- Node: \`${node}\``,
    '',
    '<!-- For bugs: include the exact command you ran and the full output. -->',
    '<!-- For ideas: include a concrete use case. -->'
  ].join('\n');

  if (kind === 'bug') {
    const url = `${ISSUE_BASE}?template=bug_report.yml&title=${encodeURIComponent(summary || 'Bug: ')}`;
    return { url, body };
  }
  const category = kind === 'idea' ? 'ideas' : 'q-a';
  const url = `${DISCUSSION_BASE}?category=${category}&title=${encodeURIComponent(summary || '')}&body=${encodeURIComponent(body)}`;
  return { url, body };
}

export function registerFeedbackCommand(program: Command): void {
  program
    .command('feedback [summary...]')
    .description('Open a pre-filled feedback Discussion or bug report')
    .option('-b, --bug', 'File as a bug report (opens issue tracker)')
    .option('-i, --idea', 'File as a feature idea (Discussions → Ideas)')
    .option('-q, --question', 'Ask a question (Discussions → Q&A)')
    .option('--print', 'Print the URL instead of opening it')
    .action((summary: string[], opts: { bug?: boolean; idea?: boolean; question?: boolean; print?: boolean }) => {
      const kind: Kind = opts.bug ? 'bug' : opts.idea ? 'idea' : 'question';
      const summaryText = (summary ?? []).join(' ').trim();
      const { url } = buildPrefill(kind, summaryText);

      if (opts.print) {
        console.log(url);
        return;
      }

      const opened = openInBrowser(url);
      if (opened) {
        console.log(chalk.dim(`Opened ${kind} form in your browser:\n  ${url}`));
      } else {
        console.log(chalk.yellow('Could not auto-open a browser. Paste this URL:'));
        console.log(`  ${url}`);
      }
    });
}
