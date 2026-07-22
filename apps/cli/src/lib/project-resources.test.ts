import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as yaml from 'yaml';
import { syncProjectResourcesToAgent } from './project-resources.js';

const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-project-resources-'));
  tempDirs.push(dir);
  return path.join(dir, 'repo');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('syncProjectResourcesToAgent', () => {
  it('clears the Kimi parent subagent index when the last project subagent is removed', () => {
    const project = makeTempProject();
    const projectAgentsDir = path.join(project, '.agents');
    const subagentDir = path.join(projectAgentsDir, 'subagents', 'reviewer');
    fs.mkdirSync(subagentDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentDir, 'AGENT.md'),
      '---\nname: reviewer\ndescription: Reviews diffs\n---\n\nReview the diff.',
      'utf-8',
    );

    const first = syncProjectResourcesToAgent('kimi', '0.1.0', projectAgentsDir);

    const agentsDir = path.join(project, '.kimi-code', 'agents');
    const parentPath = path.join(agentsDir, '_agents-cli.yaml');
    expect(first.synced).toContain('subagents/reviewer');
    expect(fs.existsSync(path.join(agentsDir, 'reviewer.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'reviewer.system.md'))).toBe(true);
    let parent = yaml.parse(fs.readFileSync(parentPath, 'utf-8')) as { agent?: { subagents?: Record<string, unknown> } };
    expect(parent.agent?.subagents?.reviewer).toBeDefined();

    fs.rmSync(subagentDir, { recursive: true, force: true });
    const second = syncProjectResourcesToAgent('kimi', '0.1.0', projectAgentsDir);

    expect(second.synced).toEqual([]);
    expect(fs.existsSync(path.join(agentsDir, 'reviewer.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, 'reviewer.system.md'))).toBe(false);
    parent = yaml.parse(fs.readFileSync(parentPath, 'utf-8')) as { agent?: { subagents?: Record<string, unknown> } };
    expect(parent.agent?.subagents).toEqual({});
    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.kimi-code', '.agents-managed.json'), 'utf-8')) as { paths: string[] };
    expect(manifest.paths).toEqual(['agents/_agents-cli.yaml']);
  });
});
