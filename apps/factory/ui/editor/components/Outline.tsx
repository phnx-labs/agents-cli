import { useEffect, useState } from 'react';
import { Editor } from '@tiptap/core';

interface OutlineItem {
  id: string;
  level: number;
  text: string;
  pos: number;
}

interface OutlineProps {
  editor: Editor | null;
}

function Outline({ editor }: OutlineProps) {
  const [items, setItems] = useState<OutlineItem[]>([]);

  useEffect(() => {
    if (!editor) return;

    const updateOutline = () => {
      const headings: OutlineItem[] = [];
      const doc = editor.state.doc;

      doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          const level = node.attrs.level as number;
          const text = node.textContent;
          const id = `heading-${pos}`;
          headings.push({ id, level, text, pos });
        }
      });

      setItems(headings);
    };

    // Initial update
    updateOutline();

    // Listen for changes (transaction fires on ALL changes, including programmatic setContent)
    editor.on('transaction', updateOutline);

    return () => {
      editor.off('transaction', updateOutline);
    };
  }, [editor]);

  const scrollToHeading = (pos: number) => {
    if (!editor) return;

    editor.commands.setTextSelection(pos);
    editor.commands.scrollIntoView();

    // Focus the editor after scrolling
    editor.commands.focus();
  };

  if (!editor) {
    return null;
  }

  return (
    <div className="outline-sidebar">
      <div className="outline-title">Outline</div>
      {items.length > 0 ? (
        <ul className="outline-list">
          {items.map((item) => (
            <li
              key={item.id}
              className={`outline-item level-${item.level}`}
              onClick={() => scrollToHeading(item.pos)}
              title={item.text}
            >
              {item.text || 'Untitled'}
            </li>
          ))}
        </ul>
      ) : (
        <div className="outline-empty">
          No headings yet. Add headings to see the outline.
        </div>
      )}
    </div>
  );
}

export default Outline;
