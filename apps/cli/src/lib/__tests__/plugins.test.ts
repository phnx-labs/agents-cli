import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadPluginManifest } from '../plugins.js';

const tempDirs: string[] = [];

function createPluginRoot(name: string, version = '1.0.0'): string {
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-manifest-'));
  tempDirs.push(pluginRoot);

  const manifestDir = path.join(pluginRoot, '.claude-plugin');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, 'plugin.json'),
    JSON.stringify({ name, version }),
    'utf-8'
  );

  return pluginRoot;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadPluginManifest', () => {
  it.each([
    '../../etc',
    '../foo',
    'foo/bar',
    'foo\\bar',
    '',
  ])('returns null for traversal-like plugin name %j', (name) => {
    const pluginRoot = createPluginRoot(name);

    expect(loadPluginManifest(pluginRoot)).toBeNull();
  });

  it.each([
    'my-plugin',
    'myplugin',
    'my.plugin',
    'my_plugin',
  ])('returns manifest for valid plugin name %j', (name) => {
    const pluginRoot = createPluginRoot(name);

    expect(loadPluginManifest(pluginRoot)).toMatchObject({
      name,
      version: '1.0.0',
    });
  });
});
