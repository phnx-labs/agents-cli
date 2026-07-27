/**
 * OpenClaw Telegram provider — the mac-mini path.
 *
 * A DISTINCT provider from the rush-backed `telegram` (not a fallback): it
 * reuses the existing openclaw argv builder (lib/notify.ts). Hosts that have
 * openclaw on PATH (mac-mini) can map `transports.telegram: openclaw-telegram`;
 * hosts with a live rush daemon (zion) map `transports.telegram: telegram`.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildOpenClawNotifyArgs } from '../../notify.js';
import type { ChannelProvider, SendOptions, SendResult } from '../registry.js';

const execFileAsync = promisify(execFile);

export const openclawTelegramProvider: ChannelProvider = {
  name: 'openclaw-telegram',
  async send(text: string, opts: SendOptions): Promise<SendResult> {
    const name = 'openclaw-telegram';
    if (opts.dryRun) {
      return { ok: true, channel: name, id: opts.target };
    }
    try {
      await execFileAsync('which', ['openclaw']);
    } catch {
      return { ok: false, channel: name, id: opts.target, error: 'openclaw CLI not found on PATH' };
    }
    try {
      await execFileAsync('openclaw', buildOpenClawNotifyArgs(text, { channel: 'telegram', target: opts.target }));
      return { ok: true, channel: name, id: opts.target };
    } catch (err) {
      return { ok: false, channel: name, id: opts.target, error: (err as Error).message };
    }
  },
};
