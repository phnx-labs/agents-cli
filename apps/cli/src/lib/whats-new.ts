import chalk from 'chalk';
import { compareVersions } from './agent-spec/primitives.js';

/**
 * Render a compact "What's new" summary from a CHANGELOG.md body: one bullet
 * per feature/fix heading for each version in the range the user actually
 * moved through, `(fromVersion, toVersion]`. Headings are recognized in both
 * changelog formats — the current `- **Title.** prose…` single-line bullets
 * and the older standalone `**Heading**` lines. The verbose prose/sub-bullets
 * are intentionally dropped — the full notes live in the changelog.
 *
 * Returns colored lines ready to print, empty when nothing is in range.
 */
export function renderWhatsNew(changelog: string, fromVersion: string, toVersion: string): string[] {
  const out: string[] = [];
  let inRelevantSection = false;
  // Whether the CURRENT version section uses the old standalone-heading format.
  // Old sections nest `-` sub-bullets under each `**Heading**` line, and some
  // sub-bullets are themselves bold-led (`- **Claim.** detail…`) — once a
  // standalone heading is seen, `- **` lines in that section are sub-bullets,
  // not entries, and must not render.
  let sectionUsesStandaloneHeadings = false;

  for (const line of changelog.split('\n')) {
    const versionMatch = line.match(/^## (\d+\.\d+\.\d+)/);
    if (versionMatch) {
      const currentVersion = versionMatch[1];
      // Bounding the top end matters when upgrading to a specific older
      // version, and guards against a changelog that lists unreleased entries.
      inRelevantSection =
        compareVersions(currentVersion, fromVersion) > 0 &&
        compareVersions(currentVersion, toVersion) <= 0;
      sectionUsesStandaloneHeadings = false;
      if (inRelevantSection) {
        out.push('');
        out.push(chalk.bold(`v${currentVersion}`));
      }
      continue;
    }

    // Only the entry headings — one bullet per feature/fix. Two formats exist
    // across the changelog's history: the current single-line bullets
    // (`- **Title.** verbose prose…`, heading kept, prose dropped) and the
    // older standalone `**Heading**` lines with `-` sub-bullets beneath.
    if (!inRelevantSection) continue;
    if (line.startsWith('**') && line.endsWith('**')) {
      sectionUsesStandaloneHeadings = true;
      out.push(`  ${chalk.cyan('•')} ${line.replace(/\*\*/g, '')}`);
      continue;
    }
    const entryBullet = sectionUsesStandaloneHeadings ? null : line.match(/^- \*\*(.+?)\*\*/);
    if (entryBullet) {
      out.push(`  ${chalk.cyan('•')} ${entryBullet[1].replace(/\*\*/g, '')}`);
    }
  }

  return out;
}
