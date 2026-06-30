/**
 * Tailscale ingestion for the device registry.
 *
 * `tailscale status --json` already hands us most of a device registry for
 * free — per node: `OS` (→ platform), `Online`/`LastSeen` (→ reachability),
 * `Relay` vs `CurAddr` (→ direct-vs-relayed latency hint), `DNSName`, and
 * `TailscaleIPs`. `parseTailscaleStatus` turns that JSON into draft device
 * profiles so `agents devices sync` can self-populate instead of you
 * hand-entering hosts. Kept a pure function (JSON in, profiles out) so it is
 * unit-testable without a live tailnet.
 */
import { spawnSync } from 'child_process';
import {
  type DeviceInput,
  type DevicePlatform,
  platformFromOs,
} from './registry.js';

/** A single node distilled from `tailscale status --json`. */
export interface TailscaleNode {
  name: string;
  platform: DevicePlatform;
  dnsName?: string;
  ip?: string;
  online: boolean;
  direct: boolean;
  relay?: string;
  lastSeen?: string;
}

/** Shape of the bits of a `tailscale status --json` peer/self entry we read. */
interface RawTsNode {
  HostName?: string;
  DNSName?: string;
  OS?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  Relay?: string;
  CurAddr?: string;
  LastSeen?: string;
}

interface RawTsStatus {
  Self?: RawTsNode;
  Peer?: Record<string, RawTsNode>;
}

/** Strip MagicDNS's trailing dot so the name is usable as an ssh HostName. */
function trimDnsDot(dns: string | undefined): string | undefined {
  if (!dns) return undefined;
  return dns.endsWith('.') ? dns.slice(0, -1) : dns;
}

/** First IPv4 in the node's address list (preferred over IPv6 for ssh). */
function firstIpv4(ips: string[] | undefined): string | undefined {
  if (!ips) return undefined;
  return ips.find((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) ?? ips[0];
}

/**
 * Slugify a raw Tailscale HostName into a valid logical device name (ssh alias
 * charset). Used only as a fallback — when a node has a DNSName we prefer its
 * first label, which is the canonical slug Tailscale itself derived.
 */
export function slugifyHostName(hostName: string): string {
  return hostName
    .toLowerCase()
    .replace(/['’"]/g, '') // drop quotes/apostrophes (so "Bisma's" → "bismas", matching MagicDNS)
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The logical name for a node. macOS computer names contain spaces and
 * apostrophes ("Bisma's MacBook Pro") and iOS devices all report HostName
 * "localhost" — both break as ssh aliases and the latter collides in the
 * registry. The MagicDNS label (first segment of DNSName) is already a unique,
 * valid slug per device, so prefer it; fall back to a slugified HostName.
 */
function deviceNameFor(raw: RawTsNode, dnsName: string | undefined): string | null {
  const label = dnsName?.split('.')[0];
  if (label && label.length > 0) return label;
  const host = raw.HostName?.trim();
  if (!host) return null;
  const slug = slugifyHostName(host);
  return slug.length > 0 ? slug : null;
}

function toNode(raw: RawTsNode): TailscaleNode | null {
  const dnsName = trimDnsDot(raw.DNSName);
  const name = deviceNameFor(raw, dnsName);
  if (!name) return null;
  // A non-empty CurAddr means the last handshake was a direct connection;
  // an empty CurAddr with a Relay means traffic is going through DERP.
  const direct = Boolean(raw.CurAddr && raw.CurAddr.length > 0);
  return {
    name,
    platform: platformFromOs(raw.OS),
    dnsName,
    ip: firstIpv4(raw.TailscaleIPs),
    online: Boolean(raw.Online),
    direct,
    relay: raw.Relay || undefined,
    lastSeen: raw.LastSeen,
  };
}

/**
 * Parse `tailscale status --json` output into one node per tailnet device,
 * including Self. Throws on malformed JSON. Nodes without a HostName are
 * skipped (they cannot be addressed by a logical name).
 */
export function parseTailscaleStatus(json: string): TailscaleNode[] {
  let parsed: RawTsStatus;
  try {
    parsed = JSON.parse(json) as RawTsStatus;
  } catch (err: any) {
    throw new Error(`Could not parse tailscale status JSON: ${err?.message ?? err}`);
  }
  const out: TailscaleNode[] = [];
  if (parsed.Self) {
    const self = toNode(parsed.Self);
    if (self) out.push(self);
  }
  for (const raw of Object.values(parsed.Peer ?? {})) {
    const node = toNode(raw);
    if (node) out.push(node);
  }
  return out;
}

/** Turn a parsed Tailscale node into the registry fields it can populate. */
export function nodeToDeviceInput(node: TailscaleNode): DeviceInput {
  return {
    platform: node.platform,
    address: { via: 'tailscale', dnsName: node.dnsName, ip: node.ip },
    tailscale: {
      online: node.online,
      direct: node.direct,
      relay: node.relay,
      lastSeen: node.lastSeen,
    },
  };
}

/**
 * Run `tailscale status --json` and return its raw stdout. Throws a clear
 * error when the binary is missing or the daemon is not reachable.
 */
export function tailscaleStatusJson(): string {
  const res = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf-8' });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error('tailscale not found on PATH. Install Tailscale, or add devices manually with `agents devices add`.');
  }
  if (res.status !== 0) {
    throw new Error(`tailscale status failed: ${(res.stderr || res.stdout || '').trim() || `exit ${res.status}`}`);
  }
  return res.stdout ?? '';
}
