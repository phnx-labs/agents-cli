import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';

// Stub the IPC layer — the command registration tests never actually contact
// the browser daemon; they inspect Commander's tree and options.
vi.mock('../lib/browser/ipc.js', () => ({
  BrowserDaemonNotRunningError: class extends Error {},
  formatBrowserDaemonNotRunningError: () => 'stub',
  sendIPCRequest: vi.fn(),
}));

const { registerBrowserCommand } = await import('./browser.js');

function programWithBrowser(): Command {
  const program = new Command();
  program.exitOverride();
  registerBrowserCommand(program);
  return program;
}

function getBrowser(program: Command): Command {
  const cmd = program.commands.find((c) => c.name() === 'browser');
  if (!cmd) throw new Error('browser command not registered');
  return cmd;
}

describe('agents browser pdf', () => {
  it('registers a `pdf` subcommand that accepts an optional [output] positional', () => {
    const browser = getBrowser(programWithBrowser());
    const pdf = browser.commands.find((c) => c.name() === 'pdf');
    expect(pdf, 'pdf subcommand should be registered').toBeDefined();
    // Commander stores positional arg names on `_args` — presence check plus
    // required=false guarantees `browser pdf` runs without a path.
    const args = (pdf as unknown as { _args: Array<{ _name: string; required: boolean }> })._args;
    expect(args).toHaveLength(1);
    expect(args[0]._name).toBe('output');
    expect(args[0].required).toBe(false);
  });

  it('pdf subcommand exposes --task and --tab options', () => {
    const browser = getBrowser(programWithBrowser());
    const pdf = browser.commands.find((c) => c.name() === 'pdf')!;
    const longs = pdf.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--task', '--tab']));
  });

  it('description mentions the CDP command it delegates to', () => {
    const browser = getBrowser(programWithBrowser());
    const pdf = browser.commands.find((c) => c.name() === 'pdf')!;
    expect(pdf.description()).toMatch(/Page\.printToPDF/);
  });
});

describe('agents browser requests --format', () => {
  it('registers a `requests` subcommand with a --format option', () => {
    const browser = getBrowser(programWithBrowser());
    const requests = browser.commands.find((c) => c.name() === 'requests');
    expect(requests, 'requests subcommand should be registered').toBeDefined();
    const format = requests!.options.find((o) => o.long === '--format');
    expect(format, '--format option should exist on requests').toBeDefined();
  });

  it('--format defaults to "table" so the existing tabular output is unchanged', () => {
    const browser = getBrowser(programWithBrowser());
    const requests = browser.commands.find((c) => c.name() === 'requests')!;
    const format = requests.options.find((o) => o.long === '--format')!;
    // Commander stores the default on `defaultValue`.
    expect((format as unknown as { defaultValue: string }).defaultValue).toBe('table');
  });

  it('description advertises the HAR export path', () => {
    const browser = getBrowser(programWithBrowser());
    const requests = browser.commands.find((c) => c.name() === 'requests')!;
    expect(requests.description()).toMatch(/HAR/);
  });
});
