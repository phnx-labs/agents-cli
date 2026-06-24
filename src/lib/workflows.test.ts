import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseLoopBlock, parseWorkflowFrontmatter } from './workflows.js';

describe('parseLoopBlock — defensive coercion (issue #332)', () => {
  it('parses a well-formed loop block', () => {
    expect(parseLoopBlock({ until: 'signal', max_iterations: 3, budget: 500000, interval: '30m' }))
      .toEqual({ until: 'signal', max_iterations: 3, budget: 500000, interval: '30m' });
  });

  it('returns undefined when the block is absent or not an object', () => {
    expect(parseLoopBlock(undefined)).toBeUndefined();
    expect(parseLoopBlock(null)).toBeUndefined();
    expect(parseLoopBlock('signal')).toBeUndefined();
    expect(parseLoopBlock([1, 2])).toBeUndefined();
  });

  it('drops an unknown until value (only `signal` is valid)', () => {
    expect(parseLoopBlock({ until: 'whenever', max_iterations: 2 }))
      .toEqual({ max_iterations: 2 });
  });

  it('drops a non-integer / non-positive max_iterations', () => {
    expect(parseLoopBlock({ max_iterations: 2.5 })).toBeUndefined();
    expect(parseLoopBlock({ max_iterations: 0 })).toBeUndefined();
    expect(parseLoopBlock({ max_iterations: -3 })).toBeUndefined();
    expect(parseLoopBlock({ max_iterations: '5' })).toBeUndefined(); // string, not number
  });

  it('drops a non-positive or non-numeric budget', () => {
    expect(parseLoopBlock({ budget: 0 })).toBeUndefined();
    expect(parseLoopBlock({ budget: -1 })).toBeUndefined();
    expect(parseLoopBlock({ budget: 'lots' })).toBeUndefined();
  });

  it('drops a non-string interval', () => {
    expect(parseLoopBlock({ interval: 30 })).toBeUndefined();
    expect(parseLoopBlock({ interval: '0' })).toEqual({ interval: '0' });
  });

  it('returns undefined when an all-garbage block leaves no recognized field', () => {
    expect(parseLoopBlock({ until: 'nope', max_iterations: -1, budget: 'x', interval: 5 }))
      .toBeUndefined();
  });
});

describe('parseWorkflowFrontmatter — loop block', () => {
  function writeWorkflow(frontmatter: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-wf-loop-test-'));
    fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), `---\n${frontmatter}\n---\nbody\n`, 'utf-8');
    return dir;
  }

  it('parses a declared loop block from real WORKFLOW.md frontmatter', () => {
    const dir = writeWorkflow([
      'name: cluster-feedback',
      'description: cluster mentions',
      'loop:',
      '  until: signal',
      '  max_iterations: 3',
      '  budget: 500000',
      '  interval: "0"',
    ].join('\n'));
    const fm = parseWorkflowFrontmatter(dir)!;
    expect(fm.loop).toEqual({ until: 'signal', max_iterations: 3, budget: 500000, interval: '0' });
  });

  it('leaves loop undefined when no loop block is present', () => {
    const dir = writeWorkflow('name: plain\ndescription: no loop');
    const fm = parseWorkflowFrontmatter(dir)!;
    expect(fm.loop).toBeUndefined();
  });

  it('drops a malformed loop block rather than passing a bad shape to the driver', () => {
    const dir = writeWorkflow([
      'name: bad',
      'description: bad loop',
      'loop:',
      '  until: forever',
      '  max_iterations: -1',
    ].join('\n'));
    const fm = parseWorkflowFrontmatter(dir)!;
    expect(fm.loop).toBeUndefined();
  });
});
