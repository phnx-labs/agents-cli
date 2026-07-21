import { test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listMcpResources, readMcpResource } from './mcpResources';

function makeWorkspace(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-mcp-resources-'));
  const mcpDir = path.join(workspace, '.agents', 'mcp');
  fs.mkdirSync(mcpDir, { recursive: true });
  const serverPath = path.join(__dirname, 'testdata', 'mcp-resource-server.cjs');
  fs.writeFileSync(
    path.join(mcpDir, 'fixture.yaml'),
    [
      'name: fixture',
      'transport: stdio',
      `command: ${JSON.stringify(process.execPath)}`,
      'args:',
      `  - ${JSON.stringify(serverPath)}`,
      '',
    ].join('\n'),
    'utf-8',
  );
  return workspace;
}

test('listMcpResources lists resources from a real stdio MCP server', async () => {
  const workspace = makeWorkspace();

  const result = await listMcpResources(workspace);

  expect(result.servers).toEqual([{ name: 'fixture', scope: 'project', connected: true }]);
  expect(result.resources).toEqual([
    {
      serverName: 'fixture',
      uri: 'fixture://config',
      name: 'config',
      description: 'Fixture JSON config',
      mimeType: 'application/json',
      size: undefined,
      title: undefined,
    },
  ]);
}, 15_000);

test('readMcpResource reads selected resource content from a real stdio MCP server', async () => {
  const workspace = makeWorkspace();

  const result = await readMcpResource('fixture', 'fixture://config', workspace);

  expect(result.serverName).toBe('fixture');
  expect(result.uri).toBe('fixture://config');
  expect(result.contents).toEqual([
    { uri: 'fixture://config', mimeType: 'application/json', text: '{"ok":true}' },
  ]);
}, 15_000);
