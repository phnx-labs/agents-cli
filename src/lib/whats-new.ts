import chalk from 'chalk';
import { compareVersions } from './agent-spec/primitives.js';

/**
 * Render a compact "What's new" summary from a CHANGELOG.md body: one bullet
 * per feature/fix heading (the `**...**` lines) for each version in the range
 * the user actually moved through, `(fromVersion, toVersion]`. The verbose
 * sub-bullets are intentionally dropped — the full notes live in the changelog.
 *
 * Returns colored lines ready to print, empty when nothing is in range.
 */
export function renderWhatsNew(changelog: string, fromVersion: string, toVersion: string): string[] {
  const out: string[] = [];
  let inRelevantSection = false;

  for (const line of changelog.split('\n')) {
    const versionMatch = line.match(/^## (\d+\.\d+\.\d+)/);
    if (versionMatch) {
      const currentVersion = versionMatch[1];
      // Bounding the top end matters when upgrading to a specific older
      // version, and guards against a changelog that lists unreleased entries.
      inRelevantSection =
        compareVersions(currentVersion, fromVersion) > 0 &&
        compareVersions(currentVersion, toVersion) <= 0;
      if (inRelevantSection) {
        out.push('');
        out.push(chalk.bold(`v${currentVersion}`));
      }
      continue;
    }

    // Only the bold headings — one bullet per feature/fix.
    if (inRelevantSection && line.startsWith('**') && line.endsWith('**')) {
      out.push(`  ${chalk.cyan('•')} ${line.replace(/\*\*/g, '')}`);
    }
  }

  return out;
}
