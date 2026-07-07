import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerFeedbackCommand } from './feedback.js';

function programWithFeedback(): Command {
  const program = new Command();
  program.exitOverride();
  registerFeedbackCommand(program);
  return program;
}

describe('agents feedback', () => {
  it('registers a `feedback` subcommand with --bug, --idea, --question, --print', () => {
    const program = programWithFeedback();
    const cmd = program.commands.find((c) => c.name() === 'feedback');
    expect(cmd).toBeDefined();
    const optNames = cmd!.options.map((o) => o.long);
    expect(optNames).toEqual(expect.arrayContaining(['--bug', '--idea', '--question', '--print']));
  });

  it('--print outputs a Discussion URL by default with category=q-a', () => {
    const program = programWithFeedback();
    const out: string[] = [];
    const origLog = console.log;
    console.log = (msg?: unknown) => out.push(String(msg ?? ''));
    try {
      program.parse(['node', 'agents', 'feedback', '--print', 'how', 'do', 'I', 'X'], { from: 'node' });
    } finally {
      console.log = origLog;
    }
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/^https:\/\/github\.com\/phnx-labs\/agents-cli\/discussions\/new\?category=q-a&/);
    expect(out[0]).toContain('title=how%20do%20I%20X');
    expect(out[0]).toContain('body=');
  });

  it('--idea routes to Discussions Ideas category', () => {
    const program = programWithFeedback();
    const out: string[] = [];
    const origLog = console.log;
    console.log = (msg?: unknown) => out.push(String(msg ?? ''));
    try {
      program.parse(['node', 'agents', 'feedback', '--idea', '--print', 'add', 'XYZ'], { from: 'node' });
    } finally {
      console.log = origLog;
    }
    expect(out[0]).toContain('category=ideas');
    expect(out[0]).toContain('title=add%20XYZ');
  });

  it('--bug routes to the issue tracker with bug_report template', () => {
    const program = programWithFeedback();
    const out: string[] = [];
    const origLog = console.log;
    console.log = (msg?: unknown) => out.push(String(msg ?? ''));
    try {
      program.parse(['node', 'agents', 'feedback', '--bug', '--print', 'crash', 'on', 'pull'], { from: 'node' });
    } finally {
      console.log = origLog;
    }
    expect(out[0]).toMatch(/issues\/new\?template=bug_report\.yml/);
    expect(out[0]).toContain('title=crash%20on%20pull');
  });

  it('prefilled body URL-encodes version + os into the discussion body', () => {
    const program = programWithFeedback();
    const out: string[] = [];
    const origLog = console.log;
    console.log = (msg?: unknown) => out.push(String(msg ?? ''));
    try {
      program.parse(['node', 'agents', 'feedback', '--question', '--print', 'test'], { from: 'node' });
    } finally {
      console.log = origLog;
    }
    const url = out[0];
    const body = decodeURIComponent(url.split('body=')[1] ?? '');
    expect(body).toContain('agents-cli:');
    expect(body).toContain('OS:');
    expect(body).toContain('Node:');
  });
});
