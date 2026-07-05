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

describe('healRef — duplicate (role,name) disambiguation', () => {
  it('tie-breaks on cached attrs so the right twin wins even when farther', () => {
    // Cached ref 5 was the DISABLED "Submit". A (role,name)-only heal would
    // grab whichever Submit it hit first — here the nearer, ENABLED one at
    // ref 4 — and silently click the wrong element.
    const cached = { ref: 5, role: 'button', name: 'Submit', attrs: ['disabled'] };
    const fresh = new Map<number, RefNode>([
      [4, { ref: 4, role: 'button', name: 'Submit', attrs: [], backendNodeId: 404 }],
      [9, { ref: 9, role: 'button', name: 'Submit', attrs: ['disabled'], backendNodeId: 909 }],
    ]);
    expect(healRef(cached, fresh)).toBe(9);
  });

  it('tie-breaks on positional proximity when attrs are identical', () => {
    // Repeated list-row action: two identical "Delete" buttons. The one
    // nearest the original ref index is the intended twin.
    const cached = { ref: 5, role: 'button', name: 'Delete', attrs: [] };
    const fresh = new Map<number, RefNode>([
      [4, { ref: 4, role: 'button', name: 'Delete', attrs: [], backendNodeId: 404 }],
      [9, { ref: 9, role: 'button', name: 'Delete', attrs: [], backendNodeId: 909 }],
    ]);
    expect(healRef(cached, fresh)).toBe(4);
  });

  it('attrs outrank proximity — the exact-state twin wins over the nearer one', () => {
    const cached = { ref: 2, role: 'checkbox', name: 'Agree', attrs: ['checked'] };
    const fresh = new Map<number, RefNode>([
      [1, { ref: 1, role: 'checkbox', name: 'Agree', attrs: [], backendNodeId: 11 }], // nearer, wrong state
      [8, { ref: 8, role: 'checkbox', name: 'Agree', attrs: ['checked'], backendNodeId: 88 }], // farther, exact
    ]);
    expect(healRef(cached, fresh)).toBe(8);
  });
});

describe('drift across a refs-once-then-many-clicks sequence', () => {
  it('heals on EVERY click because the cached listing is never clobbered', () => {
    // `browser refs` (interactive numbering): Submit is ref 5. This snapshot is
    // owned by refs() — click()/type() read it and must never overwrite it.
    const listing = new Map<number, RefNode>([
      [4, node(4, 'link', 'Home', 104)],
      [5, node(5, 'button', 'Submit', 105)],
    ]);
    const snapshot = describeRefs(listing);

    // The page re-rendered: Submit drifted to ref 8; ref 5 is now a different
    // button. Both clicks rebuild against this same fresh tree.
    const afterRerender = new Map<number, RefNode>([
      [5, node(5, 'button', 'Cancel', 205)],
      [8, node(8, 'button', 'Submit', 208)],
    ]);

    const cachedForRef5 = () => snapshot.find((d) => d.ref === 5)!;

    // First click heals 5 -> 8.
    expect(healRef(cachedForRef5(), afterRerender)).toBe(8);
    // Second click reads the SAME untouched snapshot and heals 5 -> 8 again.
    // The old bug re-cached descriptors from the post-click map, so ref 5's
    // cached descriptor became "Cancel" and the second click stopped healing
    // and silently hit the wrong element.
    expect(cachedForRef5()).toMatchObject({ role: 'button', name: 'Submit' });
    expect(healRef(cachedForRef5(), afterRerender)).toBe(8);
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
