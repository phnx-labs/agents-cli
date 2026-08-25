import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getProjectAgentsDir } from '../src/lib/state.js';

let TEMP_ROOT: string | null = null;

afterEach(() => {
  if (TEMP_ROOT && fs.existsSync(TEMP_ROOT)) {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
  TEMP_ROOT = null;
});

describe('getProjectAgentsDir', () => {
  it('finds project .agents in ancestor before hitting boundary', () => {
    TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-dir-'));
    const repoRoot = path.join(TEMP_ROOT, 'repo');
    const deep = path.join(repoRoot, 'sub', 'deep');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(deep), { recursive: true });
    const projectAgents = path.join(repoRoot, '.agents');
    fs.mkdirSync(projectAgents);

    const found = getProjectAgentsDir(deep);
    expect(found).toBe(projectAgents);
  });

  it('stops at .git and does not climb to parent .agents', () => {
    TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-dir-'));
    const parentAgents = path.join(TEMP_ROOT, '.agents');
    fs.mkdirSync(parentAgents);

    const repoRoot = path.join(TEMP_ROOT, 'repo');
    const nested = path.join(repoRoot, 'nested');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });

    const found = getProjectAgentsDir(nested);
    expect(found).toBeNull();
  });
});
