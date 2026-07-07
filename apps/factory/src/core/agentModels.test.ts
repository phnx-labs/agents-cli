import { test, expect, beforeEach } from 'bun:test';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  fetchAgentModels,
  fetchAgentCatalog,
  fetchAllAgentModels,
  isAgentInstalled,
  checkInstalledAgentsViaCli,
  resolveAlias,
  clearAgentModelsCache,
  MODEL_CATALOG_AGENTS,
} from './agentModels';
import { AGENT_MODELS } from './settings';

const execAsync = promisify(exec);

async function agentsCliAvailable(): Promise<boolean> {
  try {
    await execAsync('agents --version', { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  clearAgentModelsCache();
});

test('fetchAgentCatalog returns null when agents-cli is unreachable', async () => {
  // The resolver bypasses PATH (resolves via shell + filesystem probes), so
  // unsetting PATH no longer simulates an unreachable CLI. Use the documented
  // test hook instead.
  process.env.AGENTS_CLI_DISABLED = '1';
  try {
    const catalog = await fetchAgentCatalog('claude');
    expect(catalog).toBeNull();
  } finally {
    delete process.env.AGENTS_CLI_DISABLED;
  }
});

test('fetchAgentModels falls back to hardcoded AGENT_MODELS when CLI is unreachable', async () => {
  process.env.AGENTS_CLI_DISABLED = '1';
  try {
    const models = await fetchAgentModels('claude');
    expect(models).toEqual(AGENT_MODELS.claude);
  } finally {
    delete process.env.AGENTS_CLI_DISABLED;
  }
});

test('fetchAllAgentModels returns entries for every supported agent', async () => {
  const all = await fetchAllAgentModels();
  for (const agent of MODEL_CATALOG_AGENTS) {
    expect(all[agent]).toBeDefined();
    expect(Array.isArray(all[agent])).toBe(true);
  }
});

test('live fetchAgentCatalog returns a populated catalog when agents-cli is present', async () => {
  if (!(await agentsCliAvailable())) return;
  const catalog = await fetchAgentCatalog('claude');
  expect(catalog).not.toBeNull();
  expect(catalog!.models.length).toBeGreaterThan(0);
  for (const m of catalog!.models) {
    expect(typeof m.id).toBe('string');
    expect(m.id.length).toBeGreaterThan(0);
  }
});

test('resolveAlias returns concrete model id for Claude opus/haiku aliases', async () => {
  if (!(await agentsCliAvailable())) return;
  const opus = await resolveAlias('claude', 'opus');
  const haiku = await resolveAlias('claude', 'haiku');
  expect(typeof opus).toBe('string');
  expect(typeof haiku).toBe('string');
  expect(opus).not.toBe(haiku);
});

test('isAgentInstalled reports true for claude when CLI reports a catalog', async () => {
  if (!(await agentsCliAvailable())) return;
  expect(await isAgentInstalled('claude')).toBe(true);
});

test('checkInstalledAgentsViaCli always reports shell=true', async () => {
  const result = await checkInstalledAgentsViaCli();
  expect(result.shell).toBe(true);
});

test('second call within TTL serves cached catalog (no exec)', async () => {
  if (!(await agentsCliAvailable())) return;
  const first = await fetchAgentModels('claude');
  process.env.AGENTS_CLI_DISABLED = '1';
  try {
    const second = await fetchAgentModels('claude');
    expect(second).toEqual(first);
  } finally {
    delete process.env.AGENTS_CLI_DISABLED;
  }
});
