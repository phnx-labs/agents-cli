import type { CDPClient } from './cdp.js';

export interface RefOpts {
  interactive?: boolean;
  limit?: number;
  compact?: boolean;
}

interface AXNode {
  nodeId: string;
  role: { value: string };
  name?: { value: string };
  properties?: Array<{ name: string; value: { value: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface RefNode {
  ref: number;
  role: string;
  name: string;
  attrs: string[];
  backendNodeId?: number;
  editor?: string;
}

/**
 * Stable, navigation-surviving identity for a ref. Unlike {@link RefNode}, this
 * carries no `backendNodeId` (which goes stale the moment the DOM re-renders) —
 * only the accessible descriptor a fresh `getRefs` can be re-matched against.
 * Cached in per-task state so a later `click <ref>` can self-heal when the
 * integer ref has drifted (see {@link healRef}).
 */
export interface RefDescriptor {
  ref: number;
  role: string;
  name: string;
  attrs: string[];
  /**
   * Best-effort CSS selector captured via DOM. Reserved for future
   * selector-based healing; matching today is role+name only.
   */
  selector?: string;
}

/** Snapshot the stable descriptor for every ref in a freshly-built node map. */
export function describeRefs(nodeMap: Map<number, RefNode>): RefDescriptor[] {
  return Array.from(nodeMap.values()).map((n) => ({
    ref: n.ref,
    role: n.role,
    name: n.name,
    attrs: n.attrs.slice(),
  }));
}

/**
 * Re-resolve a stale ref against a freshly-built node map by matching the
 * cached (role, name) descriptor. Pure — no CDP, no DOM.
 *
 * The integer ref assigned by {@link getRefs} is positional: it shifts whenever
 * the accessibility tree changes (navigation, re-render, or even a different
 * `interactive` filter). The descriptor's (role, name) pair is the stable
 * identity, so we scan the fresh map for the node that still carries it.
 *
 * Returns the new integer ref, or `null` when no node with the same role+name
 * exists in the fresh map (unhealable — the element is genuinely gone).
 */
export function healRef(
  descriptor: Pick<RefDescriptor, 'role' | 'name'>,
  freshNodeMap: Map<number, RefNode>
): number | null {
  const { role, name } = descriptor;
  // Prefer a match that still has a DOM backing (resolvable to coordinates);
  // fall back to a role+name match without one so we never fail a heal that a
  // strict variant would have found.
  let fallback: number | null = null;
  for (const node of freshNodeMap.values()) {
    if (node.role !== role || node.name !== name) continue;
    if (node.backendNodeId !== undefined) return node.ref;
    if (fallback === null) fallback = node.ref;
  }
  return fallback;
}

const EDITOR_DETECT_FN = `(function() {
  let el = this;
  for (let i = 0; i < 5; i++) {
    if (!el || el === document.documentElement) break;
    if (el.hasAttribute && el.hasAttribute('data-lexical-editor')) return 'lexical';
    if (el.classList && el.classList.contains('ProseMirror')) return 'prosemirror';
    if (el.hasAttribute && el.hasAttribute('data-slate-editor')) return 'slate';
    if (el.classList && Array.from(el.classList).some(function(c) { return /^DraftEditor-/.test(c); })) return 'draft';
    if (el.classList && el.classList.contains('ql-editor')) return 'quill';
    if (el.classList && el.classList.contains('ck-editor__editable')) return 'ckeditor5';
    if (el.tagName === 'TRIX-EDITOR') return 'trix';
    el = el.parentElement;
  }
  return null;
})`;

async function detectEditorForNode(
  cdp: CDPClient,
  sessionId: string,
  backendNodeId: number
): Promise<string | undefined> {
  const { object } = await cdp.send<{ object: { objectId?: string } }>(
    'DOM.resolveNode',
    { backendNodeId },
    sessionId
  );
  if (!object.objectId) return undefined;
  const objectId = object.objectId;
  try {
    const { result } = await cdp.send<{ result: { value: string | null } }>(
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: EDITOR_DETECT_FN, returnByValue: true },
      sessionId
    );
    return result.value ?? undefined;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId }, sessionId);
  }
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'tab',
  'slider',
  'spinbutton',
  'searchbox',
  'switch',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
]);

export async function getRefs(
  cdp: CDPClient,
  sessionId: string,
  opts: RefOpts = {}
): Promise<{ refs: string; nodeMap: Map<number, RefNode> }> {
  const { interactive = true, limit = 500, compact = false } = opts;

  const { nodes } = (await cdp.send(
    'Accessibility.getFullAXTree',
    {},
    sessionId
  )) as { nodes: AXNode[] };

  const nodeMap = new Map<number, RefNode>();
  const lines: string[] = [];
  let refCounter = 1;

  for (const node of nodes) {
    if (refCounter > limit) break;

    const role = node.role?.value?.toLowerCase() || '';
    if (!role || role === 'none' || role === 'generic') continue;
    if (interactive && !INTERACTIVE_ROLES.has(role)) continue;

    const name = node.name?.value || '';
    const attrs: string[] = [];

    for (const prop of node.properties || []) {
      const propName = prop.name;
      const propValue = prop.value?.value;
      if (propName === 'disabled' && propValue === true) attrs.push('disabled');
      if (propName === 'checked' && propValue === true) attrs.push('checked');
      if (propName === 'selected' && propValue === true) attrs.push('selected');
      if (propName === 'expanded' && propValue === true) attrs.push('expanded');
      if (propName === 'required' && propValue === true) attrs.push('required');
      if (propName === 'readonly' && propValue === true) attrs.push('readonly');
      if (propName === 'invalid' && propValue === true) attrs.push('invalid');
    }

    const ref = refCounter++;
    const refNode: RefNode = {
      ref,
      role,
      name,
      attrs,
      backendNodeId: node.backendDOMNodeId,
    };

    if (role === 'textbox' && node.backendDOMNodeId) {
      const editor = await detectEditorForNode(cdp, sessionId, node.backendDOMNodeId);
      if (editor) refNode.editor = editor;
    }

    nodeMap.set(ref, refNode);

    const attrStr = attrs.length > 0 ? ` [${attrs.join('] [')}]` : '';
    const editorStr = refNode.editor ? ` [editor=${refNode.editor}]` : '';
    const nameStr = name ? ` "${truncate(name, 50)}"` : '';
    const line = compact
      ? `${role}${nameStr} [ref=${ref}]${attrStr}${editorStr}`
      : `- ${role}${nameStr} [ref=${ref}]${attrStr}${editorStr}`;
    lines.push(line);
  }

  return { refs: lines.join('\n'), nodeMap };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export async function resolveRefToCoords(
  cdp: CDPClient,
  sessionId: string,
  nodeMap: Map<number, RefNode>,
  ref: number
): Promise<{ x: number; y: number }> {
  const node = nodeMap.get(ref);
  if (!node) throw new Error(`Ref ${ref} not found`);
  if (!node.backendNodeId) throw new Error(`Ref ${ref} has no DOM node`);

  const { model } = (await cdp.send(
    'DOM.getBoxModel',
    { backendNodeId: node.backendNodeId },
    sessionId
  )) as { model: { content: number[] } };

  const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
  const centerX = (x1 + x2 + x3 + x4) / 4;
  const centerY = (y1 + y2 + y3 + y4) / 4;

  return { x: centerX, y: centerY };
}
