import type { CDPClient } from './cdp.js';
import type { RefNode } from './refs.js';

const BEFOREINPUT_INSERT_FN = `(function(text) {
  this.focus();
  var sel = window.getSelection();
  var range = document.createRange();
  range.selectNodeContents(this);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  this.dispatchEvent(new InputEvent('beforeinput', {
    inputType: 'insertText',
    data: text,
    bubbles: true,
    cancelable: true,
    composed: true,
  }));
})`;

const BEFOREINPUT_CLEAR_FN = `(function() {
  this.focus();
  var sel = window.getSelection();
  var range = document.createRange();
  range.selectNodeContents(this);
  sel.removeAllRanges();
  sel.addRange(range);
  this.dispatchEvent(new InputEvent('beforeinput', {
    inputType: 'deleteContentBackward',
    bubbles: true,
    cancelable: true,
    composed: true,
  }));
})`;

const TRIX_INSERT_FN = `(function(text) { this.editor.insertString(text); })`;

export async function typeEditorText(
  cdp: CDPClient,
  sessionId: string,
  node: RefNode,
  text: string,
  clear = false
): Promise<void> {
  const { object } = await cdp.send<{ object: { objectId?: string } }>(
    'DOM.resolveNode',
    { backendNodeId: node.backendNodeId },
    sessionId
  );
  if (!object.objectId) throw new Error(`Could not resolve DOM node for ref ${node.ref}`);
  const objectId = object.objectId;
  try {
    if (node.editor === 'trix') {
      await cdp.send(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: TRIX_INSERT_FN, arguments: [{ value: text }], returnByValue: true },
        sessionId
      );
      return;
    }
    if (clear) {
      await cdp.send(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: BEFOREINPUT_CLEAR_FN, arguments: [], returnByValue: true },
        sessionId
      );
    }
    await cdp.send(
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: BEFOREINPUT_INSERT_FN, arguments: [{ value: text }], returnByValue: true },
      sessionId
    );
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId }, sessionId);
  }
}
