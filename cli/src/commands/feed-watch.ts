import type { Command } from 'commander';
import { machineId } from '../lib/machine-id.js';
import { setHelpSections } from '../lib/help.js';
import { watchFleetFeed, watchLocalFeed, type FeedWatchEnvelope } from '../lib/feed/watch.js';

export function registerFeedWatchCommand(parent: Command): void {
  const command = parent.command('watch').description('Stream the canonical agent, attention, and activity projection as NDJSON')
    .option('--json', 'Emit versioned NDJSON envelopes').option('--local', 'Watch only this machine');
  setHelpSections(command, { examples: `agents feed watch --json\nagents feed watch --json --local`, notes: 'Order by streamId + sequence. Unavailable scopes retain their last rows until reset on reconnect.' });
  command.action(async (_opts, invoked) => {
    const opts = invoked.optsWithGlobals() as { local?: boolean; json?: boolean };
    if (!opts.json) invoked.error("error: required option '--json' not specified");
    const controller = new AbortController();
    const stop = () => controller.abort();
    const emit = (event: FeedWatchEnvelope) => process.stdout.write(`${JSON.stringify(event)}\n`);
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { if (opts.local) await watchLocalFeed({ scope: machineId(), signal: controller.signal, emit }); else await watchFleetFeed({ signal: controller.signal, emit }); }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  });
}
