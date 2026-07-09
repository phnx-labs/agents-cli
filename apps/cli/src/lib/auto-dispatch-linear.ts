/**
 * Concrete Linear gateway for auto-dispatch.
 *
 * Talks to the Linear GraphQL API. The API key is read from the LINEAR_API_KEY
 * env var, falling back to the macOS keychain generic-password `linear-api-key`
 * (how the rest of the stack stores it). If no key is resolvable, the gateway is
 * absent and the daemon skips auto-dispatch entirely.
 *
 * "Started" (Doing) and "unstarted" (Todo) are Linear state *types*, so we never
 * hardcode a team's custom state names. `startIssue` resolves the team's first
 * started-type state (cached per team) and moves the issue there — the existing
 * factory webhook turns that transition into a real run.
 */

import { execFileSync } from 'child_process';
import type { DelegatedIssue, LinearGateway } from './auto-dispatch.js';

const LINEAR_API = 'https://api.linear.app/graphql';

/** Resolve the Linear API key from env or (on macOS) the keychain. Null if absent. */
export function resolveLinearApiKey(): string | null {
  const fromEnv = process.env.LINEAR_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', 'linear-api-key', '-w'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const key = out.trim();
      if (key) return key;
    } catch {
      // not in keychain — fall through
    }
  }
  return null;
}

async function gql<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(`Linear API: ${json.errors.map((e) => e.message).join('; ')}`);
  if (!json.data) throw new Error('Linear API: empty response');
  return json.data;
}

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  delegate?: { name: string } | null;
  team?: { id: string } | null;
}

/** Build a real Linear gateway, or null when no API key is configured. */
export function createLinearGateway(): LinearGateway | null {
  const apiKey = resolveLinearApiKey();
  if (!apiKey) return null;

  // Cache the resolved started-state id per team so we don't re-query each dispatch.
  const startedStateByTeam = new Map<string, string>();

  async function resolveStartedState(teamId: string): Promise<string> {
    const cached = startedStateByTeam.get(teamId);
    if (cached) return cached;
    const data = await gql<{ workflowStates: { nodes: Array<{ id: string; type: string; position: number }> } }>(
      apiKey!,
      `query($t:String!){ workflowStates(filter:{ team:{ id:{ eq:$t } }, type:{ eq:"started" } }, first:10){ nodes{ id type position } } }`,
      { t: teamId },
    );
    const nodes = data.workflowStates.nodes.slice().sort((a, b) => a.position - b.position);
    const state = nodes[0];
    if (!state) throw new Error(`no started-type workflow state for team ${teamId}`);
    startedStateByTeam.set(teamId, state.id);
    return state.id;
  }

  // team id per issue, captured during fetchDelegatedTodo, so startIssue can resolve state.
  const teamByIssue = new Map<string, string>();

  return {
    async countInFlight(linearProjectId: string): Promise<number> {
      const data = await gql<{ issues: { nodes: Array<{ id: string }> } }>(
        apiKey!,
        `query($p:ID!){ issues(filter:{ project:{ id:{ eq:$p } }, state:{ type:{ eq:"started" } }, delegate:{ null:false } }, first:250){ nodes{ id } } }`,
        { p: linearProjectId },
      );
      return data.issues.nodes.length;
    },

    async fetchDelegatedTodo(linearProjectId: string): Promise<DelegatedIssue[]> {
      const data = await gql<{ issues: { nodes: IssueNode[] } }>(
        apiKey!,
        `query($p:ID!){ issues(filter:{ project:{ id:{ eq:$p } }, state:{ type:{ eq:"unstarted" } }, delegate:{ null:false } }, first:50){ nodes{ id identifier title priority delegate{ name } team{ id } } } }`,
        { p: linearProjectId },
      );
      const out: DelegatedIssue[] = [];
      for (const n of data.issues.nodes) {
        if (!n.delegate?.name) continue;
        if (n.team?.id) teamByIssue.set(n.id, n.team.id);
        out.push({ id: n.id, identifier: n.identifier, title: n.title ?? '', priority: n.priority ?? 0, delegateName: n.delegate.name });
      }
      return out;
    },

    async markStarted(issueId: string, delegateName: string): Promise<void> {
      const teamId = teamByIssue.get(issueId);
      if (!teamId) throw new Error(`unknown team for issue ${issueId} (fetch it first)`);
      const stateId = await resolveStartedState(teamId);
      const data = await gql<{ issueUpdate: { success: boolean } }>(
        apiKey!,
        `mutation($id:String!,$s:String!){ issueUpdate(id:$id, input:{ stateId:$s }){ success } }`,
        { id: issueId, s: stateId },
      );
      if (!data.issueUpdate.success) throw new Error(`issueUpdate failed for ${issueId}`);
      // Leave a trail so the auto-dispatch is visible in the ticket history.
      try {
        await gql(
          apiKey!,
          `mutation($i:String!,$b:String!){ commentCreate(input:{ issueId:$i, body:$b }){ success } }`,
          { i: issueId, b: `Auto-dispatched to **${delegateName}** by the factory (moved Todo → Doing).` },
        );
      } catch {
        // comment is best-effort — the state change is what matters
      }
    },
  };
}
