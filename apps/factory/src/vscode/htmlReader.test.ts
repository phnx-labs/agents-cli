import { describe, expect, mock, test } from 'bun:test';
import * as path from 'path';

mock.module('vscode', () => ({
  Uri: {
    file: (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => `file://${fsPath}` }),
  },
  window: {
    registerCustomEditorProvider: () => ({ dispose: () => {} }),
  },
  workspace: {
    onDidChangeTextDocument: () => ({ dispose: () => {} }),
  },
}));

const { rewriteRelativeResources } = await import('./htmlReader');

describe('rewriteRelativeResources', () => {
  const docDir = '/tmp/artifacts/plans';
  const webview = {
    asWebviewUri: (uri: { fsPath: string }) => ({
      toString: () => `webview-uri://${uri.fsPath}`,
    }),
  };

  test('rewrites relative src and href to webview URIs', () => {
    const html = `<img src="./cover.png"><link href="style.css" rel="stylesheet">`;
    const out = rewriteRelativeResources(html, docDir, webview as any);
    expect(out).toContain(`src="webview-uri://${path.resolve(docDir, './cover.png')}"`);
    expect(out).toContain(`href="webview-uri://${path.resolve(docDir, 'style.css')}"`);
  });

  test('leaves absolute and data URLs alone', () => {
    const html = `<img src="https://example.com/a.png"><img src="data:image/png;base64,aa"><a href="#toc">`;
    const out = rewriteRelativeResources(html, docDir, webview as any);
    expect(out).toBe(html);
  });
});
