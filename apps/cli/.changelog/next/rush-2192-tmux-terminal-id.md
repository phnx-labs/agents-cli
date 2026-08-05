- **`agents sessions --active` now carries `terminalId` on tmux-hosted rows (RUSH-2192).**
  Grok/Codex (and every `ag-*` tmux pane) get their `AGENT_TERMINAL_ID` from the launch
  registry's by-pid entry. The ps-scan path already set `terminalId`; the tmux source —
  which wins dedupe for interactive agents — omitted it, so Factory could never join a
  tab to its live session even when SessionStart preserved the key. Source:
  `apps/cli/src/lib/session/active.ts`.
