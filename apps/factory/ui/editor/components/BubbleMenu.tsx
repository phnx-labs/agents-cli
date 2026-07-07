import { BubbleMenu as TiptapBubbleMenu } from '@tiptap/react';
import { Editor } from '@tiptap/core';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link as LinkIcon,
  Highlighter,
} from 'lucide-react';

interface BubbleMenuProps {
  editor: Editor;
  onSendToAgent: (selection: string) => void;
  onSendToActiveAgent: (selection: string) => void;
  hasActiveAgent: boolean;
}

// Get agents icon URI from data attribute set by extension
const getAgentsIconUri = (): string | null => {
  const root = document.getElementById('root');
  return root?.dataset.agentsIcon || null;
};

function BubbleMenu({ editor, onSendToAgent, onSendToActiveAgent, hasActiveAgent }: BubbleMenuProps) {
  const agentsIconUri = getAgentsIconUri();

  const setLink = () => {
    const previousUrl = editor.getAttributes('link').href;
    const url = window.prompt('URL', previousUrl);

    if (url === null) {
      return;
    }

    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const handleSendToAgent = () => {
    const { from, to } = editor.state.selection;
    const selection = editor.state.doc.textBetween(from, to, ' ');
    if (selection) {
      onSendToAgent(selection);
    }
  };

  const handleSendToActiveAgent = () => {
    const { from, to } = editor.state.selection;
    const selection = editor.state.doc.textBetween(from, to, ' ');
    if (selection) {
      onSendToActiveAgent(selection);
    }
  };

  return (
    <TiptapBubbleMenu
      editor={editor}
      tippyOptions={{ duration: 100 }}
      className="bubble-menu"
    >
      <button
        onClick={() => editor.chain().focus().toggleBold().run()}
        className={editor.isActive('bold') ? 'is-active' : ''}
        title="Bold"
      >
        <Bold size={16} />
      </button>

      <button
        onClick={() => editor.chain().focus().toggleItalic().run()}
        className={editor.isActive('italic') ? 'is-active' : ''}
        title="Italic"
      >
        <Italic size={16} />
      </button>

      <button
        onClick={() => editor.chain().focus().toggleStrike().run()}
        className={editor.isActive('strike') ? 'is-active' : ''}
        title="Strikethrough"
      >
        <Strikethrough size={16} />
      </button>

      <button
        onClick={() => editor.chain().focus().toggleCode().run()}
        className={editor.isActive('code') ? 'is-active' : ''}
        title="Code"
      >
        <Code size={16} />
      </button>

      <div className="separator" />

      <button
        onClick={setLink}
        className={editor.isActive('link') ? 'is-active' : ''}
        title="Link"
      >
        <LinkIcon size={16} />
      </button>

      <button
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        className={editor.isActive('highlight') ? 'is-active' : ''}
        title="Highlight"
      >
        <Highlighter size={16} />
      </button>

      <div className="separator" />

      {hasActiveAgent && (
        <button
          onClick={handleSendToActiveAgent}
          className="agents-button agents-button-active"
          title="Send to active agent"
        >
          {agentsIconUri ? (
            <img
              src={agentsIconUri}
              alt="Send to active agent"
              width={16}
              height={16}
              style={{ filter: 'grayscale(100%)' }}
            />
          ) : (
            <span>A</span>
          )}
        </button>
      )}

      <button
        onClick={handleSendToAgent}
        className="agents-button"
        title="Open new agent with selection"
      >
        {agentsIconUri ? (
          <img src={agentsIconUri} alt="New agent" width={16} height={16} />
        ) : (
          <span>A</span>
        )}
      </button>
    </TiptapBubbleMenu>
  );
}

export default BubbleMenu;
