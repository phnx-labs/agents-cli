/**
 * Transport resolution: map a user-facing channel name to the provider that
 * actually delivers it, using `notify.transports` from agents.yaml.
 *
 * Default is name-identity (`--channel slack` -> `slack` provider) — NOT a
 * fallback to a different transport. Only telegram is dual-homed (rush vs
 * openclaw-telegram); config picks. An unmapped-to-unregistered name dies loud.
 */
import type { Meta } from '../types.js';
import { die } from '../format.js';
import { resolveChannelProvider, listChannelProviders, type ChannelProvider } from './registry.js';

export function resolveTransport(channel: string, meta: Meta): ChannelProvider {
  const providerName = meta.notify?.transports?.[channel] ?? channel;
  const provider = resolveChannelProvider(providerName);
  if (!provider) {
    die(
      `No channel provider '${providerName}'` +
        (providerName === channel ? '' : ` (mapped from channel '${channel}' via notify.transports)`) +
        `. Registered: ${listChannelProviders().join(', ')}.`,
    );
  }
  return provider;
}
