import { describe, expect, it } from 'bun:test';
import { isAllowedExternalUrl, isAllowedWebviewCommand } from './webviewSecurity';

describe('isAllowedExternalUrl', () => {
  it('allows the web + mail schemes the UI uses', () => {
    expect(isAllowedExternalUrl('https://github.com/muqsitnawaz/agents-cli/pull/1')).toBe(true);
    expect(isAllowedExternalUrl('http://localhost:5173/')).toBe(true);
    expect(isAllowedExternalUrl('mailto:muqsit@trp.so')).toBe(true);
  });

  it('blocks schemes that turn openExternal into a local-exec / disclosure sink', () => {
    // These are the payloads a hostile webview message would carry.
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('command:workbench.action.terminal.sendSequence')).toBe(false);
    expect(isAllowedExternalUrl('vscode://ms-vscode.js-debug/foo')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects empty / non-string / unparseable input', () => {
    expect(isAllowedExternalUrl('')).toBe(false);
    expect(isAllowedExternalUrl(undefined)).toBe(false);
    expect(isAllowedExternalUrl(null)).toBe(false);
    expect(isAllowedExternalUrl(42)).toBe(false);
    expect(isAllowedExternalUrl('not a url')).toBe(false);
  });
});

describe('isAllowedWebviewCommand', () => {
  it('allows exactly the commands the dashboard dispatches', () => {
    expect(isAllowedWebviewCommand('workbench.action.toggleLightDarkThemes')).toBe(true);
    expect(isAllowedWebviewCommand('agents.newClaude')).toBe(true);
    expect(isAllowedWebviewCommand('agents.newCodex')).toBe(true);
    expect(isAllowedWebviewCommand('agents.newDroid')).toBe(true);
  });

  it('blocks arbitrary VS Code commands', () => {
    expect(isAllowedWebviewCommand('workbench.action.terminal.sendSequence')).toBe(false);
    expect(isAllowedWebviewCommand('agents.deleteEverything')).toBe(false);
    expect(isAllowedWebviewCommand('workbench.action.tasks.runTask')).toBe(false);
    expect(isAllowedWebviewCommand('')).toBe(false);
  });
});
