import { shellQuote } from './ssh-exec.js';

export const FUNNEL_PORTS = [443, 8443, 10000] as const;
export type FunnelPort = typeof FUNNEL_PORTS[number];

export function parseFunnelPort(value: string | number): FunnelPort {
  const port = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (FUNNEL_PORTS.includes(port as FunnelPort)) return port as FunnelPort;
  throw new Error(`Tailscale Funnel public port must be one of: ${FUNNEL_PORTS.join(', ')}`);
}

export function buildFunnelStatusCommand(): string {
  return 'tailscale funnel status';
}

export function buildFunnelUpCommand(publicPort: FunnelPort, localPort: number): string {
  if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65535) {
    throw new Error('Local port must be between 1 and 65535');
  }
  return [
    'tailscale',
    'funnel',
    '--bg',
    `--https=${publicPort}`,
    `http://localhost:${localPort}`,
  ].map(shellQuote).join(' ');
}
