import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let testRoot: string;

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-persistence-test-'));
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe('resolveBaseDir', () => {
  it('stores teams data under the user repo instead of the system repo', async () => {
    const modulePath = path.resolve(process.cwd(), 'src/lib/teams/persistence.ts');
    const baseDir = execFileSync(
      'bun',
      [
        '-e',
        `import { resolveBaseDir } from ${JSON.stringify(modulePath)}; console.log(await resolveBaseDir());`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: testRoot },
        stdio: 'pipe',
        encoding: 'utf8',
      },
    ).trim();

    const userDir = path.join(testRoot, '.agents');
    const systemDir = path.join(testRoot, '.agents-system');
    expect(baseDir).toBe(path.join(userDir, 'teams'));
    expect(baseDir.startsWith(systemDir)).toBe(false);
    expect(fs.existsSync(baseDir)).toBe(true);
  });
});
