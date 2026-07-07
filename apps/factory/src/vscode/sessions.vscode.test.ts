import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getClaudeProjectRoots, getSessionPathBySessionId } from './sessions.vscode';

async function withTempHome(run: (home: string) => Promise<void> | void): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmify-sessions-home-'));
  try {
    await run(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('getSessionPathBySessionId', () => {
  test('includes .agents-system Claude version roots', async () => {
    await withTempHome(async (home) => {
      const projectRoot = path.join(
        home,
        '.agents-system',
        'versions',
        'claude',
        '2.1.121',
        'home',
        '.claude',
        'projects',
      );
      fs.mkdirSync(projectRoot, { recursive: true });

      const roots = await getClaudeProjectRoots(home);
      expect(roots).toContain(projectRoot);
    });
  });

  test('finds Claude sessions under .agents-system version homes', async () => {
    await withTempHome(async (home) => {
      const sessionId = '12345678-1234-1234-1234-123456789abc';
      const filePath = path.join(
        home,
        '.agents-system',
        'versions',
        'claude',
        '2.1.121',
        'home',
        '.claude',
        'projects',
        'repo',
        `${sessionId}.jsonl`,
      );
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '{"type":"message"}\n');

      expect(await getSessionPathBySessionId(sessionId, 'claude', undefined, home)).toBe(filePath);
    });
  });
});
