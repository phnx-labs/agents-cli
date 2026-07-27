/**
 * Rush-daemon channel providers — telegram / imessage / slack / discord.
 *
 * These shell out to the already-built `rush send` CLI, which routes through the
 * rush daemon's live channel gateways over ~/.rush/daemon.sock. We do NOT import
 * rush's Go internals (different repo, internal package) — the CLI boundary is
 * the contract. `rush send --json` prints {"ok":true,"channel":..,"id":..}.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ChannelProvider, SendOptions, SendResult } from '../registry.js';

const execFileAsync = promisify(execFile);

export type RushChannel = 'telegram' | 'imessage' | 'slack' | 'discord';
export const RUSH_CHANNELS: RushChannel[] = ['telegram', 'imessage', 'slack', 'discord'];

/** Build the `rush send` argv (exported for tests). */
export function buildRushSendArgs(channel: RushChannel, text: string, opts: SendOptions): string[] {
  const args = ['send', text, '--channel', channel, '--id', opts.target, '--json'];
  if (opts.thread) args.push('--thread', opts.thread);
  for (const a of opts.attachments ?? []) args.push('--attachment', a);
  return args;
}

function rushProvider(channel: RushChannel): ChannelProvider {
  return {
    name: channel,
    async send(text: string, opts: SendOptions): Promise<SendResult> {
      if (opts.dryRun) {
        return { ok: true, channel, id: opts.target, attachments: opts.attachments };
      }
      // Preflight: rush must be on PATH (mirrors notify.ts's openclaw check).
      try {
        await execFileAsync('which', ['rush']);
      } catch {
        return { ok: false, channel, id: opts.target, error: 'rush CLI not found on PATH' };
      }
      try {
        const { stdout } = await execFileAsync('rush', buildRushSendArgs(channel, text, opts));
        const parsed = JSON.parse(stdout) as { ok?: boolean; attachments?: string[] };
        return {
          ok: parsed.ok === true,
          channel,
          id: opts.target,
          attachments: parsed.attachments,
          error: parsed.ok === true ? undefined : 'rush send returned ok=false',
        };
      } catch (err) {
        // Daemon down surfaces here as the exec error (ErrDaemonDown), as does a
        // non-JSON stdout (parse throw). Fail loud — never silently reroute.
        return { ok: false, channel, id: opts.target, error: (err as Error).message };
      }
    },
  };
}

export const rushProviders: ChannelProvider[] = RUSH_CHANNELS.map(rushProvider);
