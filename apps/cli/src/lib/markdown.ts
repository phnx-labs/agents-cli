/**
 * Terminal-aware Markdown rendering using marked and marked-terminal.
 *
 * Provides a single function for converting Markdown content into
 * ANSI-formatted text suitable for terminal output.
 */
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// @ts-expect-error - marked-terminal types don't match marked's MarkedExtension
marked.use(markedTerminal());

/**
 * Render markdown content for terminal display.
 */
export function renderMarkdown(content: string): string {
  return marked.parse(content) as string;
}
