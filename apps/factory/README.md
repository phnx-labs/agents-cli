# Agents

Orchestrate Claude, Codex, Gemini, and Cursor in parallel — from one IDE. Open source. Free.

Turn your editor into a command center for orchestrating Claude, Codex, Gemini, and Cursor in parallel. Each agent runs as a full-screen editor tab. Each agent can spawn sub-agents. You orchestrate — approving plans, monitoring execution, shipping faster.

## Why an IAE?

Text editors became IDEs when coding got complex. Now that AI agents do the coding, your environment needs to evolve again. When you're running 10+ orchestrators each spinning 10+ agents, terminals and TUIs collapse. You need an environment built for that scale.

This extension turns your IDE into an IAE:

- **Full-screen terminals** - Agents run as editor tabs, not buried panels. See your code and agent side-by-side.
- **Session persistence** - Close VS Code, reopen it, your agent tabs come back exactly where you left off.
- **Approval gates** - You approve plans before agents execute. Control without bottleneck.
- **Keyboard-first** - 12+ shortcuts for spawning, switching, labeling, and reviewing agents. No mouse needed.

## Workflow: Task, Plan, Approve

1. **Task** - Describe what you need with `/swarm` inside the IDE.
2. **Plan** - The orchestrator drafts a distribution: who codes, who debugs, who researches.
3. **Approve** - You gate execution. Agents run only after your approval.

## Quick Start

1. Install the extension from VS Code Marketplace
2. Press `Cmd+Shift+A` to spawn your first agent
3. Open Dashboard (`Cmd+Shift+D`) to configure auto-start

## Navigation

| Shortcut | Action |
| --- | --- |
| `Cmd+Shift+A` | Spawn new agent |
| `Cmd+Shift+L` | Label agent by task |
| `Cmd+Shift+C` | Clear and restart agent |
| `Cmd+Shift+D` | Open Dashboard |
| `Cmd+Shift+I` | Focus agent (quick picker) |
| `Cmd+Shift+H` | Horizontal split (tmux-style) |
| `Cmd+Shift+V` | Vertical split (tmux-style) |

## Features

### Agent Terminals

Spawn any agent as a full-screen editor tab. Built-in support for Claude Code, Codex, Gemini, OpenCode, and Cursor. Add custom agents through settings.

### Session Persistence

Every open agent terminal is fully restorable. Session ID, icon, and custom labels are saved to disk in real-time. VS Code crashes? Restart? All your agent tabs come back exactly as they were.

### Task Management

- **Labels** - Tag agents by task (`Cmd+Shift+L`). Status bar shows active agent and label.
- **TODO.md parsing** - Discovers TODO.md files in your workspace. Spawn agents directly from task items.
- **Session history** - Browse recent sessions from the dashboard. Resume any previous conversation.

### Factory Floor

The dashboard's mission control. A live grid of every agent on the floor — local IDE tabs, background teams, and cloud dispatches — beside your Linear cycle. Compose and dispatch work with the Cmd+K composer, drag issue cards onto agents, or send a ticket straight to the cloud.

Agent cards surface outputs such as PRs, spawned teams, created tickets, and plan
artifacts. `.html` and `ref-*.md` plans detected in session output, worktree
files, or attachments appear as one-click preview chips.

### Foreman Voice Orb

Talk to your factory. Tap the orb in the dashboard and ask "what's running?", "what's left this cycle?", or "dispatch RUSH-557 to the cloud" — a realtime voice model answers out loud with live floor state, and it can dispatch tickets, spawn agents, and file Linear issues for you. Tap to talk, tap again to stop, or press-and-hold to talk only while pressed. A silent-mode toggle under the orb switches replies to text-only transcript.

### AI Git Commits

Generate commit messages from staged changes with `Cmd+Shift+G`. Learns from your commit style, then stages, commits, and pushes in one action.

### Additional Features

- **Auto-start** - Configure which agents launch when VS Code opens
- **Default models** - Set preferred model per agent type
- **Shell terminals** - Spawn plain shells alongside agents (`Cmd+Shift+S`)
- **Markdown editor** - Custom `.md` editor with image paste support
- **Notifications** - Native macOS notifications when agents need attention

## For Teams

- Shared dashboard keeps approvals and assignments visible.
- Consistent agent distribution prevents over- or under-staffing tasks.
- Approval gates make it easy for leads to review before code runs.

## Requirements

- VS Code or Cursor
- Agent CLIs installed (`claude`, `codex`, `gemini`, `cursor-agent`, `opencode`)
- OpenAI API key (optional, for commit generation and the Foreman voice orb)
- ffmpeg (optional, for the Foreman voice orb: `brew install ffmpeg`)

## Related Packages

- [@swarmify/agents-cli](https://www.npmjs.com/package/@swarmify/agents-cli) - Moved to its own repository

## License

MIT
