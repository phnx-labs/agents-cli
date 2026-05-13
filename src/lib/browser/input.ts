import type { CDPClient } from './cdp.js';
import type { RefNode, resolveRefToCoords } from './refs.js';

export async function clickAtCoords(
  cdp: CDPClient,
  sessionId: string,
  x: number,
  y: number
): Promise<void> {
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
    sessionId
  );
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
    sessionId
  );
}

export async function hoverAtCoords(
  cdp: CDPClient,
  sessionId: string,
  x: number,
  y: number
): Promise<void> {
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x, y },
    sessionId
  );
}

export async function scrollAtCoords(
  cdp: CDPClient,
  sessionId: string,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number
): Promise<void> {
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseWheel', x, y, deltaX, deltaY },
    sessionId
  );
}

// `Input.insertText` is the CDP native text-insertion method. It dispatches a
// real `beforeinput`/`input`/`textInput` sequence on the focused element, which
// is what framework-controlled inputs (React, Vue, Solid, contenteditable
// editors) actually listen for. Per-character `dispatchKeyEvent` only fires
// `keydown`/`keyup` with no input event, so controlled inputs ignore it.
export async function typeText(
  cdp: CDPClient,
  sessionId: string,
  text: string
): Promise<void> {
  await cdp.send('Input.insertText', { text }, sessionId);
}

const KEY_CODES: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
};

export async function pressKey(
  cdp: CDPClient,
  sessionId: string,
  keyName: string
): Promise<void> {
  const keyInfo = KEY_CODES[keyName];
  if (!keyInfo) {
    throw new Error(`Unknown key: ${keyName}. Valid: ${Object.keys(KEY_CODES).join(', ')}`);
  }

  await cdp.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyDown',
      key: keyInfo.key,
      code: keyInfo.code,
      windowsVirtualKeyCode: keyInfo.keyCode,
      nativeVirtualKeyCode: keyInfo.keyCode,
    },
    sessionId
  );
  await cdp.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key: keyInfo.key,
      code: keyInfo.code,
      windowsVirtualKeyCode: keyInfo.keyCode,
      nativeVirtualKeyCode: keyInfo.keyCode,
    },
    sessionId
  );
}

const FOCUS_DESCENDANT_FN = `(function() {
  const selector = 'input:not([disabled]):not([type=hidden]),textarea:not([disabled]),select:not([disabled]),[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const candidates = this.querySelectorAll(selector);
  for (const el of candidates) {
    el.focus();
    if (document.activeElement === el) return true;
  }
  return false;
})`;

// `DOM.focus` only works on natively focusable elements. UIs that wrap real
// inputs in styled containers (Slack composer, Linear comments, Notion blocks,
// Canva pickers, MUI/Chakra/Mantine TextField) often expose the wrapper as the
// accessible "ref" — focusing it throws "Element is not focusable". When that
// happens, walk the subtree for the first focusable descendant.
export async function focusNode(
  cdp: CDPClient,
  sessionId: string,
  backendNodeId: number
): Promise<void> {
  try {
    await cdp.send('DOM.focus', { backendNodeId }, sessionId);
    return;
  } catch (err) {
    const focused = await focusFirstFocusableDescendant(cdp, sessionId, backendNodeId);
    if (!focused) throw err;
  }
}

async function focusFirstFocusableDescendant(
  cdp: CDPClient,
  sessionId: string,
  backendNodeId: number
): Promise<boolean> {
  const { object } = await cdp.send<{ object: { objectId?: string } }>(
    'DOM.resolveNode',
    { backendNodeId },
    sessionId
  );
  if (!object.objectId) return false;
  const objectId = object.objectId;
  try {
    const { result } = await cdp.send<{ result: { value: boolean } }>(
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: FOCUS_DESCENDANT_FN, returnByValue: true },
      sessionId
    );
    return result.value === true;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId }, sessionId);
  }
}
