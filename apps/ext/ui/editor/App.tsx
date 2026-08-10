import { useEffect, useState } from 'react';
import Editor from './components/Editor';
import Outline from './components/Outline';
import FrontmatterPanel from './components/FrontmatterPanel';
import Toolbar from './components/Toolbar';
import { Editor as TiptapEditor } from '@tiptap/core';
import { getVsCodeApi } from './vscodeApi';

// Acquire the single webview API handle once; the Tiptap extensions share it
// via getVsCodeApi() rather than re-calling the one-shot acquireVsCodeApi().
const vscode = getVsCodeApi()!;

function App() {
  const [content, setContent] = useState<string>('');
  const [isReady, setIsReady] = useState(false);
  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const [hasActiveAgent, setHasActiveAgent] = useState(false);
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>({});
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    // Handle messages from extension
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      switch (message.type) {
        case 'update':
          setContent(message.content);
          setIsReady(true);
          break;
        case 'assetSaved':
          console.log('Asset saved:', message.path);
          break;
        case 'agentResult':
          console.log('Agent Result:', message.result);
          break;
        case 'activeAgentChanged':
          setHasActiveAgent(message.hasActiveAgent);
          break;
        case 'exportPdfDone':
          setExporting(false);
          setExportError(null);
          break;
        case 'exportPdfError':
          setExporting(false);
          setExportError(message.reason || 'PDF export failed');
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    vscode.postMessage({ type: 'ready' });
    // Check if there's already an active agent for this document
    vscode.postMessage({ type: 'checkActiveAgent' });

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  const handleContentChange = (newContent: string) => {
    setContent(newContent);
    vscode.postMessage({
      type: 'update',
      content: newContent,
    });
  };

  const handleSaveAsset = (data: string, fileName: string) => {
    vscode.postMessage({
      type: 'saveAsset',
      data,
      fileName,
    });
  };

  const handleSendToAgent = (selection: string) => {
    vscode.postMessage({
      type: 'sendToAgent',
      selection,
    });
  };

  const handleSendToActiveAgent = (selection: string) => {
    vscode.postMessage({
      type: 'sendToActiveAgent',
      selection,
    });
  };

  const handleFrontmatterParsed = (data: Record<string, unknown>) => {
    setFrontmatter(data);
  };

  const handleExportPdf = () => {
    if (!editor) return;
    setExporting(true);
    setExportError(null);
    vscode.postMessage({
      type: 'exportPdf',
      html: editor.getHTML(),
    });
  };

  if (!isReady) {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        fontSize: '14px',
        color: 'var(--vscode-foreground)'
      }}>
        Loading editor...
      </div>
    );
  }

  return (
    <div className="editor-layout">
      <Outline editor={editor} />
      <div className="editor-main">
        <Toolbar
          onExportPdf={handleExportPdf}
          exporting={exporting}
          exportError={exportError}
        />
        <FrontmatterPanel data={frontmatter} />
        <Editor
          initialContent={content}
          onChange={handleContentChange}
          onSaveAsset={handleSaveAsset}
          onSendToAgent={handleSendToAgent}
          onSendToActiveAgent={handleSendToActiveAgent}
          hasActiveAgent={hasActiveAgent}
          onEditorReady={setEditor}
          onFrontmatterParsed={handleFrontmatterParsed}
        />
      </div>
    </div>
  );
}

export default App;
