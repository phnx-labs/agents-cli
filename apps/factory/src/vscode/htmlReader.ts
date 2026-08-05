import * as vscode from 'vscode';
import * as path from 'path';
import { AGENTS_HTML_READER } from '../core/editorAssociations';

/**
 * Agents HTML Reader — sandboxed preview for self-contained HTML (artifacts-cli
 * plans/reports and similar). Not a source editor: it renders the document.
 */
export class AgentsHtmlReaderProvider implements vscode.CustomTextEditorProvider {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new AgentsHtmlReaderProvider(context);
    return vscode.window.registerCustomEditorProvider(AGENTS_HTML_READER, provider, {
      webviewOptions: {
        // Artifacts often load relative CSS/images next to the file; keep the
        // webview alive is not required — re-show rebuilds from the document.
        retainContextWhenHidden: false,
      },
    });
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.dirname(document.uri.fsPath)),
        vscode.Uri.joinPath(this.context.extensionUri, 'assets'),
      ],
    };

    const render = (): void => {
      webviewPanel.webview.html = this.buildHtml(webviewPanel.webview, document);
    };
    render();

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        render();
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
    });
  }

  /**
   * Host page: full-bleed iframe with the document as srcdoc so the artifact's
   * own CSS/JS run in an isolated document (and relative assets are rewritten
   * to webview URIs when possible).
   */
  private buildHtml(webview: vscode.Webview, document: vscode.TextDocument): string {
    const nonce = getNonce();
    const docDir = path.dirname(document.uri.fsPath);
    const rewritten = rewriteRelativeResources(document.getText(), docDir, webview);
    // Escape for embedding as a JS template string assigned to srcdoc.
    const escaped = rewritten
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\$\{/g, '\\${');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    frame-src 'none';
    img-src ${webview.cspSource} https: data: blob:;
    font-src ${webview.cspSource} data:;
    media-src ${webview.cspSource} data: blob:;
    connect-src ${webview.cspSource} https:;">
  <title>Agents HTML Reader</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: var(--vscode-editor-background, #0a0a0a); }
    iframe {
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      background: #fff;
    }
  </style>
</head>
<body>
  <iframe id="artifact" title="HTML preview" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>
  <script nonce="${nonce}">
    const frame = document.getElementById('artifact');
    frame.srcdoc = \`${escaped}\`;
  </script>
</body>
</html>`;
  }
}

/**
 * Rewrite relative src/href (not http(s), data, #, mailto, vscode) to webview
 * URIs rooted at the document directory so sibling assets load in the preview.
 */
export function rewriteRelativeResources(
  html: string,
  docDir: string,
  webview: Pick<vscode.Webview, 'asWebviewUri'>
): string {
  return html.replace(
    /\b(src|href)=(["'])(?!https?:|data:|blob:|#|mailto:|vscode-webview:|vscode-file:|file:)([^"']+)\2/gi,
    (_match, attr: string, quote: string, rel: string) => {
      // Skip pure anchors / empty
      if (!rel || rel.startsWith('//')) return `${attr}=${quote}${rel}${quote}`;
      try {
        const abs = path.resolve(docDir, rel);
        const uri = webview.asWebviewUri(vscode.Uri.file(abs));
        return `${attr}=${quote}${uri.toString()}${quote}`;
      } catch {
        return `${attr}=${quote}${rel}${quote}`;
      }
    }
  );
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
