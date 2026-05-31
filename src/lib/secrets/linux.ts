/**
 * Linux secret storage via libsecret (GNOME Keyring / Secret Service API).
 *
 * Uses `secret-tool` CLI which is part of libsecret-tools package.
 * On Ubuntu: apt install libsecret-tools
 *
 * Secrets are stored with:
 *   service = "agents-cli"
 *   account = username
 *   item = the secret identifier
 */

import { spawnSync } from 'child_process';
import * as os from 'os';
import type { KeychainBackend } from './index.js';

const SERVICE = 'agents-cli';

function secretToolAvailable(): boolean {
  const result = spawnSync('which', ['secret-tool'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

let checkedAvailability = false;
let isAvailable = false;

function ensureSecretTool(): void {
  if (!checkedAvailability) {
    isAvailable = secretToolAvailable();
    checkedAvailability = true;
  }
  if (!isAvailable) {
    throw new Error(
      'secret-tool not found. Install libsecret-tools:\n' +
      '  Ubuntu/Debian: sudo apt install libsecret-tools\n' +
      '  Fedora: sudo dnf install libsecret\n' +
      '  Arch: sudo pacman -S libsecret'
    );
  }
}

/**
 * secret-tool lookup attributes:
 *   service=agents-cli account=<user> item=<itemName>
 */
export function hasSecretToolToken(item: string): boolean {
  ensureSecretTool();
  const user = os.userInfo().username;
  const result = spawnSync('secret-tool', [
    'lookup',
    'service', SERVICE,
    'account', user,
    'item', item,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0 && result.stdout?.toString().trim().length > 0;
}

export function getSecretToolToken(item: string): string {
  ensureSecretTool();
  const user = os.userInfo().username;
  const result = spawnSync('secret-tool', [
    'lookup',
    'service', SERVICE,
    'account', user,
    'item', item,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`Secret '${item}' not found in keyring.`);
  }
  const token = result.stdout?.toString().trim();
  if (!token) {
    throw new Error(`Secret '${item}' exists but is empty.`);
  }
  return token;
}

export function setSecretToolToken(item: string, value: string): void {
  ensureSecretTool();
  if (!value || !value.trim()) throw new Error('Secret value is empty.');

  const user = os.userInfo().username;
  const label = `agents-cli: ${item}`;

  // secret-tool store reads value from stdin
  const result = spawnSync('secret-tool', [
    'store',
    '--label', label,
    'service', SERVICE,
    'account', user,
    'item', item,
  ], {
    input: value,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    throw new Error(
      `Failed to store secret '${item}': ${stderr || 'unknown error'}\n` +
      'Make sure GNOME Keyring or another Secret Service provider is running.'
    );
  }
}

export function deleteSecretToolToken(item: string): boolean {
  ensureSecretTool();
  const user = os.userInfo().username;
  const result = spawnSync('secret-tool', [
    'clear',
    'service', SERVICE,
    'account', user,
    'item', item,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // secret-tool clear returns 0 whether the item existed or not.
  // This matches the macOS behavior where delete is idempotent.
  return result.status === 0;
}

/**
 * List secrets by prefix. secret-tool doesn't have a list command,
 * so we use secret-tool search which outputs in a specific format.
 */
export function listSecretToolItems(prefix: string): string[] {
  ensureSecretTool();
  // secret-tool search outputs attributes, one item per block
  const result = spawnSync('secret-tool', [
    'search',
    '--all',
    'service', SERVICE,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    return [];
  }

  const output = result.stdout?.toString() || '';
  const items: string[] = [];

  // Parse output format:
  // [/org/freedesktop/secrets/collection/login/1]
  // label = agents-cli: myitem
  // ...
  // attribute.item = myitem
  const itemRegex = /attribute\.item\s*=\s*(.+)/g;
  let match;
  while ((match = itemRegex.exec(output)) !== null) {
    const itemName = match[1].trim();
    if (itemName.startsWith(prefix)) {
      items.push(itemName);
    }
  }

  return [...new Set(items)]; // dedupe
}

/** KeychainBackend implementation for Linux using secret-tool */
export const linuxBackend: KeychainBackend = {
  has(item: string): boolean {
    return hasSecretToolToken(item);
  },
  get(item: string): string {
    return getSecretToolToken(item);
  },
  set(item: string, value: string): void {
    setSecretToolToken(item, value);
  },
  delete(item: string): boolean {
    return deleteSecretToolToken(item);
  },
  list(prefix: string): string[] {
    return listSecretToolItems(prefix);
  },
};
