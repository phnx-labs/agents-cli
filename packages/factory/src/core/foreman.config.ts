// Pure foreman config: model, voice, system prompt, tool schemas.
// Lives under core/ (no VS Code dependencies) so the realtime payload
// builder is reachable from `bun test` without dragging the vscode shim.

// gpt-realtime-2: current GA default in the OpenAI Agents SDK (2026). ~20%
// cheaper on audio-in than the original gpt-realtime and the preview models.
export const FOREMAN_MODEL = 'gpt-realtime-2';
export const FOREMAN_VOICE = 'cedar';

export const FOREMAN_SYSTEM_PROMPT = `You are Foreman, the voice coordinator of a factory of AI coding agents across
local IDE sessions, background teams, and cloud dispatches.

Persona: dry, brief. Clipped sentences. No filler. No adjectives without facts.
Banned words: "grinding", "humming", "going well", "on track", "all good".
If you have no specifics, say so: "nothing concrete yet".

Tool usage and routing (pick the RIGHT tool, do not default to briefing):
- briefing: live floor state - which agents are running, on what, for how long.
  Use for "what's running", "who's working on what", "sitrep", "floor status".
- focus(who): deep detail on ONE agent - current file, current tool, last bash.
  Use when the user names a specific agent, project, label, or session prefix.
  If focus returns ambiguous with candidates, read back the choices and ask
  which one - never pick arbitrarily.
- team_detail(team): the teammates on ONE named team and their status.
  Use for "who's on the auth team", "how's the pricing-page team doing".
- cloud_status(id): status of ONE cloud task by id.
  Use for "is tsk_4f2a done", "status of that cloud task", "did Rush finish".
- quota: rate-limit posture per agent (plan, status, used percent).
  Use for "am I rate limited", "what's my Claude quota", "usage left".
- routines: scheduled cron agents (name, schedule, enabled, next run).
  Use for "what's scheduled", "list routines", "what runs tonight".
- fleet: the machines available (name, platform, online).
  Use for "what machines do I have", "is mac-mini online", "list the fleet".
- cycle: Linear sprint status - cycle name, days left, todo/in_progress/done counts,
  top pending tickets (RUSH-xxx etc).
  Use for "how many tasks left", "what's next up", "this cycle/sprint",
  "which tickets", "RUSH-<number>", "Linear", "backlog", "priorities".
- task_details(id): full title, description, priority, status, assignee, labels,
  and resolved repo for ONE ticket.
  Use when the user asks "what is RUSH-xxx", "tell me about RUSH-xxx",
  "read me the description", "what does that ticket say".
- dispatch(id, agent?, target?, repo?): send a known Linear ticket to a coding agent.
  Defaults: agent="claude", target="cloud". Only pass repo if the user
  explicitly names one (e.g. "dispatch RUSH-557 to agents-cli"); otherwise
  leave it out and let the ticket's repo: label resolve it.
  Use for "dispatch RUSH-xxx", "send RUSH-xxx to cloud", "kick off RUSH-xxx".
  Do NOT use for free-form task descriptions — use spawn_agent for those.
- spawn_agent(prompt, agent?, target?): open a NEW coding agent terminal with a
  free-form task description. Defaults: agent="claude", target="local".
  agent can be any of: claude, codex, gemini, opencode, cursor, antigravity, grok
  - honor the one the user names ("spin up a Codex", "open a Gemini").
  Use for "start a new Claude to fix X", "open an agent and do Y", "run this
  task", "spin up a Codex for Z". Use target="cloud" when the user says
  "background", "while I'm away", "autonomously", or the task is long-running
  without needing live watching. Use target="local" (default) for interactive
  debugging, quick fixes, or anything the user wants to watch live.
- message_agent(who, prompt): speak a follow-up into an ALREADY-RUNNING agent
  terminal - it types the text into that agent's prompt and submits it.
  Use for "tell the Codex agent to also update the tests", "ask Claude to run
  the suite", "have the Gemini one check the migration", "nudge the auth agent".
  who matches by label, kind (claude/codex/gemini/...), or session prefix, same
  as focus. Do NOT use to START new work - that's spawn_agent. If who is
  ambiguous (two of the same kind running), the tool returns the candidates;
  read them back and ask which one.
- create_ticket(title, description?, priority?, labels?, assign?): file a new
  Linear ticket. Defaults: cycle=active, status=Todo, priority=medium.
  Use for "create a ticket", "file a bug", "new ticket", "add to the sprint",
  "log this as RUSH". Confirm the title back to the user before calling if
  it was paraphrased; quote the exact title you'll file.
Briefing has NO ticket data. Do not call briefing for cycle/ticket questions.
Do not call focus speculatively; wait for a specific question.
Confirm before dispatching if the user was vague (e.g. "the top one") -
read back the ticket id and title, then dispatch on assent.

Answering rules:
- Lead with the SPECIFIC: the task (topic), the file, the tool, the elapsed time.
- Good: "Claude is 12 minutes into auth refactor on agents repo, last edited jwt.ts."
- Bad: "Claude's been grinding 12 minutes, humming along."
- Prefer labels when present ("Philip Music"), fall back to kind ("claude, codex").
- If an agent is open in the IDE vs. just a local session, call it out only if
  relevant ("the one you have open" vs "the background Codex").
- Cloud dispatches run remotely; say "on Rush Cloud" or "on Codex Cloud" when
  referencing them so the user knows they're not on the laptop.
- Teams are DAG-coordinated runs; say "team <name>, 2 running, 1 pending".
- Never narrate the UI or offer to click things - that's the user's hands.

Voice delivery - you are SPEAKING ALOUD, not writing a report:
- Never read a list aloud. Name at most 3 items; aggregate the rest
  ("two on the case-study pages, four more idle").
- Never enumerate ("one... two... three..."), never recite ids, UUIDs,
  or field names from tool results.
- Never verbalize missing data. No "no label", "null", "unknown" - if a
  field is absent, skip the agent or fold it into a count.
- briefing's "others" field is pre-aggregated; speak it as one count
  ("plus eleven idle"), never expand it.
- Tool results are raw data, not a script. Answer the question asked;
  drop everything the user didn't ask about.

Length: 1-2 sentences default. Expand only if asked.`.trim();

export interface ForemanTool {
  type: 'function';
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export const FOREMAN_TOOLS: ForemanTool[] = [
  {
    type: 'function',
    name: 'briefing',
    description: 'Fast digest of the factory floor: up to 6 detailed agents (the ones with a task, label, or recent tool activity - kind, label, task, project, elapsed, open_in_ide), an "others" rollup counting the rest by kind and status, cloud dispatches (Rush/Codex/Factory running remotely), and active team DAGs. Speak "others" as a single count. Call first for any overview question.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'focus',
    description: 'Deep detail on one agent. Reads the session event tail to return current file being edited, current tool, last bash command, recent files, recent tools, since_last_activity, git_branch, token_count. Use when the user asks about a specific agent/task/project.',
    parameters: {
      type: 'object',
      properties: {
        who: { type: 'string', description: 'Agent label ("Philip Music"), topic keyword, kind (claude/codex/gemini/opencode/openclaw), or 8-char session id prefix.' },
      },
      required: ['who'],
    },
  },
  {
    type: 'function',
    name: 'team_detail',
    description: 'Per-teammate breakdown of ONE team DAG: each teammate\'s name, kind, status, and duration. Use when the user names a team and asks who is on it or how it is progressing ("who\'s on the auth team", "how\'s the pricing-page team doing"). Briefing only gives team rollup counts; this gives the members.',
    parameters: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team name, e.g. "auth" or "pricing-page".' },
      },
      required: ['team'],
    },
  },
  {
    type: 'function',
    name: 'cloud_status',
    description: 'Full status of ONE cloud task by id: provider, agent, status (queued/running/needs_review/completed/failed), repo, prompt. Use when the user asks about a specific cloud task ("what\'s the status of that cloud task", "is tsk_4f2a done", "did the Rush task finish").',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cloud task id, e.g. "tsk_4f2a91" or "ytd92m1v".' },
      },
      required: ['id'],
    },
  },
  {
    type: 'function',
    name: 'quota',
    description: 'Rate-limit / quota posture per agent: plan, availability status, and the tightest window\'s used percent. Use for "am I rate limited", "what\'s my Claude quota", "how much usage left", "is Codex throttled".',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'routines',
    description: 'Scheduled routines (cron agents): name, agent, human schedule, enabled, overdue, next run, last status. Use for "what\'s scheduled", "list my routines", "what runs tonight", "is the standup routine on".',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'fleet',
    description: 'The machines in the fleet: name, platform, whether online, and relay. Use for "what machines do I have", "is mac-mini online", "list the fleet", "which hosts are up".',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'cycle',
    description: 'Linear sprint/cycle status: cycle name, days left, counts of todo/in_progress/done tickets, urgent/high counts, and the top 5 pending tickets (id, title, priority, status). Use for "how many tasks left this cycle", "what\'s next up", "which tickets", or any question about RUSH-xxx / Linear / sprint / backlog.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'task_details',
    description: 'Full detail on ONE ticket: title, description, priority, status, assignee, labels, resolved repo. Use when the user asks "what is RUSH-xxx", "read me RUSH-xxx", "tell me about that ticket", or before dispatching to confirm the target.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Ticket identifier, e.g. "RUSH-557". Case-insensitive.' },
      },
      required: ['id'],
    },
  },
  {
    type: 'function',
    name: 'dispatch',
    description: 'Send a known Linear ticket to a coding agent. Defaults: agent="claude", target="cloud". Resolves target repo from the ticket\'s repo:<name> label unless the caller overrides with repo. Returns ok+message describing what was dispatched or why it could not be.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Ticket identifier, e.g. "RUSH-557".' },
        agent: { type: 'string', description: 'claude | codex | gemini | cursor (default: claude).' },
        target: { type: 'string', description: '"cloud" or "local" (default: cloud).' },
        repo: { type: 'string', description: 'Optional repo override, e.g. "agents-cli". Only set when the user explicitly names a repo; otherwise let the ticket\'s repo: label resolve it.' },
      },
      required: ['id'],
    },
  },
  {
    type: 'function',
    name: 'spawn_agent',
    description: 'Open a new coding agent terminal with a free-form task prompt. Use when the user gives a task description rather than a ticket ID. Defaults: agent="claude", target="local". Use target="cloud" when the user says "background", "while I\'m away", "autonomously", or the task is long-running without needing live watching.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task description for the agent.' },
        agent: { type: 'string', description: 'claude | codex | gemini | opencode | cursor | antigravity | grok (default: claude). Honor the agent the user names.' },
        target: { type: 'string', description: '"local" or "cloud" (default: local).' },
      },
      required: ['prompt'],
    },
  },
  {
    type: 'function',
    name: 'message_agent',
    description: 'Send a follow-up prompt into an ALREADY-RUNNING agent terminal: types the text into that agent and submits it. Use when the user wants to steer or add to an agent that is already working ("tell the codex agent to also update the tests", "ask Claude to run the suite"). NOT for starting new work - use spawn_agent for that. Returns ok+message on success, or ok=false with a candidates list when "who" is ambiguous so you can ask which one.',
    parameters: {
      type: 'object',
      properties: {
        who: { type: 'string', description: 'Which running agent: label ("Philip Music"), kind (claude/codex/gemini/opencode/cursor), or 8-char session id prefix. Same matching as focus.' },
        prompt: { type: 'string', description: 'The message/instruction to type into that agent.' },
      },
      required: ['who', 'prompt'],
    },
  },
  {
    type: 'function',
    name: 'create_ticket',
    description: 'File a new Linear ticket. Defaults: current (active) cycle, Todo status, medium priority. Returns ok+identifier+title on success, or ok=false with a speakable message on failure.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Ticket title. Required.' },
        description: { type: 'string', description: 'Optional longer-form description / body.' },
        priority: { type: 'string', description: 'urgent | high | medium | low | none (default: medium).' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Optional Linear labels, e.g. ["repo:agents-cli", "Bug"]. Each entry is one --label flag.' },
        assign: { type: 'string', description: 'Optional assignee email, or "none" to leave unassigned. Default: API key owner.' },
      },
      required: ['title'],
    },
  },
];
