import { describe, expect, test } from 'bun:test';
import { buildEditorWebviewHtml } from './editorHtml';

describe('buildEditorWebviewHtml', () => {
  const html = buildEditorWebviewHtml({
    scriptUri: 'webview-uri:/ext/out/ui/editor/assets/index.js',
    styleUri: 'webview-uri:/ext/out/ui/editor/assets/index.css',
    agentsIconUri: 'webview-uri:/ext/assets/agents.png',
    cspSource: 'vscode-resource:',
    nonce: 'testnonce',
  });

  test('loads the editor bundle as an ES module', () => {
    // The Vite editor bundle is ESM: it carries top-level const bindings
    // (prosemirror-view declares `const chrome = ...` for browser sniffing).
    // Loaded as a classic script, that redeclares the webview's global
    // `chrome` binding and throws "Identifier 'chrome' has already been
    // declared" before React mounts — the reader renders a blank pane.
    const scriptTag = html.match(/<script[^>]*src="[^"]*index\.js"[^>]*>/)?.[0];
    expect(scriptTag).toBeDefined();
    expect(scriptTag).toContain('type="module"');
    expect(scriptTag).toContain('nonce="testnonce"');
  });

  test('CSP still restricts scripts to the nonce', () => {
    expect(html).toContain("script-src 'nonce-testnonce'");
    expect(html).toContain("default-src 'none'");
  });
});
