import { describe, expect, it } from 'vitest';
import { describeRefs, healRef, type RefNode } from './refs.js';

function node(ref: number, role: string, name: string, backendNodeId?: number): RefNode {
  return { ref, role, name, attrs: [], backendNodeId };
}

describe('healRef', () => {
  it('re-resolves to the new ref when the integer drifted but (role,name) is stable', () => {
    // Cached from an earlier getRefs: ref 1 was the Submit button.
    const cached = { ref: 1, role: 'button', name: 'Submit', attrs: [] };

    // Fresh tree (e.g. after a re-render / different interactive filter): the
    // same button now sits at ref 3, and ref 1 is a different element.
    const fresh = new Map<number, RefNode>([
      [1, node(1, 'heading', 'Welcome', 101)],
      [2, node(2, 'link', 'Home', 102)],
      [3, node(3, 'button', 'Submit', 103)],
    ]);

    expect(healRef(cached, fresh)).toBe(3);
  });

  it('reports unhealable (null) when no node shares the cached role+name', () => {
    const cached = { ref: 1, role: 'button', name: 'Submit', attrs: [] };
    const fresh = new Map<number, RefNode>([
      [1, node(1, 'button', 'Cancel', 201)],
      [2, node(2, 'link', 'Submit', 202)], // same name, wrong role
    ]);

    expect(healRef(cached, fresh)).toBeNull();
  });

  it('prefers a DOM-backed match over a role+name match with no backendNodeId', () => {
    const cached = { ref: 5, role: 'button', name: 'Save', attrs: [] };
    const fresh = new Map<number, RefNode>([
      [1, node(1, 'button', 'Save')], // no backendNodeId
      [2, node(2, 'button', 'Save', 302)], // resolvable — should win
    ]);

    expect(healRef(cached, fresh)).toBe(2);
  });

  it('still heals to a role+name match that lacks a backendNodeId when that is all there is', () => {
    const cached = { ref: 5, role: 'textbox', name: 'Email', attrs: [] };
    const fresh = new Map<number, RefNode>([[7, node(7, 'textbox', 'Email')]]);

    expect(healRef(cached, fresh)).toBe(7);
  });
});

describe('describeRefs', () => {
  it('captures the stable (role,name,attrs) identity without the backendNodeId', () => {
    const nodeMap = new Map<number, RefNode>([
      [1, { ref: 1, role: 'button', name: 'Submit', attrs: ['disabled'], backendNodeId: 42 }],
    ]);

    const descriptors = describeRefs(nodeMap);
    expect(descriptors).toEqual([{ ref: 1, role: 'button', name: 'Submit', attrs: ['disabled'] }]);
    // backendNodeId must not leak into the persisted descriptor.
    expect('backendNodeId' in descriptors[0]).toBe(false);
  });
});
