import { describe, expect, it } from 'vitest';
import { buildRushSendArgs, rushProviders, RUSH_CHANNELS } from './rush.js';

describe('buildRushSendArgs', () => {
  it('builds the rush send argv with required channel/id and --json', () => {
    const args = buildRushSendArgs('telegram', 'hello', { target: '6078999250' });
    expect(args).toEqual(['send', 'hello', '--channel', 'telegram', '--id', '6078999250', '--json']);
  });

  it('appends --thread and repeatable --attachment', () => {
    const args = buildRushSendArgs('slack', 'hi', {
      target: 'C0123',
      thread: '1712345678.000100',
      attachments: ['/a.pdf', '/b.png'],
    });
    expect(args).toContain('--thread');
    expect(args[args.indexOf('--thread') + 1]).toBe('1712345678.000100');
    expect(args.filter((a) => a === '--attachment')).toHaveLength(2);
    expect(args).toContain('/a.pdf');
    expect(args).toContain('/b.png');
  });
});

describe('rushProviders', () => {
  it('exposes one provider per rush channel, named by channel', () => {
    expect(rushProviders.map((p) => p.name).sort()).toEqual([...RUSH_CHANNELS].sort());
  });

  it('dry-run short-circuits without shelling out', async () => {
    const tg = rushProviders.find((p) => p.name === 'telegram')!;
    const res = await tg.send('hi', { target: '6078999250', dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.channel).toBe('telegram');
    expect(res.id).toBe('6078999250');
  });
});
