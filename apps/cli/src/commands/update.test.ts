/**
 * The `agents update` surface. Pins the command shape agents and scripts call
 * (`<agent>@<installed-version>`, `--to`, `--account`, `--json`) and the two
 * boundaries where a wrong answer is worse than an error: naming an agent that
 * cannot be pinned, and naming an installation that does not exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';

let home: string;

async function program(): Promise<Command> {
  vi.resetModules();
  const { registerUpdateCommand } = await import('./update.js');
  const p = new Command();
  p.exitOverride();
  p.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerUpdateCommand(p);
  return p;
}

/** Run the command exactly as argv would reach it. */
async function run(args: string[]): Promise<void> {
  const p = await program();
  await p.parseAsync(['node', 'agents', ...args]);
}

describe('agents update', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-update-cmd-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('registers update with the documented options and a list subcommand', async () => {
    const update = (await program()).commands.find((c) => c.name() === 'update');
    expect(update).toBeDefined();
    const flags = update!.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--to', '--account', '--json']));
    expect(update!.commands.map((c) => c.name())).toContain('list');
  });

  it('carries workflow-first help, not a bare flag dump', async () => {
    vi.resetModules();
    const { applyGlobalHelpConventions } = await import('../lib/help.js');
    const { registerUpdateCommand } = await import('./update.js');
    const root = new Command();
    registerUpdateCommand(root);
    applyGlobalHelpConventions(root);

    const help = root.commands.find((c) => c.name() === 'update')!.helpInformation();
    expect(help).toContain('agents update claude@2.0.65 --to 2.1.220');
    expect(help).toContain('--account');
  });

  it('rejects an unknown agent by name', async () => {
    await expect(run(['update', 'notanagent'])).rejects.toThrow(/notanagent/);
  });

  it('rejects a bare @ with no installation', async () => {
    await expect(run(['update', 'claude@'])).rejects.toThrow(/Missing installation/);
  });

  it('refuses a pinned --to for a harness whose installer takes no version', async () => {
    // droid installs one self-updating binary; honouring `--to 1.2.3` is
    // impossible, so it must say so rather than install the current release and
    // report it as the pin.
    await expect(run(['update', 'droid', '--to', '1.2.3'])).rejects.toThrow(/no pinnable releases/);
  });

  it('reports that nothing is installed rather than failing obscurely', async () => {
    await expect(run(['update', 'claude@2.0.65'])).rejects.toThrow(/agents add claude@latest/);
  });

  it('lists installations as JSON with their stable id and current release', async () => {
    const dir = path.join(home, '.agents', '.history', 'versions', 'claude', '2.0.65');
    fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
    // Reset first: `state.ts` snapshots HOME at module load, so a graph cached
    // by an earlier test would write this record under the previous temp home.
    vi.resetModules();
    const { createInstallation, recordRelease } = await import('../lib/installations/index.js');
    recordRelease(createInstallation('claude', '2.0.65', '2.0.65'), '2.1.220');

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); });
    await run(['update', 'list', 'claude', '--json']);

    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ agent: 'claude', label: '2.0.65', releaseVersion: '2.1.220' });
    expect(parsed[0].id).toMatch(/^ins_/);
  });
});
