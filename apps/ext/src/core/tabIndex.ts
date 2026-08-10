// Resolve which editor-tab index a terminal occupies — pure, no VS Code import.
//
// The extension publishes each agent terminal's editor-tab position so the CLI
// can render "viewing in Codium tab N". VS Code's `vscode.window.tabGroups.all`
// is the source: a tab whose `input instanceof vscode.TabInputTerminal` and
// whose `label` matches the terminal name is that terminal's tab. Matching by
// exact label mirrors findTerminalNameByTabLabel (core/utils.ts). This module
// is the pure core so it can be unit-tested without an extension host.

/** A single editor tab, flattened from vscode.Tab for pure resolution. */
export interface TabView {
  /** The tab's display label (equals the terminal name for agent terminals). */
  label: string;
  /** True when the tab hosts a terminal (input instanceof TabInputTerminal). */
  isTerminal: boolean;
}

/**
 * Find the 1-based index of `terminalName`'s tab WITHIN ITS GROUP.
 *
 * Groups are scanned in order; within a group we return the position (1-based)
 * of the first terminal tab whose label matches the terminal name exactly. The
 * index is group-relative because that is the addressable "tab N" a user sees
 * inside an editor group — VS Code has no global tab number. When two terminal
 * tabs share a label in the same group (ambiguous), the first wins, which is
 * exactly "use the tab's index within its group".
 *
 * Returns undefined when no terminal tab matches (e.g. a panel terminal, which
 * is not an editor tab, or a name that isn't open as a tab).
 */
export function resolveTabIndex(groups: TabView[][], terminalName: string): number | undefined {
  if (!terminalName) return undefined;
  for (const tabs of groups) {
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      if (tab.isTerminal && tab.label === terminalName) return i + 1;
    }
  }
  return undefined;
}
