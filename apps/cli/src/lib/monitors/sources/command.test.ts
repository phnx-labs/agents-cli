import { describe, expect, it } from 'vitest';
import { evaluate } from './command.js';

describe('command source evaluate', () => {
  it('returns stdout as the observation with a zero exit code', async () => {
    const obs = await evaluate({ type: 'command', command: 'echo hello-monitor' });
    expect(obs).not.toBeNull();
    expect(obs!.raw).toBe('hello-monitor');
    expect(obs!.meta?.exitCode).toBe(0);
  });

  it('surfaces a non-zero exit code as a real observation', async () => {
    const obs = await evaluate({ type: 'command', command: 'exit 3' });
    expect(obs).not.toBeNull();
    expect(obs!.meta?.exitCode).toBe(3);
  });

  it('trims trailing whitespace so identical output diffs stably', async () => {
    const a = await evaluate({ type: 'command', command: 'printf "x\\n\\n"' });
    const b = await evaluate({ type: 'command', command: 'printf "x"' });
    expect(a!.raw).toBe('x');
    expect(b!.raw).toBe('x');
  });

  it('returns null when no command is set', async () => {
    expect(await evaluate({ type: 'command' })).toBeNull();
  });
});
