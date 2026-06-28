import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function runCommandsWriterFixture(scriptBody: string, agent = 'grok', configDirName = '.grok'): unknown {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-writer-'));
  try {
    const script = `
      import * as fs from 'fs';
      import * as path from 'path';
      import { getWriter } from './src/lib/staleness/registry.ts';

      const home = process.env.HOME;
      if (!home) throw new Error('HOME missing');
      const agent = ${JSON.stringify(agent)};
      const configDirName = ${JSON.stringify(configDirName)};
      const userDir = path.join(home, '.agents');
      const projectRoot = path.join(home, 'project');
      const version = '0.2.33';
      const versionHome = path.join(home, '.agents', '.history', 'versions', agent, version, 'home');
      const agentDir = path.join(versionHome, configDirName);
      fs.mkdirSync(projectRoot, { recursive: true });
      fs.mkdirSync(agentDir, { recursive: true });
      const writeUser = (rel, content) => {
        const p = path.join(userDir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, 'utf-8');
        return p;
      };
      const writer = getWriter('commands', agent);
      if (!writer) throw new Error(agent + ' commands writer missing');
      ${scriptBody}
    `;
    const out = execFileSync('bun', ['--eval', script], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    return JSON.parse(out.trim());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('commands writer', () => {
  it('rewrites marker-bearing command skills that collide with source skills', () => {
    const result = runCommandsWriterFixture(`
      writeUser('commands/debug.md', ['---', 'description: Fresh debug', '---', '', 'fresh body'].join('\\n'));
      writeUser('skills/debug/SKILL.md', ['---', 'name: "debug"', 'description: "old"', 'agents_command: "debug"', '---', '', 'old body'].join('\\n'));
      fs.mkdirSync(path.join(agentDir, 'skills', 'debug'), { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'skills', 'debug', 'SKILL.md'), 'STALE', 'utf-8');

      const writeResult = writer.write({ version, versionHome, selection: ['debug'], cwd: projectRoot });
      const skillPath = path.join(agentDir, 'skills', 'debug', 'SKILL.md');
      console.log(JSON.stringify({
        synced: writeResult.synced,
        content: fs.readFileSync(skillPath, 'utf-8'),
      }));
    `) as { synced: string[]; content: string };

    expect(result.synced).toEqual(['debug']);
    expect(result.content).toContain('agents_command: "debug"');
    expect(result.content).toContain('fresh body');
    expect(result.content).not.toContain('STALE');
  });

  it('reports genuine source-skill collisions as synced no-ops', () => {
    const result = runCommandsWriterFixture(`
      writeUser('commands/plan.md', ['---', 'description: Plan', '---', '', 'plan body'].join('\\n'));
      writeUser('skills/plan/SKILL.md', ['---', 'name: "plan"', 'description: "real skill"', '---', '', 'real skill body'].join('\\n'));

      const writeResult = writer.write({ version, versionHome, selection: ['plan'], cwd: projectRoot });
      const skillPath = path.join(agentDir, 'skills', 'plan', 'SKILL.md');
      console.log(JSON.stringify({
        synced: writeResult.synced,
        exists: fs.existsSync(skillPath),
      }));
    `) as { synced: string[]; exists: boolean };

    expect(result.synced).toEqual(['plan']);
    expect(result.exists).toBe(false);
  });

  it('converts a command to a skill for kimi (commands:false, no native runtime)', () => {
    const result = runCommandsWriterFixture(`
      writeUser('commands/recap.md', ['---', 'description: Summarize the situation', '---', '', 'recap body'].join('\\n'));

      const writeResult = writer.write({ version, versionHome, selection: ['recap'], cwd: projectRoot });
      const skillPath = path.join(agentDir, 'skills', 'recap', 'SKILL.md');
      console.log(JSON.stringify({
        synced: writeResult.synced,
        exists: fs.existsSync(skillPath),
        content: fs.existsSync(skillPath) ? fs.readFileSync(skillPath, 'utf-8') : '',
      }));
    `, 'kimi', '.kimi-code') as { synced: string[]; exists: boolean; content: string };

    expect(result.synced).toEqual(['recap']);
    expect(result.exists).toBe(true);
    expect(result.content).toContain('agents_command: "recap"');
    expect(result.content).toContain('recap body');
  });
});
