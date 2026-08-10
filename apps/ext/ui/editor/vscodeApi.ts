/**
 * Single cached handle to the VS Code webview API for the markdown editor.
 *
 * `acquireVsCodeApi()` may be called only ONCE per webview load — VS Code
 * removes it after the first call, so a second call throws / yields undefined.
 * `App.tsx` and the Tiptap extensions (`KeyboardShortcuts`, `SlashCommands`)
 * all live in the same editor webview, so they must share this one acquisition
 * instead of each calling `acquireVsCodeApi()` — which is why the shortcut and
 * slash-command "send to agent" actions were silently no-op'ing (they
 * re-acquired after App.tsx had already consumed the one-shot handle).
 */

export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T = unknown>(state: T): void;
}

declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;

let cached: VsCodeApi | undefined;

/**
 * Returns the editor webview's VS Code API handle, acquiring it at most once.
 * Every subsequent call returns the same cached instance. Returns `undefined`
 * only when running outside a VS Code webview (e.g. a plain-browser harness),
 * so callers that may run there keep guarding with `if (vscode)`.
 */
export function getVsCodeApi(): VsCodeApi | undefined {
  if (cached) return cached;
  if (typeof acquireVsCodeApi === 'function') {
    cached = acquireVsCodeApi();
  }
  return cached;
}
