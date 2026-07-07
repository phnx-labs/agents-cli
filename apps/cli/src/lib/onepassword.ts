/**
 * 1Password CLI (op) integration for importing secrets from vaults.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface OpVault {
  id: string;
  name: string;
}

export interface OpItemSummary {
  id: string;
  title: string;
  category: string;
  vault: { id: string; name: string };
}

export interface OpField {
  id: string;
  label: string;
  type: string;
  value?: string;
  purpose?: string;
}

export interface OpItem extends OpItemSummary {
  fields: OpField[];
}

export interface ImportableSecret {
  envKey: string;
  itemTitle: string;
  fieldLabel: string;
  value: string;
}

export interface SkippedField {
  itemTitle: string;
  fieldLabel: string;
  reason: string;
}

function runOp(
  args: string[],
  input?: string
): { ok: true; stdout: string } | { ok: false; error: string } {
  const result = spawnSync('op', args, {
    stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    input,
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: '1Password CLI not found. Install: brew install 1password-cli' };
    }
    return { ok: false, error: result.error.message };
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || '';
    if (stderr.includes('not signed in') || stderr.includes('sign in') || stderr.includes('no active session')) {
      return { ok: false, error: 'Not signed in to 1Password. Run: op signin' };
    }
    return { ok: false, error: stderr || `op exited with code ${result.status}` };
  }

  return { ok: true, stdout: result.stdout };
}

export function assertOpAvailable(): void {
  // `op account list` works with both CLI session tokens and the 1Password
  // desktop biometric integration; `op whoami` fails on the latter.
  const result = runOp(['account', 'list', '--format=json']);
  if (!result.ok) {
    throw new Error(result.error);
  }
}

export function listVaults(): OpVault[] {
  const result = runOp(['vault', 'list', '--format=json']);
  if (!result.ok) throw new Error(result.error);
  return JSON.parse(result.stdout) as OpVault[];
}

export function listItems(vaultName: string): OpItemSummary[] {
  const result = runOp(['item', 'list', '--vault', vaultName, '--format=json']);
  if (!result.ok) {
    if (result.error.includes('vault') && result.error.includes('not found')) {
      const vaults = listVaults();
      const available = vaults.map((v) => v.name).join(', ');
      throw new Error(`Vault '${vaultName}' not found. Available: ${available || '(none)'}`);
    }
    throw new Error(result.error);
  }
  const items = JSON.parse(result.stdout) as OpItemSummary[];
  return items || [];
}

export function getItem(itemId: string, vaultName: string): OpItem {
  const result = runOp(['item', 'get', itemId, '--vault', vaultName, '--format=json', '--reveal']);
  if (!result.ok) throw new Error(result.error);
  return JSON.parse(result.stdout) as OpItem;
}

export function toEnvKey(title: string): string {
  return title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, '_$1');
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const IMPORTABLE_FIELD_TYPES = new Set([
  'CONCEALED', 'concealed',
  'STRING', 'string', 'text', 'TEXT',
  'URL', 'url',
]);
const SKIP_FIELD_LABELS = new Set(['username', 'notesPlain', 'notes']);

function pickBestField(fields: OpField[]): OpField | null {
  const dominated = fields.filter(
    (f) =>
      IMPORTABLE_FIELD_TYPES.has(f.type) &&
      f.value &&
      !SKIP_FIELD_LABELS.has(f.label?.toLowerCase() || '')
  );
  if (dominated.length === 0) return null;

  // Prefer concealed fields (credentials/passwords)
  const concealed = dominated.find((f) => f.type.toLowerCase() === 'concealed');
  if (concealed) return concealed;

  // Then prefer fields labeled credential/password/secret/key/token
  const secretLabels = ['credential', 'password', 'secret', 'key', 'token', 'api_key', 'apikey'];
  const labeled = dominated.find((f) => secretLabels.includes(f.label?.toLowerCase() || ''));
  if (labeled) return labeled;

  // Fall back to first importable field
  return dominated[0];
}

export function extractSecrets(
  items: OpItemSummary[],
  vaultName: string
): { secrets: ImportableSecret[]; skipped: SkippedField[] } {
  const secrets: ImportableSecret[] = [];
  const skipped: SkippedField[] = [];

  for (const summary of items) {
    let item: OpItem;
    try {
      item = getItem(summary.id, vaultName);
    } catch (err) {
      skipped.push({
        itemTitle: summary.title,
        fieldLabel: '*',
        reason: (err as Error).message,
      });
      continue;
    }

    const field = pickBestField(item.fields || []);

    if (!field) {
      skipped.push({
        itemTitle: item.title,
        fieldLabel: '*',
        reason: 'no importable fields',
      });
      continue;
    }

    if (field.value!.includes('\n')) {
      skipped.push({
        itemTitle: item.title,
        fieldLabel: field.label,
        reason: 'contains newlines (keychain limitation)',
      });
      continue;
    }

    const envKey = toEnvKey(item.title);
    secrets.push({
      envKey,
      itemTitle: item.title,
      fieldLabel: field.label,
      value: field.value!,
    });
  }

  return { secrets, skipped };
}

export interface PasswordItemTemplate {
  title: string;
  category: 'PASSWORD';
  tags: string[];
  fields: Array<{
    id: string;
    type: 'CONCEALED';
    purpose: 'PASSWORD';
    label: string;
    value: string;
  }>;
}

export function buildPasswordItemTemplate(title: string, value: string): PasswordItemTemplate {
  return {
    title,
    category: 'PASSWORD',
    tags: ['agents-cli'],
    fields: [
      { id: 'password', type: 'CONCEALED', purpose: 'PASSWORD', label: 'password', value },
    ],
  };
}

export function itemExistsByTitle(title: string, vaultName: string): boolean {
  const result = runOp(['item', 'get', title, '--vault', vaultName, '--format=json']);
  if (result.ok) return true;
  if (/isn't an item|not found|no item found/i.test(result.error)) return false;
  throw new Error(result.error);
}

export function deleteItemByTitle(title: string, vaultName: string): void {
  const result = runOp(['item', 'delete', title, '--vault', vaultName]);
  if (!result.ok) throw new Error(result.error);
}

export function createPasswordItem(title: string, value: string, vaultName: string): void {
  // op item create reads stdin templates only from a real pipe; spawnSync's
  // input plumbing is detected as empty and op silently ignores the template.
  // The supported alternative is --template <file>, which works reliably.
  const template = JSON.stringify(buildPasswordItemTemplate(title, value));
  const tmpFile = path.join(os.tmpdir(), `agents-op-tpl-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, template, { mode: 0o600 });
  try {
    const result = runOp(['item', 'create', '--template', tmpFile, '--vault', vaultName]);
    if (!result.ok) throw new Error(result.error);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup
    }
  }
}
