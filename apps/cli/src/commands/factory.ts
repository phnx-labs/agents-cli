/**
 * Software Factory CLI — submits Linear issues to a remote orchestrator.
 *
 * Requires FACTORY_FLOOR_URL pointing at a Factory-compatible endpoint.
 * Beta-gated; enable with `agents beta enable factory`.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { die } from '../lib/format.js';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { betaEnableHint, isBetaEnabled } from '../lib/beta.js';
import { insertTask } from '../lib/cloud/store.js';


function requireFactoryUrl(): string {
  const url = process.env.FACTORY_FLOOR_URL;
  if (!url) {
    die('FACTORY_FLOOR_URL is not set. Point it at your Software Factory endpoint.');
  }
  return url;
}

function readRushToken(): string {
  const userYaml = path.join(homedir(), '.rush', 'user.yaml');
  if (!fs.existsSync(userYaml)) {
    die('Not logged in to Rush. Run `rush login` first.');
  }
  const raw = fs.readFileSync(userYaml, 'utf-8');
  const match = raw.match(/access_token:\s*([^\s#]+)/);
  if (!match) {
    die('No session token in ~/.rush/user.yaml. Run `rush login` first.');
  }
  return match[1].replace(/^['"]|['"]$/g, '');
}

interface SubmitResponse {
  ticket_id: string;
  linear_identifier: string;
  label: string;
  cloud_execution_id: string;
}

async function postFactorySubmit(ref: string): Promise<SubmitResponse> {
  const factoryUrl = requireFactoryUrl();
  const token = readRushToken();
  const res = await fetch(`${factoryUrl}/factory/submit`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    die(`Factory submit failed (${res.status}): ${body.slice(0, 400)}`);
  }
  return res.json() as Promise<SubmitResponse>;
}

export function registerFactoryCommands(program: Command): void {
  const enabled = isBetaEnabled('factory');
  const factory = program
    .command('factory', { hidden: !enabled })
    .description('Software Factory -- submit Linear tickets to the cloud orchestrator.')
    .addHelpText('after', `
Examples:
  agents factory submit PROJ-123
  agents factory submit https://linear.app/example/issue/PROJ-123
`);

  factory.hook('preAction', () => {
    if (enabled) return;
    console.error(chalk.red('agents factory is in beta.'));
    console.error(chalk.gray(betaEnableHint('factory')));
    process.exit(1);
  });

  factory
    .command('submit <linear-ref>')
    .description('Submit a Linear issue (PROJ-123 or URL) to the Software Factory.')
    .option('--json', 'Output machine-readable JSON')
    .action(async (ref: string, opts: { json?: boolean }) => {
      const result = await postFactorySubmit(ref);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      // Register locally so `agents cloud logs <id>` can find it.
      const now = new Date().toISOString();
      insertTask({
        id: result.cloud_execution_id,
        provider: 'rush',
        status: 'queued',
        agent: 'claude',
        prompt: result.linear_identifier,
        createdAt: now,
        updatedAt: now,
      });

      console.log(chalk.green(`Submitted ${result.linear_identifier} (${result.label})`));
      console.log(`  ticket       ${result.ticket_id}`);
      console.log(`  execution    ${result.cloud_execution_id}`);
      console.log(`  tail output  agents cloud logs ${result.cloud_execution_id}`);
    });
}
