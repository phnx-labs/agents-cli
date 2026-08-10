import { test, expect, beforeAll } from 'bun:test';

// Simulate the VS Code webview contract: `acquireVsCodeApi()` may be called
// only ONCE per load — a second call throws. This is exactly what broke the
// editor before the fix: App.tsx acquired the handle, then KeyboardShortcuts /
// SlashCommands each re-called acquireVsCodeApi(), which threw / yielded
// undefined, so "send to agent" silently no-op'd.
let acquireCalls = 0;
const realApi = {
  postMessage(_m: unknown) {},
  getState() {
    return undefined;
  },
  setState(_s: unknown) {},
};

beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => {
    acquireCalls += 1;
    if (acquireCalls > 1) {
      throw new Error('An instance of the VS Code API has already been acquired');
    }
    return realApi;
  };
});

test('acquires the underlying VS Code API exactly once across many consumers', async () => {
  const { getVsCodeApi } = await import('./vscodeApi');
  const a = getVsCodeApi(); // App.tsx
  const b = getVsCodeApi(); // KeyboardShortcuts
  const c = getVsCodeApi(); // SlashCommands
  // The bug: any consumer after the first re-acquired and threw. The singleton
  // guarantees exactly one underlying acquisition, shared by all.
  expect(acquireCalls).toBe(1);
  expect(a).toBe(realApi);
  expect(b).toBe(a);
  expect(c).toBe(a);
});

test('the shared handle can post messages (send-to-agent path is live)', async () => {
  const { getVsCodeApi } = await import('./vscodeApi');
  const sent: unknown[] = [];
  realApi.postMessage = (m: unknown) => {
    sent.push(m);
  };
  const vscode = getVsCodeApi();
  vscode?.postMessage({ type: 'sendToAgent', selection: 'hello' });
  expect(acquireCalls).toBe(1); // still no re-acquire
  expect(sent).toEqual([{ type: 'sendToAgent', selection: 'hello' }]);
});
