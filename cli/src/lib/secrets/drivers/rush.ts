/**
 * Rush `SyncBackend` driver — the original (and currently default) transport
 * for `agents secrets push/pull`. Talks to api.prix.dev and authenticates with
 * the session token written by `rush login` (`~/.rush/user.yaml`).
 *
 * This is the ONE place in the secrets module allowed to reference Rush
 * (api.prix.dev / ~/.rush). It is an opt-in driver kept for backwards
 * compatibility with bundles already pushed to Rush; `sync.ts` selects it as
 * the default but the transport seam (`SyncBackend`) lets other backends drop
 * in without touching the crypto or push/pull logic.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import type { SyncBackend, SyncEnvelope, RemoteBundleSummary } from '../sync-backend.js';

const PROXY_BASE = 'https://api.prix.dev';
const USER_YAML = path.join(os.homedir(), '.rush', 'user.yaml');
const BUNDLE_ENDPOINT = '/api/v1/secrets/bundles';

interface RushUserYaml {
  session?: {
    access_token?: string;
  };
}

function readRushToken(): string {
  if (!fs.existsSync(USER_YAML)) {
    throw new Error('Not logged in to Rush. Run `rush login` first.');
  }
  const raw = fs.readFileSync(USER_YAML, 'utf-8');
  const data = yaml.parse(raw) as RushUserYaml;
  const token = data?.session?.access_token;
  if (!token) {
    throw new Error('No session token in ~/.rush/user.yaml. Run `rush login` first.');
  }
  return token;
}

async function api(method: string, endpoint: string, body?: unknown): Promise<Response> {
  const token = readRushToken();
  const url = endpoint.startsWith('http') ? endpoint : `${PROXY_BASE}${endpoint}`;
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function bundlePath(name: string): string {
  return `${BUNDLE_ENDPOINT}/${encodeURIComponent(name)}`;
}

/** The Rush transport. Plaintext never reaches here — only ciphertext envelopes. */
export const rushSyncBackend: SyncBackend = {
  async putEnvelope(name: string, payload: SyncEnvelope): Promise<void> {
    const res = await api('PUT', bundlePath(name), payload);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Push failed (${res.status} ${res.statusText}): ${body}`);
    }
  },

  async getEnvelope(name: string): Promise<SyncEnvelope | null> {
    const res = await api('GET', bundlePath(name));
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Pull failed (${res.status} ${res.statusText}): ${body}`);
    }
    return await res.json() as SyncEnvelope;
  },

  async deleteEnvelope(name: string): Promise<boolean> {
    const res = await api('DELETE', bundlePath(name));
    if (res.status === 404) return false;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Delete failed (${res.status} ${res.statusText}): ${body}`);
    }
    return true;
  },

  async listEnvelopes(): Promise<RemoteBundleSummary[]> {
    const res = await api('GET', BUNDLE_ENDPOINT);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`List failed (${res.status} ${res.statusText}): ${body}`);
    }
    const data = await res.json() as { bundles?: RemoteBundleSummary[] };
    return data.bundles ?? [];
  },
};
