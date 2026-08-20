/**
 * Client for the Rush account layer (`api.prix.dev`) — backs `agents auth` and
 * `agents org`. `agents org` maps to `/api/v1/spaces`, not `/api/v1/orgs`: spaces
 * already carry the free-tier caps (1 owned space, 3 members) and can exist
 * standalone with no parent organization, matching a "just want a team" CLI flow
 * better than the heavier enterprise-tenancy `orgs` routes (domain, SSO). See
 * `.agents/artifacts/2026-08-20/agi-cli-client-integration-spec.md` §4.2 in the
 * agi-cli-web repo for the full reasoning and the live-confirmed route/shape audit.
 *
 * Token custody: `agents auth login` writes its own session file
 * (`getPrixSessionFile()`), separate from `~/.rush/user.yaml`, so `agents auth
 * logout` never signs the user out of `rush` (the two CLIs share a backend
 * account, not a credential store). Reads fall back to `~/.rush/user.yaml`
 * (the pattern `readRushToken` in `lib/secrets/drivers/rush.ts` already uses)
 * so a user who is only signed in via `rush login` still gets a working
 * `agents auth whoami` / `agents org` with zero extra login step.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { getRuntimeStateDir } from './state.js';

export const PRIX_API_BASE = 'https://api.prix.dev';

const RUSH_USER_YAML = path.join(os.homedir(), '.rush', 'user.yaml');

/** Computed per-call (not cached at module load) so `AGENTS_STATE_DIR` overrides in tests take effect. */
function prixSessionFile(): string {
  return path.join(getRuntimeStateDir(), 'prix-account.json');
}

interface RushUserYaml {
  session?: { access_token?: string };
}

/** Read the token `rush login` wrote, with no expiry check — the same shape `readRushToken` reads. */
function readRushSessionToken(): string | null {
  if (!fs.existsSync(RUSH_USER_YAML)) return null;
  try {
    const data = yaml.parse(fs.readFileSync(RUSH_USER_YAML, 'utf-8')) as RushUserYaml;
    return data?.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** The session `agents auth login` owns. */
export interface PrixSession {
  access_token: string;
  refresh_token?: string;
  /** Unix ms. */
  expires_at?: number;
  email?: string;
  userId?: string;
}

export function getPrixSessionFile(): string {
  return prixSessionFile();
}

export function readPrixSession(): PrixSession | null {
  const file = prixSessionFile();
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed.access_token !== 'string') return null;
    return parsed as PrixSession;
  } catch {
    return null;
  }
}

export function writePrixSession(session: PrixSession): void {
  const file = prixSessionFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function clearPrixSession(): boolean {
  const file = prixSessionFile();
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/** Where the caller's Bearer token came from — surfaced by `whoami` so the user knows which login is live. */
export type PrixTokenSource = 'agents' | 'rush';

export function resolvePrixToken(): { token: string; source: PrixTokenSource } | null {
  const own = readPrixSession();
  if (own?.access_token) return { token: own.access_token, source: 'agents' };
  const rushToken = readRushSessionToken();
  if (rushToken) return { token: rushToken, source: 'rush' };
  return null;
}

export class PrixApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'PrixApiError';
  }
}

async function prixRequest<T>(method: string, endpoint: string, opts: { token?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const auth = opts.auth !== false;
  let token = opts.token;
  if (auth && !token) {
    const resolved = resolvePrixToken();
    if (!resolved) throw new Error("Not signed in. Run 'agents auth login' first.");
    token = resolved.token;
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${PRIX_API_BASE}${endpoint}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message = (data && typeof data === 'object' && 'error' in data) ? String((data as { error: unknown }).error) : `${res.status} ${res.statusText}`;
    throw new PrixApiError(res.status, message);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface WhoAmI {
  userId: string;
  email: string;
  valid: true;
}

/** `GET /api/v1/auth/me` — live-confirmed shape: `{email, userId, valid}`. */
export async function fetchWhoAmI(token?: string): Promise<WhoAmI> {
  return prixRequest<WhoAmI>('GET', '/api/v1/auth/me', { token });
}

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** `POST /api/v1/auth/device/authorization` — public, no token. */
export async function startDeviceAuthorization(): Promise<DeviceAuthorization> {
  return prixRequest<DeviceAuthorization>('POST', '/api/v1/auth/device/authorization', { auth: false, body: {} });
}

export type DeviceTokenPoll =
  | { status: 'authorized'; access_token: string; refresh_token?: string; expires_in?: number; user: { email: string; id: string } }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'denied' };

/** `POST /api/v1/auth/device/token` — one poll attempt. Callers own the interval loop. */
export async function pollDeviceToken(deviceCode: string): Promise<DeviceTokenPoll> {
  try {
    const data = await prixRequest<{ access_token: string; refresh_token?: string; expires_in?: number; user: { email: string; id: string } }>(
      'POST',
      '/api/v1/auth/device/token',
      { auth: false, body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode } },
    );
    return { status: 'authorized', ...data };
  } catch (err) {
    if (err instanceof PrixApiError) {
      if (err.message.includes('authorization_pending')) return { status: 'pending' };
      if (err.message.includes('slow_down')) return { status: 'slow_down' };
      if (err.message.includes('expired_token')) return { status: 'expired' };
      if (err.message.includes('access_denied')) return { status: 'denied' };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Spaces (`agents org`)
// ---------------------------------------------------------------------------

export interface SpaceSummary {
  id: string;
  slug: string;
  name: string;
  organization_id: string | null;
  owner_user_id: string;
  invite_code?: string;
  user_role: 'owner' | 'admin' | 'member';
  created_at: string;
}

export interface SpaceMember {
  user_id: string;
  email: string;
  name?: string;
  avatar_url?: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
}

/** `GET /api/v1/spaces` — live-confirmed: array of `SpaceSummary`. */
export async function listSpaces(): Promise<SpaceSummary[]> {
  return prixRequest<SpaceSummary[]>('GET', '/api/v1/spaces');
}

/** `POST /api/v1/spaces` — 403 if the caller already owns a space (free tier: 1). */
export async function createSpace(input: { name: string; slug: string; description?: string }): Promise<SpaceSummary> {
  return prixRequest<SpaceSummary>('POST', '/api/v1/spaces', { body: input });
}

/** `GET /api/v1/spaces/:id` — requires membership. */
export async function getSpace(spaceId: string): Promise<SpaceSummary> {
  return prixRequest<SpaceSummary>('GET', `/api/v1/spaces/${encodeURIComponent(spaceId)}`);
}

/** `GET /api/v1/spaces/:id/members`. */
export async function listSpaceMembers(spaceId: string): Promise<SpaceMember[]> {
  return prixRequest<SpaceMember[]>('GET', `/api/v1/spaces/${encodeURIComponent(spaceId)}/members`);
}

export type CreateSpaceInviteResult =
  | { invited: true; email: string; role: string; member_added: true }
  | { invited: true; email: string; role: string; invite_code: string; member_added?: false };

/** `POST /api/v1/spaces/:id/invites` — sends a real email for the pending-invite path. */
export async function createSpaceInvite(spaceId: string, email: string, role: 'admin' | 'member' = 'member'): Promise<CreateSpaceInviteResult> {
  return prixRequest<CreateSpaceInviteResult>('POST', `/api/v1/spaces/${encodeURIComponent(spaceId)}/invites`, { body: { email, role } });
}

export interface SpaceInvite {
  id: string;
  space_id: string;
  email: string;
  role: 'admin' | 'member';
  invite_code: string;
  created_at: string;
}

/** `GET /api/v1/spaces/:id/invites`. */
export async function listSpaceInvites(spaceId: string): Promise<SpaceInvite[]> {
  return prixRequest<SpaceInvite[]>('GET', `/api/v1/spaces/${encodeURIComponent(spaceId)}/invites`);
}

/** `DELETE /api/v1/spaces/:id/invites/:inviteId`. */
export async function revokeSpaceInvite(spaceId: string, inviteId: string): Promise<{ revoked: true }> {
  return prixRequest<{ revoked: true }>('DELETE', `/api/v1/spaces/${encodeURIComponent(spaceId)}/invites/${encodeURIComponent(inviteId)}`);
}

/** `PATCH /api/v1/spaces/:id/members/:userId` — owner-only for admin changes. Route takes userId, not email. */
export async function updateSpaceMemberRole(spaceId: string, userId: string, role: 'admin' | 'member'): Promise<{ user_id: string; role: string; updated: true }> {
  return prixRequest('PATCH', `/api/v1/spaces/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(userId)}`, { body: { role } });
}

/** `DELETE /api/v1/spaces/:id/members/:userId` — owner, admin, or the member themself (leave). */
export async function removeSpaceMember(spaceId: string, userId: string): Promise<void> {
  await prixRequest('DELETE', `/api/v1/spaces/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(userId)}`);
}

/** `DELETE /api/v1/spaces/:id` — soft delete, 30-day restore window. */
export async function deleteSpace(spaceId: string): Promise<void> {
  await prixRequest('DELETE', `/api/v1/spaces/${encodeURIComponent(spaceId)}`);
}

/** `agents-cli-space-name` -> `agi-cli-space-name`; lowercase, hyphenated, matches the backend's `^[a-z0-9-]+$` slug rule. */
export function slugify(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'space';
}

/**
 * Resolve the `--space` a command should act on: an explicit id/slug match
 * against the caller's own space list, or — with nothing passed — the
 * caller's sole space (free tier caps ownership at one, so this is almost
 * always unambiguous). Pure over an already-fetched list so it's cheaply
 * unit-testable with a fixture.
 */
export function resolveSpaceFromList(spaces: SpaceSummary[], explicit?: string): SpaceSummary {
  if (explicit) {
    const match = spaces.find(s => s.id === explicit || s.slug === explicit);
    if (!match) throw new Error(`No space matching '${explicit}'. Run 'agents org list' to see your spaces.`);
    return match;
  }
  if (spaces.length === 0) throw new Error("You have no spaces. Create one with 'agents org create <name>'.");
  if (spaces.length > 1) {
    throw new Error(`You belong to ${spaces.length} spaces — pass --space <id-or-slug>: ${spaces.map(s => s.slug).join(', ')}`);
  }
  return spaces[0];
}

/** Resolve a member's email to their `user_id` from an already-fetched member list. */
export function resolveMemberFromList(members: SpaceMember[], email: string): SpaceMember {
  const match = members.find(m => m.email.toLowerCase() === email.toLowerCase());
  if (!match) throw new Error(`'${email}' is not a member of this space. Run 'agents org members' to see who is.`);
  return match;
}
