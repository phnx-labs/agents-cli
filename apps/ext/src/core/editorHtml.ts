/**
 * HTML shell for the markdown reader webview (agents.markdownEditor).
 *
 * The script tag MUST carry type="module": the Vite editor bundle is ESM and
 * declares top-level const bindings (prosemirror-view's `chrome` browser
 * sniff). Loaded as a classic script, those land in the webview's global
 * scope, collide with the built-in `chrome` binding, and throw
 * "Identifier 'chrome' has already been declared" before React mounts —
 * the reader renders a blank pane.
 */
export interface EditorWebviewHtmlParts {
  scriptUri: string;
  styleUri: string;
  agentsIconUri: string;
  cspSource: string;
  nonce: string;
}

export function buildEditorWebviewHtml(parts: EditorWebviewHtmlParts): string {
  const { scriptUri, styleUri, agentsIconUri, cspSource, nonce } = parts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none';
    style-src ${cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    img-src ${cspSource} https: data:;
    media-src data:;
    font-src ${cspSource};
    connect-src https:;">
  <link href="${styleUri}" rel="stylesheet">
  <title>Agents Markdown Editor</title>
</head>
<body>
  <div id="root" data-agents-icon="${agentsIconUri}"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
