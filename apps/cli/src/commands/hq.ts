import type { Command } from 'commander';
import chalk from 'chalk';
import { getActiveSessions } from '../lib/session/active.js';
import { AgentManager } from '../lib/teams/agents.js';
import { handleStatus, handleTasks, type AgentStatusDetail } from '../lib/teams/api.js';
import { listAskStats, listBlocks } from '../lib/feed.js';
import { buildSessionSignals, synthesizeControlCards } from '../lib/feed-ranking.js';
import { discoverSessions } from '../lib/session/discover.js';
import { buildHqFloor } from '../lib/hq/floor.js';
import { die } from '../lib/format.js';

async function collectFloorSnapshot(): Promise<ReturnType<typeof buildHqFloor>> {
  const manager = new AgentManager();
  const [sessions, tasksResult] = await Promise.all([
    getActiveSessions(),
    handleTasks(manager, 1000),
  ]);

  const teammatesByTeam = new Map<string, AgentStatusDetail[]>();
  await Promise.all(tasksResult.tasks.map(async (team) => {
    const status = await handleStatus(manager, team.task_name, 'all');
    teammatesByTeam.set(team.task_name, status.agents);
  }));

  const sessionMetas = sessions.length > 0 ? await discoverSessions({ all: true, limit: 5000 }) : [];
  const blocks = [
    ...listBlocks(),
    ...synthesizeControlCards(buildSessionSignals(sessions, sessionMetas), listAskStats()),
  ];

  return buildHqFloor({
    sessions,
    teams: tasksResult.tasks,
    teammatesByTeam,
    blocks,
  });
}

export function registerHqCommand(program: Command): void {
  const hq = program
    .command('hq')
    .description('Machine-readable bridge for Agents HQ floor management.');

  hq
    .command('floor')
    .description('Emit the live floor snapshot: rooms, agents, ambient events, and runnable actions.')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const snapshot = await collectFloorSnapshot();
        if (opts.json || !process.stdout.isTTY) {
          console.log(JSON.stringify(snapshot, null, 2));
          return;
        }
        console.log(chalk.bold('Agents HQ floor'));
        console.log(chalk.gray(`${snapshot.counters.agents} agents, ${snapshot.counters.rooms} rooms, ${snapshot.counters.needsInput} need input`));
        for (const room of snapshot.rooms) {
          console.log(`${chalk.cyan(room.name)}  ${chalk.gray(`${room.counts.agents} agents, ${room.counts.running} running, ${room.counts.needsInput} need input`)}`);
        }
      } catch (err) {
        die((err as Error).message);
      }
    });
}
