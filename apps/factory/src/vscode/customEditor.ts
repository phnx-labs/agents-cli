import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { maybePromptForAgentSymlinks } from './agentlinks.vscode';
import { resolvePdfEngine, buildPdfArgs } from '../core/pdfEngine';

// Track spawned agent terminals per document URI
const documentAgents = new Map<string, vscode.Terminal>();

export class AgentsMarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new AgentsMarkdownEditorProvider(context);
    // No retainContextWhenHidden: on re-show the webview re-mounts and posts
    // { type: 'ready' } (ui/editor App.tsx), which handleMessage answers with a
    // full updateWebview(), so the document content restores without keeping a
    // backgrounded iframe alive at full CPU.
    const providerRegistration = vscode.window.registerCustomEditorProvider(
      'agents.markdownEditor',
      provider
    );
    return providerRegistration;
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    await maybePromptForAgentSymlinks(this.context, document);

    // Configure webview
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'out', 'ui', 'editor'),
        vscode.Uri.joinPath(this.context.extensionUri, 'assets'),
        vscode.Uri.file(path.dirname(document.uri.fsPath)),
      ],
    };

    // Set webview HTML content
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document);

    // Handle messages from webview
    const messageSubscription = webviewPanel.webview.onDidReceiveMessage((message) => {
      this.handleMessage(message, document, webviewPanel.webview);
    });

    // Handle document changes (external edits). Debounce so a long sequence
    // of keystrokes (TipTap re-emits per character) doesn't re-serialize the
    // entire doc and postMessage it on every keystroke.
    let updateTimer: NodeJS.Timeout | undefined;
    const scheduleUpdate = (): void => {
      if (updateTimer) return;
      updateTimer = setTimeout(() => {
        updateTimer = undefined;
        this.updateWebview(webviewPanel.webview, document);
      }, 250);
    };
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        scheduleUpdate();
      }
    });

    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      messageSubscription.dispose();
      if (updateTimer) clearTimeout(updateTimer);
    });

    // Send initial content to webview
    this.updateWebview(webviewPanel.webview, document);
  }

  private async handleMessage(
    message: any,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    switch (message.type) {
      case 'update':
        return this.updateDocument(document, message.content);

      case 'saveAsset':
        return this.saveAsset(message.data, message.fileName, document, webview);

      case 'ready':
        // Webview is ready, send initial content
        this.updateWebview(webview, document);
        break;

      case 'sendToAgent':
        return this.handleSendToAgent(message, document, webview);

      case 'sendToActiveAgent':
        return this.handleSendToActiveAgent(message, document, webview);

      case 'checkActiveAgent':
        return this.handleCheckActiveAgent(document, webview);

      case 'triggerAgent':
        return this.handleAgentTrigger(message, webview);

      case 'aiAction':
        return this.handleAIAction(message, webview);

      case 'exportPdf':
        return this.exportToPdf(message.html, document, webview);
    }
  }

  private async handleSendToAgent(
    message: any,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const { selection } = message;

    try {
      // Format message with file context
      const filePath = document.uri.fsPath;
      const contextMessage = `<context>
Source file: ${filePath}

Selected text:
${selection}
</context>

The user selected the above text from a markdown file. Help them with whatever they need regarding this content.`;

      // Import dynamically to avoid circular dependencies
      const { getBuiltInByTitle } = await import('./agents.vscode');
      const { CLAUDE_TITLE, formatTerminalTitle, getSessionChunk } = await import('../core/utils');
      const terminals = await import('./terminals.vscode');
      const { buildAgentTerminalEnv } = await import('../core/terminals');
      const { generateClaudeSessionId, buildClaudeOpenCommand } = await import('../core/prewarm.simple');
      const settingsModule = await import('./settings.vscode');

      const agentConfig = getBuiltInByTitle(this.context.extensionPath, CLAUDE_TITLE);
      if (!agentConfig) {
        vscode.window.showErrorMessage('Could not find Claude agent configuration');
        return;
      }

      // Generate session ID for Claude
      const sessionId = generateClaudeSessionId();
      const command = buildClaudeOpenCommand(sessionId);

      // Create new terminal
      const editorLocation: vscode.TerminalEditorLocationOptions = {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false
      };

      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const terminalId = terminals.nextId(agentConfig.prefix);
      const display = settingsModule.getSettings(this.context).display || {};
      const sessionChunk = display.showSessionIdInTitles ? getSessionChunk(sessionId) : null;
      const title = formatTerminalTitle(agentConfig.title, { sessionChunk });
      const terminal = vscode.window.createTerminal({
        iconPath: agentConfig.iconPath,
        location: editorLocation,
        name: title,
        env: buildAgentTerminalEnv(terminalId, sessionId, workspacePath),
        isTransient: true
      });

      const pid = await terminal.processId;
      terminals.register(terminal, terminalId, agentConfig, pid, this.context);

      // Track session ID and agent type
      terminals.setSessionId(terminal, sessionId);
      terminals.setAgentType(terminal, 'claude');

      // Queue the context message
      terminals.queueMessage(terminal, contextMessage);

      // Send Claude command with session ID
      terminal.sendText(command);

      // After delay, send queued messages (5s to ensure agent process fully loaded)
      setTimeout(() => {
        const queued = terminals.flushQueue(terminal);
        for (const msg of queued) {
          terminal.sendText(msg);
        }
      }, 5000);

      // Store terminal reference for this document
      const docUri = document.uri.toString();
      documentAgents.set(docUri, terminal);

      // Clean up when terminal is disposed. Pushed into context.subscriptions
      // so the listener is still cleared if the extension deactivates while
      // the terminal is alive — without it, we leak one listener per
      // "Send to Agent" action across reloads.
      const disposeListener = vscode.window.onDidCloseTerminal((closedTerminal) => {
        if (closedTerminal === terminal) {
          documentAgents.delete(docUri);
          webview.postMessage({ type: 'activeAgentChanged', hasActiveAgent: false });
          disposeListener.dispose();
          // Prune ourselves from the tracking array too. dispose() stops the
          // listener firing, but leaves a dead Disposable in context.subscriptions
          // forever — one accrues per "Send to Agent" click. Splice it out so the
          // array doesn't grow unbounded across the session.
          const idx = this.context.subscriptions.indexOf(disposeListener);
          if (idx !== -1) this.context.subscriptions.splice(idx, 1);
        }
      });
      this.context.subscriptions.push(disposeListener);

      webview.postMessage({
        type: 'agentResult',
        result: 'Opening new agent terminal with your selection...',
      });

      // Notify webview that we now have an active agent
      webview.postMessage({ type: 'activeAgentChanged', hasActiveAgent: true });
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to send to agent: ${error}`);
      webview.postMessage({
        type: 'agentResult',
        result: 'Failed to send to agent. Please try again.',
      });
    }
  }

  private async handleSendToActiveAgent(
    message: any,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const { selection } = message;
    const docUri = document.uri.toString();
    const terminal = documentAgents.get(docUri);

    if (!terminal) {
      webview.postMessage({
        type: 'agentResult',
        result: 'No active agent for this document. Use the colored icon to create one.',
      });
      webview.postMessage({ type: 'activeAgentChanged', hasActiveAgent: false });
      return;
    }

    try {
      // Format message with file context
      const filePath = document.uri.fsPath;
      const contextMessage = `<additional-context>
Source file: ${filePath}

Selected text:
${selection}
</additional-context>`;

      terminal.sendText(contextMessage);
      terminal.show();

      webview.postMessage({
        type: 'agentResult',
        result: 'Sent selection to active agent.',
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to send to agent: ${error}`);
      webview.postMessage({
        type: 'agentResult',
        result: 'Failed to send to agent. Please try again.',
      });
    }
  }

  private handleCheckActiveAgent(document: vscode.TextDocument, webview: vscode.Webview): void {
    const docUri = document.uri.toString();
    const hasActiveAgent = documentAgents.has(docUri);
    webview.postMessage({ type: 'activeAgentChanged', hasActiveAgent });
  }

  private async handleAgentTrigger(message: any, webview: vscode.Webview): Promise<void> {
    const { action, topic } = message;

    try {
      let result = '';

      if (action === 'ask') {
        // Trigger new agent with input prompt
        const input = await vscode.window.showInputBox({
          prompt: 'What would you like to ask the agent?',
          placeHolder: 'Enter your question...',
        });

        if (input) {
          await vscode.env.clipboard.writeText(input);
          await vscode.commands.executeCommand('agents.newTask');
          result = 'Opening agent with your question...';
        }
      } else if (action === 'research') {
        if (topic) {
          await vscode.env.clipboard.writeText(`Research: ${topic}`);
          await vscode.commands.executeCommand('agents.newTask');
          result = `Researching: ${topic}...`;
        }
      }

      webview.postMessage({
        type: 'agentResult',
        result,
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Agent error: ${error}`);
      webview.postMessage({
        type: 'agentResult',
        result: 'Agent failed to respond. Please try again.',
      });
    }
  }

  private async handleAIAction(message: any, webview: vscode.Webview): Promise<void> {
    const { action, selection, topic } = message;

    try {
      let result = '';
      let prompt = '';

      // Build prompt based on action
      switch (action) {
        case 'write':
          prompt = `Write content about: ${topic}`;
          break;
        case 'continue':
          prompt = 'Continue writing from where I left off';
          break;
        case 'improve':
          prompt = `Improve this text: ${selection}`;
          break;
        case 'expand':
          prompt = `Expand on this idea: ${selection}`;
          break;
        case 'summarize':
          prompt = `Summarize this text: ${selection}`;
          break;
        case 'fix':
          prompt = `Fix grammar and spelling in: ${selection}`;
          break;
        default:
          prompt = selection || '';
      }

      // Copy prompt to clipboard and notify user
      await vscode.env.clipboard.writeText(prompt);
      result = `Prompt copied to clipboard. Paste it into an agent to get AI response.`;

      webview.postMessage({
        type: 'aiResult',
        action,
        result,
      });
    } catch (error) {
      vscode.window.showErrorMessage(`AI action error: ${error}`);
      webview.postMessage({
        type: 'aiResult',
        action,
        result: 'AI action failed. Please try again.',
      });
    }
  }

  private async updateDocument(document: vscode.TextDocument, content: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      content
    );
    await vscode.workspace.applyEdit(edit);
  }

  private async saveAsset(
    data: string,
    fileName: string,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('agents');
    const assetFolder = config.get('editor.assetFolder', '.assets');

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    const assetDir = path.join(workspaceFolder.uri.fsPath, assetFolder);

    // Create asset directory if it doesn't exist
    if (!fs.existsSync(assetDir)) {
      fs.mkdirSync(assetDir, { recursive: true });
    }

    // Generate unique filename if file already exists
    let uniqueFileName = fileName;
    let counter = 1;
    while (fs.existsSync(path.join(assetDir, uniqueFileName))) {
      const ext = path.extname(fileName);
      const base = path.basename(fileName, ext);
      uniqueFileName = `${base}-${counter}${ext}`;
      counter++;
    }

    const assetPath = path.join(assetDir, uniqueFileName);

    // Save the file
    const buffer = Buffer.from(data.split(',')[1], 'base64');
    fs.writeFileSync(assetPath, buffer);

    // Send back the relative path
    const relativePath = path.join(assetFolder, uniqueFileName);
    webview.postMessage({
      type: 'assetSaved',
      path: relativePath,
    });
  }

  private async exportToPdf(
    bodyHtml: string,
    document: vscode.TextDocument,
    webview: vscode.Webview,
  ): Promise<void> {
    const engine = resolvePdfEngine();
    if (!engine) {
      webview.postMessage({
        type: 'exportPdfError',
        reason: 'No PDF engine found. Install Google Chrome or Prince.',
      });
      return;
    }

    const baseName = path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }

    let pdfName = `${baseName}.pdf`;
    let counter = 1;
    while (fs.existsSync(path.join(downloadsDir, pdfName))) {
      pdfName = `${baseName}-${counter}.pdf`;
      counter++;
    }
    const pdfPath = path.join(downloadsDir, pdfName);

    const tmpHtml = path.join(os.tmpdir(), `agents-md-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`);
    fs.writeFileSync(tmpHtml, this.wrapHtmlForPrint(bodyHtml, baseName));

    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          engine.binary,
          buildPdfArgs(engine, tmpHtml, pdfPath),
          { timeout: 60_000 },
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });

      if (!fs.existsSync(pdfPath)) {
        throw new Error('PDF was not produced');
      }

      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(pdfPath));
      webview.postMessage({ type: 'exportPdfDone', path: pdfPath });
    } catch (err) {
      webview.postMessage({
        type: 'exportPdfError',
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      try { fs.unlinkSync(tmpHtml); } catch { /* ignore */ }
    }
  }

  private wrapHtmlForPrint(bodyHtml: string, title: string): string {
    const safeTitle = title.replace(/[<>&"]/g, '');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${safeTitle}</title>
<style>
@page { size: A4; margin: 1in; }
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  font-size: 12pt;
  line-height: 1.6;
  color: #1a1a1a;
  background: #fff;
  margin: 0;
}
h1 { font-size: 24pt; margin: 24pt 0 12pt; page-break-after: avoid; }
h2 { font-size: 18pt; margin: 20pt 0 10pt; page-break-after: avoid; }
h3 { font-size: 14pt; margin: 16pt 0 8pt; page-break-after: avoid; }
p { margin: 0 0 10pt; }
ul, ol { margin: 0 0 10pt 24pt; }
li { margin-bottom: 4pt; }
code {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 10pt;
  background: #f4f4f4;
  padding: 1pt 4pt;
  border-radius: 3pt;
}
pre {
  background: #f4f4f4;
  padding: 12pt;
  border-radius: 4pt;
  overflow-x: auto;
  page-break-inside: avoid;
  margin: 0 0 12pt;
}
pre code { background: none; padding: 0; font-size: 9.5pt; line-height: 1.5; }
blockquote {
  border-left: 3pt solid #ddd;
  margin: 0 0 12pt;
  padding: 0 12pt;
  color: #555;
}
table {
  border-collapse: collapse;
  width: 100%;
  margin: 0 0 12pt;
  page-break-inside: avoid;
}
th, td { border: 1pt solid #ccc; padding: 6pt 10pt; text-align: left; }
th { background: #f4f4f4; }
img { max-width: 100%; height: auto; }
a { color: #0366d6; text-decoration: none; }
hr { border: none; border-top: 1pt solid #ddd; margin: 16pt 0; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
  }

  private updateWebview(webview: vscode.Webview, document: vscode.TextDocument): void {
    webview.postMessage({
      type: 'update',
      content: document.getText(),
    });
  }

  private getHtmlForWebview(webview: vscode.Webview, document: vscode.TextDocument): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'ui', 'editor', 'assets', 'index.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'ui', 'editor', 'assets', 'index.css')
    );
    const agentsIconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'agents.png')
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    img-src ${webview.cspSource} https: data:;
    font-src ${webview.cspSource};
    connect-src https:;">
  <link href="${styleUri}" rel="stylesheet">
  <title>Agents Markdown Editor</title>
</head>
<body>
  <div id="root" data-agents-icon="${agentsIconUri}"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/**
 * Swarm the current document - opens a new Claude terminal and runs /swarm with the document content
 */
export async function swarmCurrentDocument(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  // Check if we have an active markdown document
  if (!editor) {
    // Try to get content from active custom editor
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (activeTab?.input instanceof vscode.TabInputCustom) {
      // We're in a custom editor - get the document content via URI
      const docUri = activeTab.input.uri;
      if (docUri.fsPath.endsWith('.md')) {
        try {
          const doc = await vscode.workspace.openTextDocument(docUri);
          const content = doc.getText();
          await sendSwarmCommand(content, context);
          return;
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to read document: ${error}`);
          return;
        }
      }
    }
    vscode.window.showWarningMessage('Open a markdown file to swarm');
    return;
  }

  if (!editor.document.fileName.endsWith('.md')) {
    vscode.window.showWarningMessage('Open a markdown file to swarm');
    return;
  }

  const content = editor.document.getText();
  await sendSwarmCommand(content, context);
}

async function sendSwarmCommand(content: string, context: vscode.ExtensionContext): Promise<void> {
  const message = `/swarm ${content}`;

  // Import dynamically to avoid circular dependencies
  const { getBuiltInByTitle } = await import('./agents.vscode');
  const { CLAUDE_TITLE, formatTerminalTitle, getSessionChunk } = await import('../core/utils');
  const terminals = await import('./terminals.vscode');
  const { buildAgentTerminalEnv } = await import('../core/terminals');
  const { generateClaudeSessionId, buildClaudeOpenCommand } = await import('../core/prewarm.simple');
  const settingsModule = await import('./settings.vscode');

  const agentConfig = getBuiltInByTitle(context.extensionPath, CLAUDE_TITLE);
  if (!agentConfig) {
    vscode.window.showErrorMessage('Could not find Claude agent configuration');
    return;
  }

  // Generate session ID for Claude
  const sessionId = generateClaudeSessionId();
  const command = buildClaudeOpenCommand(sessionId);

  // Create new terminal
  const editorLocation: vscode.TerminalEditorLocationOptions = {
    viewColumn: vscode.ViewColumn.Active,
    preserveFocus: false
  };

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const terminalId = terminals.nextId(agentConfig.prefix);
  const display = settingsModule.getSettings(context).display || {};
  const sessionChunk = display.showSessionIdInTitles ? getSessionChunk(sessionId) : null;
  const title = formatTerminalTitle(agentConfig.title, { sessionChunk });
  const terminal = vscode.window.createTerminal({
    iconPath: agentConfig.iconPath,
    location: editorLocation,
    name: title,
    env: buildAgentTerminalEnv(terminalId, sessionId, workspacePath),
    isTransient: true
  });

  const pid = await terminal.processId;
  terminals.register(terminal, terminalId, agentConfig, pid, context);

  // Track session ID and agent type
  terminals.setSessionId(terminal, sessionId);
  terminals.setAgentType(terminal, 'claude');

  // Queue the swarm message
  terminals.queueMessage(terminal, message);

  // Send Claude command with session ID
  terminal.sendText(command);

  // After delay, send queued messages (5s to ensure agent process fully loaded)
  setTimeout(() => {
    const queued = terminals.flushQueue(terminal);
    for (const msg of queued) {
      terminal.sendText(msg);
    }
  }, 5000);

  vscode.window.showInformationMessage('Swarming document with Claude...');
}
