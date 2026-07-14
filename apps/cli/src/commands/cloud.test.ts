import { describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { statusColor } from './cloud.js';

describe('statusColor', () => {
  it('renders idle cloud tasks with the inactive/idle color', () => {
    expect(statusColor('idle')).toBe(chalk.gray);
  });
});
