import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Highlight from '@tiptap/extension-highlight';
import Typography from '@tiptap/extension-typography';
import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import Youtube from '@tiptap/extension-youtube';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import { useEffect, useRef } from 'react';
import { Markdown } from 'tiptap-markdown';
import { Editor as TiptapEditor } from '@tiptap/core';
import BubbleMenu from './BubbleMenu';
import SlashCommands from '../extensions/SlashCommands';
import Callout from '../extensions/Callout';
import Toggle from '../extensions/Toggle';
import VideoBlock from '../extensions/VideoBlock';
import FileAttachment from '../extensions/FileAttachment';
import KeyboardShortcuts from '../extensions/KeyboardShortcuts';
import { parseFrontmatter, reattachFrontmatter } from '../frontmatter';

const lowlight = createLowlight(common);

interface EditorProps {
  initialContent: string;
  onChange: (content: string) => void;
  onSaveAsset: (data: string, fileName: string) => void;
  onSendToAgent: (selection: string) => void;
  onSendToActiveAgent: (selection: string) => void;
  hasActiveAgent: boolean;
  onEditorReady: (editor: TiptapEditor) => void;
  onFrontmatterParsed?: (data: Record<string, unknown>, hasFrontmatter: boolean) => void;
}

function Editor({ initialContent, onChange, onSaveAsset, onSendToAgent, onSendToActiveAgent, hasActiveAgent, onEditorReady, onFrontmatterParsed }: EditorProps) {
  const isUpdatingRef = useRef(false);
  const frontmatterRef = useRef<{ data: Record<string, unknown>; hasFrontmatter: boolean }>({ data: {}, hasFrontmatter: false });

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          codeBlock: false, // Using CodeBlockLowlight instead
        }),
        Markdown.configure({
          html: true,
          transformPastedText: true,
          transformCopiedText: true,
        }),
        Image.configure({
          inline: true,
          allowBase64: true,
          HTMLAttributes: {
            class: 'notion-image',
          },
        }),
        Link.configure({
          openOnClick: false,
          HTMLAttributes: {
            class: 'notion-link',
          },
        }),
        Table.configure({
          resizable: true,
          HTMLAttributes: {
            class: 'notion-table',
          },
        }),
        TableRow,
        TableCell,
        TableHeader,
        TaskList.configure({
          HTMLAttributes: {
            class: 'notion-task-list',
          },
        }),
        TaskItem.configure({
          nested: true,
          HTMLAttributes: {
            class: 'notion-task-item',
          },
        }),
        Highlight.configure({
          multicolor: true,
        }),
        Typography,
        Placeholder.configure({
          placeholder: ({ node }) => {
            if (node.type.name === 'heading') {
              return 'Heading';
            }
            return "Type '/' for commands...";
          },
        }),
        TextAlign.configure({
          types: ['heading', 'paragraph'],
        }),
        Youtube.configure({
          width: 640,
          height: 360,
          HTMLAttributes: {
            class: 'notion-youtube',
          },
        }),
        CodeBlockLowlight.configure({
          lowlight,
          HTMLAttributes: {
            class: 'notion-code-block',
          },
        }),
        SlashCommands,
        Callout,
        Toggle,
        VideoBlock.configure({
          onSaveAsset,
        }),
        FileAttachment.configure({
          onSaveAsset,
        }),
        KeyboardShortcuts,
      ],
      content: '',
      editorProps: {
        attributes: {
          class: 'notion-editor',
        },
        handlePaste: (view, event) => {
          // Handle image paste from clipboard
          const items = Array.from(event.clipboardData?.items || []);
          for (const item of items) {
            if (item.type.indexOf('image') === 0) {
              event.preventDefault();
              const file = item.getAsFile();
              if (file) {
                handleImageUpload(file);
              }
              return true;
            }
          }
          return false;
        },
        handleDrop: (view, event) => {
          // Handle drag and drop for images and files
          const files = Array.from(event.dataTransfer?.files || []);
          if (files.length > 0) {
            event.preventDefault();
            files.forEach((file) => {
              if (file.type.startsWith('image/')) {
                handleImageUpload(file);
              } else if (file.type.startsWith('video/')) {
                handleVideoUpload(file);
              } else {
                handleFileUpload(file);
              }
            });
            return true;
          }
          return false;
        },
      },
      onCreate: ({ editor }) => {
        onEditorReady(editor);
      },
      onUpdate: ({ editor }) => {
        if (!isUpdatingRef.current) {
          const body = editor.storage.markdown.getMarkdown();
          const fm = frontmatterRef.current;
          const merged = reattachFrontmatter(fm.data, body, fm.hasFrontmatter);
          onChange(merged);
        }
      },
    });

    // Update editor when content changes externally
    useEffect(() => {
      if (editor && initialContent !== undefined) {
        const parsed = parseFrontmatter(initialContent);
        const prev = frontmatterRef.current;
        const fmChanged =
          prev.hasFrontmatter !== parsed.hasFrontmatter ||
          JSON.stringify(prev.data) !== JSON.stringify(parsed.data);
        frontmatterRef.current = { data: parsed.data, hasFrontmatter: parsed.hasFrontmatter };
        if (fmChanged) {
          onFrontmatterParsed?.(parsed.data, parsed.hasFrontmatter);
        }
        const currentMarkdown = editor.storage.markdown.getMarkdown();
        if (currentMarkdown !== parsed.body) {
          isUpdatingRef.current = true;
          editor.commands.setContent(parsed.body);
          isUpdatingRef.current = false;
        }
      }
    }, [initialContent, editor]);

    const handleImageUpload = (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = e.target?.result as string;
        const fileName = `image-${Date.now()}.${file.name.split('.').pop()}`;

        // Insert image immediately with base64
        editor?.chain().focus().setImage({ src: data }).run();

        // Save to workspace and update src later
        onSaveAsset(data, fileName);
      };
      reader.readAsDataURL(file);
    };

    const handleVideoUpload = (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = e.target?.result as string;
        const fileName = `video-${Date.now()}.${file.name.split('.').pop()}`;

        // Insert video block
        editor?.chain().focus().insertContent({
          type: 'videoBlock',
          attrs: { src: data },
        }).run();

        // Save to workspace
        onSaveAsset(data, fileName);
      };
      reader.readAsDataURL(file);
    };

    const handleFileUpload = (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = e.target?.result as string;
        const fileName = `file-${Date.now()}-${file.name}`;

        // Insert file attachment
        editor?.chain().focus().insertContent({
          type: 'fileAttachment',
          attrs: {
            fileName: file.name,
            fileSize: file.size,
            src: data,
          },
        }).run();

        // Save to workspace
        onSaveAsset(data, fileName);
      };
      reader.readAsDataURL(file);
    };

    if (!editor) {
      return null;
    }

  return (
    <div className="editor-container">
      <BubbleMenu
        editor={editor}
        onSendToAgent={onSendToAgent}
        onSendToActiveAgent={onSendToActiveAgent}
        hasActiveAgent={hasActiveAgent}
      />
      <EditorContent editor={editor} />
    </div>
  );
}

export default Editor;
