import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const tempDirs: string[] = [];
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resource-profile-'));
  tempDirs.push(home);
  return home;
}

function runProbe(home: string, code: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', ['--import', 'tsx', '-e', code], {
    cwd: APP_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_SECRETS_NO_AGENT: '1',
    },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

describe('resource profiles', () => {
  it('filters source-qualified resource selectors and active rules preset', () => {
    const home = makeHome();
    const result = runProbe(home, `
      const {
        activeRulesPreset,
        filterNamesForActiveResourceProfile,
        setActiveResourceProfile,
        upsertResourceProfilePreset,
      } = await import('./src/lib/resource-profiles.ts');

      upsertResourceProfilePreset('work', {
        skills: ['user:deploy', 'shared'],
        rules: 'work-rules',
      });
      setActiveResourceProfile('work');

      const sourceMap = new Map([
        ['deploy', 'user'],
        ['debug', 'system'],
        ['shared', 'system'],
      ]);

      console.log(JSON.stringify({
        skills: filterNamesForActiveResourceProfile('skills', ['deploy', 'debug', 'shared'], sourceMap),
        rules: filterNamesForActiveResourceProfile('memory', ['default', 'work-rules']),
        activeRules: activeRulesPreset(),
      }));
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      skills: ['deploy', 'shared'],
      rules: ['work-rules'],
      activeRules: 'work-rules',
    });
  });

  it('lets source-qualified exclusions remove plain pattern inclusions', () => {
    const home = makeHome();
    const result = runProbe(home, `
      const {
        filterNamesForActiveResourceProfile,
        setActiveResourceProfile,
        upsertResourceProfilePreset,
      } = await import('./src/lib/resource-profiles.ts');

      upsertResourceProfilePreset('work', {
        skills: ['*', '!system:debug'],
      });
      setActiveResourceProfile('work');

      const sourceMap = new Map([
        ['keep', 'user'],
        ['debug', 'system'],
      ]);

      console.log(JSON.stringify(
        filterNamesForActiveResourceProfile('skills', ['keep', 'debug'], sourceMap)
      ));
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['keep']);
  });

  it('filters secrets listing and injection through the active profile', () => {
    const home = makeHome();
    const result = runProbe(home, `
      const { setActiveResourceProfile, upsertResourceProfilePreset } = await import('./src/lib/resource-profiles.ts');
      const { setKeychainBackendForTest } = await import('./src/lib/secrets/index.ts');
      const { listBundles, readAndResolveBundleEnv, writeBundle } = await import('./src/lib/secrets/bundles.ts');

      class MemBackend {
        store = new Map();
        has(item) { return this.store.has(item); }
        get(item) {
          const value = this.store.get(item);
          if (value === undefined) throw new Error('missing ' + item);
          return value;
        }
        set(item, value) { this.store.set(item, value); }
        delete(item) { return this.store.delete(item); }
        list(prefix) { return [...this.store.keys()].filter((key) => key.startsWith(prefix)); }
      }

      setKeychainBackendForTest(new MemBackend());
      writeBundle({ name: 'prod', vars: { API_KEY: { value: 'prod-key' } } });
      writeBundle({ name: 'personal', vars: { API_KEY: { value: 'personal-key' } } });

      upsertResourceProfilePreset('work', { secrets: ['prod'] });
      setActiveResourceProfile('work');

      let inactiveError = '';
      try {
        readAndResolveBundleEnv('personal', { caller: 'test' });
      } catch (err) {
        inactiveError = err.message;
      }
      console.log(JSON.stringify({
        bundles: listBundles().map((bundle) => bundle.name),
        prod: readAndResolveBundleEnv('prod', { caller: 'test' }).env,
        inactiveError,
      }));
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      bundles: ['prod'],
      prod: { API_KEY: 'prod-key' },
      inactiveError: "Secrets bundle 'personal' is not active in profile 'work'.",
    });
  });
});
